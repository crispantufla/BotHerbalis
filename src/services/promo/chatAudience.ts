/**
 * chatAudience.ts — la audiencia de una campaña Club Herbys: todas las personas
 * con las que el número tuvo una charla, sacadas de la lista de chats del propio
 * WhatsApp (la base de este bot arranca vacía, así que promoAudience.ts, que
 * lee el embudo de Herbalis, no sirve acá).
 *
 * Fuera: grupos, difusiones, canales, chats sin mensajes, el propio número, los
 * números de aviso (config.alertNumbers) y quien pidió que no le escriban. Los
 * chats @lid se pasan a teléfono con resolveUserIdFrom (que además deja la
 * resolución pegajosa en Redis, así la respuesta cae en el mismo estado). Un
 * @lid que no se puede resolver queda afuera: el despachador manda a
 * <telefono>@c.us.
 */

import logger from '../../utils/logger';
import { resolveUserIdFrom } from '../../handlers/incomingSteps';

const { prisma } = require('../../../db');
const { redisConnection } = require('../queueService');

export interface ChatAudienceSummary {
    chats: number;
    individuals: number;
    unresolved: number;
    excluded: number;
    optedOut: number;
    buyers: number;
    members: number;
    /** Chats individuales por mes del último mensaje (AAAA-MM), para ver hasta dónde sincronizó WA Web. */
    byMonth: Record<string, number>;
}

export interface ChatAudienceMember { phone: string; name: string | null; lastChatAt: number }

const digits = (s: any) => String(s || '').replace(/\D/g, '');
const CACHE_MS = 10 * 60 * 1000;
const _cache = new Map<string, { at: number; members: ChatAudienceMember[]; summary: ChatAudienceSummary }>();

/** Corre fn sobre items con como mucho `n` en paralelo (cada resolución es un RPC al agente). */
async function _mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
}

export async function selectChatAudience(opts: {
    client: any;
    instanceId: string;
    excludePhones?: string[];
    fresh?: boolean;
}): Promise<{ members: ChatAudienceMember[]; summary: ChatAudienceSummary }> {
    const { client, instanceId } = opts;
    const cached = _cache.get(instanceId);
    if (!opts.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached;
    if (!client || typeof client.getChats !== 'function') throw new Error('El WhatsApp de este vendedor no está conectado');

    const chats: any[] = await client.getChats();
    const individuals = chats.filter((c) => {
        const id = String(c?.id?._serialized || '');
        return !c.isGroup && /@(c\.us|lid)$/.test(id) && (c.timestamp || c.lastMessage?.timestamp);
    });

    const ownPhone = digits(client.info?.wid?.user);
    const excluded = new Set((opts.excludePhones || []).map(digits).filter(Boolean));
    if (ownPhone) excluded.add(ownPhone);
    const optedOutRows = await prisma.promoRecipient.findMany({
        where: { instanceId, OR: [{ status: 'opted_out' }, { outcome: 'opted_out' }] },
        select: { phone: true },
    });
    const optedOut = new Set(optedOutRows.map((r: any) => r.phone));
    // Quien ya compró no recibe la oferta: pedidos de este seller o de la lista de
    // compradores importada (__legacy_import__, p. ej. el Excel "Pedidos" del 25-oct).
    const buyerRows = await prisma.order.findMany({
        where: { instanceId: { in: [instanceId, '__legacy_import__'] } },
        select: { userPhone: true },
        distinct: ['userPhone'],
    });
    const buyers = new Set(buyerRows.map((r: any) => r.userPhone));

    const resolved = await _mapLimit(individuals, 5, async (c) => {
        const id = String(c.id._serialized);
        if (id.endsWith('@c.us')) return id;
        // El agente ya trae el teléfono del @lid (caché de WA Web): sin RPC por chat.
        // Se deja la resolución pegajosa en Redis, igual que resolveUserIdFrom, para
        // que la respuesta de esa persona caiga en el mismo estado.
        const phone = digits(c.phone);
        if (phone.length >= 8) {
            const uid = `${phone}@c.us`;
            try { await redisConnection.set(`lidmap:${instanceId}:${id}`, uid, 'EX', 604800); } catch { /* noop */ }
            return uid;
        }
        try {
            return await resolveUserIdFrom(id, () => client.getContactById(id), instanceId);
        } catch (e: any) {
            logger.warn(`[PROMO-CHATS][${instanceId}] No pude resolver ${id}: ${e.message}`);
            return id;
        }
    });

    const byPhone = new Map<string, ChatAudienceMember>();
    let unresolved = 0, nExcluded = 0, nOptedOut = 0, nBuyers = 0;
    individuals.forEach((c, k) => {
        const uid = resolved[k];
        if (!uid || !uid.endsWith('@c.us')) { unresolved++; return; }
        const phone = digits(uid);
        if (excluded.has(phone)) { nExcluded++; return; }
        if (optedOut.has(phone)) { nOptedOut++; return; }
        if (buyers.has(phone)) { nBuyers++; return; }
        const at = Number(c.timestamp || c.lastMessage?.timestamp || 0);
        const prev = byPhone.get(phone);
        if (!prev || at > prev.lastChatAt) byPhone.set(phone, { phone, name: c.name || null, lastChatAt: at });
    });

    const members = [...byPhone.values()];
    // Mezclar: que el orden de envío no siga la lista de chats.
    for (let i = members.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [members[i], members[j]] = [members[j], members[i]];
    }
    const summary: ChatAudienceSummary = {
        chats: chats.length, individuals: individuals.length, unresolved, excluded: nExcluded, optedOut: nOptedOut, buyers: nBuyers, members: members.length,
        byMonth: individuals.reduce((acc: Record<string, number>, c: any) => {
            const t = Number(c.timestamp || c.lastMessage?.timestamp || 0);
            const k = t ? new Date(t * 1000).toISOString().slice(0, 7) : "sin fecha";
            acc[k] = (acc[k] || 0) + 1;
            return acc;
        }, {}),
    };
    logger.info(`[PROMO-CHATS][${instanceId}] ${JSON.stringify(summary)}`);
    const out = { at: Date.now(), members, summary };
    _cache.set(instanceId, out);
    return out;
}
