/**
 * webOrderNotify.ts — confirmación por WhatsApp de un pedido de la TIENDA WEB.
 *
 * La web (web-v5) escribe WebOrder por SQL crudo y, cuando MercadoPago aprueba
 * el pago, llama POST /api/web-orders/:id/notify (webOrder.routes.js). Acá:
 *  1. se elige el WhatsApp que manda (WEB_ORDERS_SELLER o el primer seller
 *     conectado del pool),
 *  2. se normaliza el teléfono que la clienta tipeó en el checkout al formato
 *     de WhatsApp Argentina (549 + área + número),
 *  3. se reclama WebOrder.whatsappNotifiedAt (idempotente: MP y la web pueden
 *     disparar el aviso más de una vez),
 *  4. se manda la confirmación a la clienta, se deja el chat en pausa (una
 *     compra ya hecha no tiene que caer en el flujo de ventas si responde) y
 *     se avisa a los números de alerta del seller (config.alertNumbers).
 */
const logger = require('../utils/logger');

export interface WebOrderItem { id: string; name: string; plan: string; qty: number; unitPrice: number; lineTotal?: number }

export interface WebOrderLike {
    id: string;
    status: string;
    items: unknown;
    total: number;
    shipping: number;
    nombre: string | null;
    apellido: string | null;
    email: string | null;
    telefono: string | null;
    provincia: string | null;
    ciudad: string | null;
    calle: string | null;
    piso: string | null;
    cp: string | null;
    notas: string | null;
    mpPaymentId: string | null;
    paidAt: Date | null;
    createdAt: Date;
    whatsappNotifiedAt: Date | null;
}

export function formatArs(n: number): string {
    return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

/** "abc12345" — el mismo número corto que ve la clienta en la web y el email. */
export const shortId = (id: string): string => String(id).slice(0, 8).toUpperCase();

export function parseItems(items: unknown): WebOrderItem[] {
    if (!Array.isArray(items)) return [];
    return items
        .filter((it: any) => it && typeof it === 'object')
        .map((it: any) => ({
            id: String(it.id || ''),
            name: String(it.name || ''),
            plan: String(it.plan || ''),
            qty: Math.max(1, Number(it.qty) || 1),
            unitPrice: Number(it.unitPrice) || 0,
        }));
}

export function addressLine(o: WebOrderLike): string {
    const street = [o.calle, o.piso].filter(Boolean).join(', ');
    const city = [o.ciudad, o.provincia].filter(Boolean).join(', ');
    return [street, city, o.cp ? `CP ${o.cp}` : ''].filter(Boolean).join(' · ');
}

/**
 * Candidatos de número WhatsApp (sin @c.us) a partir de lo que tipeó la clienta.
 * Móvil argentino en WhatsApp = 549 + área (2–4) + número (8–6) = 13 dígitos.
 * Acepta "+54 9 341 261-9397", "0341 15 261 9397", "341 2619397", "11 5555 5555"…
 * El primero es la mejor apuesta; el resto son variantes (sin el "15" viejo,
 * fijo sin el 9) para probar con client.getNumberId cuando está disponible.
 */
export function phoneCandidates(raw: string | null | undefined): string[] {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return [];
    if (d.startsWith('00')) d = d.slice(2);

    let rest: string;
    if (d.startsWith('549')) rest = d.slice(3);
    else if (d.startsWith('54')) rest = d.slice(2);
    else if (d.startsWith('0')) rest = d.slice(1);
    else rest = d;

    // "15" (prefijo viejo de celular) entre el área y el número: sobran 2 dígitos.
    const stripped15 = new Set<string>();
    if (rest.length === 11 || rest.length === 12) {
        for (const areaLen of [2, 3, 4]) {
            if (rest.slice(areaLen, areaLen + 2) === '15') {
                const s = rest.slice(0, areaLen) + rest.slice(areaLen + 2);
                if (s.length === 10) stripped15.add(s);
            }
        }
    }

    const out: string[] = [];
    const push = (c: string) => { if (!out.includes(c)) out.push(c); };
    if (rest.length === 10) push('549' + rest);
    for (const s of stripped15) push('549' + s);
    if (rest.length !== 10 && rest.length >= 8 && rest.length <= 11) push('549' + rest); // longitud rara: igual se intenta
    if (rest.length === 10) push('54' + rest); // fijo con WhatsApp, último recurso
    return out;
}

/**
 * Resuelve el chatId real. Con whatsapp-web.js local, getNumberId confirma que
 * el número existe en WhatsApp; el cliente remoto (agente en la PC del vendedor)
 * no lo expone, así que ahí va la mejor apuesta sin verificar.
 */
export async function resolveWhatsappId(client: any, candidates: string[]): Promise<{ chatId: string; verified: boolean } | null> {
    if (candidates.length === 0) return null;
    if (client && typeof client.getNumberId === 'function') {
        for (const c of candidates) {
            try {
                const r = await client.getNumberId(c);
                if (r?._serialized) return { chatId: r._serialized, verified: true };
            } catch (e: any) {
                logger.warn(`[WEB-NOTIFY] getNumberId(${c}) falló: ${e.message}`);
            }
        }
    }
    return { chatId: `${candidates[0]}@c.us`, verified: false };
}

export function buildCustomerMessage(o: WebOrderLike): string {
    const items = parseItems(o.items);
    const nombre = (o.nombre || '').trim();
    const lines = items.map(it => `• ${it.name} · ${it.plan} ×${it.qty} — ${formatArs(it.unitPrice * it.qty)}`);
    return [
        `¡Hola${nombre ? ' ' + nombre : ''}! 🌱 Te escribimos de *Herbalis*.`,
        `Recibimos tu pago y tu pedido web *#${shortId(o.id)}* ya está confirmado ✅`,
        '',
        '🛍️ *Tu pedido*',
        ...lines,
        `💰 Total: *${formatArs(o.total)}*${Number(o.shipping) > 0 ? '' : ' (envío gratis)'}`,
        '',
        '📦 *Envío a*',
        addressLine(o) || '(dirección a confirmar)',
        '',
        'Lo preparamos y te pasamos por acá el código de seguimiento apenas salga. Llega en 6 a 10 días hábiles.',
        'Junto con el producto te llega la guía de uso. Cualquier duda, respondé este mensaje y te ayudamos. ¡Gracias por elegirnos! 💚',
    ].join('\n');
}

export function buildAdminMessage(o: WebOrderLike, sentTo: string | null): string {
    const items = parseItems(o.items);
    const who = [o.nombre, o.apellido].filter(Boolean).join(' ') || '(sin nombre)';
    const when = o.paidAt || o.createdAt;
    const whenLabel = when
        ? new Date(when).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' })
        : '';
    return [
        `🛒 *Nueva venta web* #${shortId(o.id)} — *${formatArs(o.total)}*`,
        `👤 ${who} · ${o.telefono || '-'}${o.email ? ` · ${o.email}` : ''}`,
        `📦 ${addressLine(o) || '(sin dirección)'}`,
        ...items.map(it => `🧾 ${it.name} · ${it.plan} ×${it.qty}`),
        `💳 Mercado Pago${o.mpPaymentId ? ` #${o.mpPaymentId}` : ''}${whenLabel ? ` · ${whenLabel}` : ''}`,
        ...(o.notas ? [`📝 ${o.notas}`] : []),
        sentTo ? `✅ Confirmación enviada por WhatsApp a ${sentTo.replace('@c.us', '')}` : '⚠️ No se pudo enviar la confirmación por WhatsApp',
        '_Panel del bot → Pedidos web para marcar el envío._',
    ].join('\n');
}

/** Seller cuyo WhatsApp manda: WEB_ORDERS_SELLER si está conectado, si no el primero conectado. */
export function pickInstance(clientPool: any, preferred?: string): any | null {
    const ok = (i: any) => !!(i && i.client && i.sharedState?.isConnected);
    const pref = (preferred || '').trim().toLowerCase();
    if (pref) {
        const p = clientPool?.getSeller?.(pref);
        if (ok(p)) return p;
        logger.warn(`[WEB-NOTIFY] WEB_ORDERS_SELLER="${pref}" no está conectado — se usa el primer seller conectado`);
    }
    const all: any[] = clientPool?.getAllSellers?.() || [];
    return all.find(ok) || null;
}

export interface NotifyResult {
    ok: boolean;
    httpStatus?: number;
    error?: string;
    skipped?: string;
    dryRun?: boolean;
    sellerId?: string;
    sentTo?: string;
    verified?: boolean;
    adminsNotified?: number;
    customerMessage?: string;
    adminMessage?: string;
    alertNumbers?: string[];
    whatsappNotifiedAt?: Date | null;
    candidates?: string[];
}

/**
 * Envía la confirmación de un pedido web aprobado. Idempotente por
 * whatsappNotifiedAt salvo `force`. Con `dryRun` resuelve todo y devuelve los
 * mensajes sin enviar nada ni tocar la DB.
 */
export async function notifyWebOrder(opts: { orderId: string; clientPool: any; prisma: any; force?: boolean; dryRun?: boolean }): Promise<NotifyResult> {
    const { orderId, clientPool, prisma, force = false, dryRun = false } = opts;

    const order: WebOrderLike | null = await prisma.webOrder.findUnique({ where: { id: orderId } });
    if (!order) return { ok: false, httpStatus: 404, error: 'Pedido no encontrado' };
    if (order.status !== 'approved') {
        return { ok: false, httpStatus: 409, error: `El pedido está en estado "${order.status}"; solo se notifican pedidos aprobados` };
    }

    const candidates = phoneCandidates(order.telefono);
    if (candidates.length === 0) {
        return { ok: false, httpStatus: 422, error: `Teléfono inválido: "${order.telefono || ''}"` };
    }

    const instance = pickInstance(clientPool, process.env.WEB_ORDERS_SELLER);
    if (!instance) return { ok: false, httpStatus: 503, error: 'Ningún WhatsApp conectado en el pool' };
    const { client, sharedState: ss, sellerId } = instance;

    const target = await resolveWhatsappId(client, candidates);
    if (!target) return { ok: false, httpStatus: 422, error: 'No se pudo resolver el número' };

    const customerMessage = buildCustomerMessage(order);
    const adminMessage = buildAdminMessage(order, target.chatId);
    const alertNumbers: string[] = Array.isArray(ss?.config?.alertNumbers) ? ss.config.alertNumbers : [];

    if (dryRun) {
        return { ok: true, dryRun: true, sellerId, sentTo: target.chatId, verified: target.verified, candidates, customerMessage, adminMessage, alertNumbers };
    }

    // Reclamo atómico: solo el primero que llega envía (MP + web pueden disparar varias veces).
    if (force) {
        await prisma.webOrder.update({ where: { id: orderId }, data: { whatsappNotifiedAt: new Date() } });
    } else {
        const claimed = await prisma.webOrder.updateMany({
            where: { id: orderId, whatsappNotifiedAt: null },
            data: { whatsappNotifiedAt: new Date() },
        });
        if (claimed.count === 0) {
            return { ok: true, skipped: 'already_notified', whatsappNotifiedAt: order.whatsappNotifiedAt, sellerId };
        }
    }

    try {
        await client.sendMessage(target.chatId, customerMessage);
    } catch (e: any) {
        // Liberar el reclamo para que la web pueda reintentar (webhook / resultado).
        if (!force) {
            await prisma.webOrder.updateMany({ where: { id: orderId }, data: { whatsappNotifiedAt: null } }).catch(() => {});
        }
        logger.error(`[WEB-NOTIFY] fallo enviando a ${target.chatId} (pedido ${shortId(orderId)}): ${e.message}`);
        return { ok: false, httpStatus: 502, error: `No se pudo enviar el WhatsApp: ${e.message}`, sellerId, sentTo: target.chatId };
    }
    logger.info(`[WEB-NOTIFY] confirmación enviada a ${target.chatId} (pedido ${shortId(orderId)}, seller=${sellerId}, verificado=${target.verified})`);

    // Envío directo (no pasa por sendMessageWithDelay): el history se anota acá.
    try { ss?.logAndEmit?.(target.chatId, 'bot', customerMessage, 'web_order_confirmation'); } catch (e: any) {
        logger.warn(`[WEB-NOTIFY] logAndEmit falló: ${e.message}`);
    }
    // La compra ya está hecha: si responde, que la atienda una persona y no el flujo de ventas.
    try {
        const { pauseUser } = require('./pauseService');
        await pauseUser(target.chatId, '🛒 Compra web confirmada — seguimiento manual', { sharedState: ss, instanceId: sellerId });
    } catch (e: any) {
        logger.warn(`[WEB-NOTIFY] no se pudo pausar ${target.chatId}: ${e.message}`);
    }

    let adminsNotified = 0;
    for (const n of alertNumbers) {
        try {
            await client.sendMessage(`${String(n).replace(/\D/g, '')}@c.us`, adminMessage);
            adminsNotified++;
        } catch (e: any) {
            logger.warn(`[WEB-NOTIFY] aviso a admin ${n} falló: ${e.message}`);
        }
    }

    return { ok: true, sellerId, sentTo: target.chatId, verified: target.verified, adminsNotified };
}
