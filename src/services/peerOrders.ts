/**
 * peerOrders.ts — la pestaña Ventas compartida entre los dos bots (19-nov-2026).
 *
 * El bot de Herbalis y el de Club Herbys son dos despliegues con su propia base.
 * Para que cada panel muestre los pedidos de los dos, cada servidor le pide los
 * suyos al otro por `GET /api/peer/orders` (order.routes.js) y los mezcla con los
 * propios, cada uno marcado con el bot del que viene.
 *
 * Variables (las tres en los DOS despliegues):
 *   BOT_NAME        cómo se llama este bot en el panel ("Herbalis", "Club Herbys")
 *   PEER_BOT_URL    la URL del otro bot (https://…up.railway.app)
 *   PEER_BOT_TOKEN  secreto compartido, el mismo valor en los dos
 * Sin PEER_BOT_URL o sin PEER_BOT_TOKEN todo queda como antes: cada panel ve lo suyo.
 *
 * Los pedidos del otro bot son de SOLO LECTURA acá: editarlos, cambiarles el
 * estado o mandarlos al sistema se hace desde su propio panel. Si el otro bot no
 * contesta, el listado sale igual con los pedidos propios y avisa (`peer.ok`).
 */
import crypto from 'crypto';
const logger = require('../utils/logger');

const PEER_TIMEOUT_MS = 4000;
/** Tope de lo que se le pide al otro bot (y de lo que se junta acá para mezclar). */
export const PEER_MAX_TAKE = 2000;

export const botName = (): string => (process.env.BOT_NAME || 'Herbalis').trim();

export function isPeerConfigured(): boolean {
    return !!(process.env.PEER_BOT_URL && process.env.PEER_BOT_TOKEN);
}

/** ¿El token que mandó el otro bot es el compartido? Comparación de tiempo constante. */
export function peerTokenMatches(given: unknown): boolean {
    const expected = process.env.PEER_BOT_TOKEN;
    if (typeof given !== 'string' || !expected) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface PeerOrdersResult {
    /** false si el otro bot no contestó o contestó mal: el listado sale solo con lo propio. */
    ok: boolean;
    bot: string | null;
    orders: any[];
    total: number;
}

/**
 * Los `take` pedidos más recientes del otro bot, con los mismos filtros que el
 * listado propio. Nunca tira: ante cualquier falla devuelve `ok: false` y vacío.
 */
export async function fetchPeerOrders(
    q: { search?: string; status?: string; instanceId?: string; take: number },
    fetchImpl: typeof fetch = fetch,
): Promise<PeerOrdersResult> {
    const empty: PeerOrdersResult = { ok: false, bot: null, orders: [], total: 0 };
    if (!isPeerConfigured()) return empty;
    try {
        const params = new URLSearchParams({ take: String(Math.min(Math.max(q.take || 0, 1), PEER_MAX_TAKE)) });
        if (q.search) params.set('search', q.search);
        if (q.status && q.status !== 'Todos') params.set('status', q.status);
        if (q.instanceId) params.set('instanceId', q.instanceId);
        const base = String(process.env.PEER_BOT_URL).replace(/\/+$/, '');
        const res = await fetchImpl(`${base}/api/peer/orders?${params.toString()}`, {
            headers: { 'x-peer-token': String(process.env.PEER_BOT_TOKEN) },
            signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
        });
        if (!res.ok) {
            logger.warn(`[PEER-ORDERS] El otro bot contestó ${res.status}`);
            return empty;
        }
        const body: any = await res.json();
        const bot = typeof body?.bot === 'string' && body.bot.trim() ? body.bot.trim() : 'Otro bot';
        const orders = (Array.isArray(body?.data) ? body.data : [])
            .filter((o: any) => o && typeof o.id === 'string')
            // `peer` es lo que el panel mira para dejar el pedido en solo lectura.
            .map((o: any) => ({ ...o, bot, peer: true }));
        return { ok: true, bot, orders, total: Number(body?.total) || orders.length };
    } catch (e: any) {
        logger.warn(`[PEER-ORDERS] No pude traer los pedidos del otro bot: ${e?.message}`);
        return empty;
    }
}

/**
 * Una página del listado mezclado. `local` y `peer` traen cada uno sus
 * `page * limit` pedidos más recientes; juntos y ordenados por fecha, la página
 * pedida es la misma que saldría de una sola tabla con todos.
 */
export function mergeOrderPage(local: any[], peer: any[], page: number, limit: number): any[] {
    const at = (o: any) => { const t = Date.parse(o?.createdAt); return Number.isNaN(t) ? 0 : t; };
    const all = [...local, ...peer].sort((a, b) => at(b) - at(a));
    const skip = (Math.max(page, 1) - 1) * limit;
    return all.slice(skip, skip + limit);
}
