/**
 * adStats.ts — de qué anuncio llega cada persona y cuántos terminan comprando.
 *
 * messageHandler llama recordAdLead con cada entrante que trae la ficha de un
 * anuncio de Meta (ctwaContext) o que es de una persona nueva para el número
 * ('sin_anuncio'). Se anota ANTES del filtro de a quién contesta el bot, así
 * cuentan también los anuncios que el bot no atiende (vestidos).
 */

import logger from '../utils/logger';
import { _cleanPhone } from '../flows/utils/flowHelpers';

const { prisma } = require('../../db');

export const NO_AD = 'sin_anuncio';

export function recordAdLead(instanceId: string, userId: string, msg: { ad?: any; isNewChat?: boolean }): void {
    const phone = _cleanPhone(userId);
    const ad = msg?.ad;
    const sourceId = ad?.sourceId ? String(ad.sourceId) : (msg?.isNewChat ? NO_AD : null);
    if (!phone || !sourceId) return;
    const now = new Date();
    prisma.adLead.upsert({
        where: { instanceId_phone_sourceId: { instanceId, phone, sourceId } },
        create: {
            instanceId, phone, sourceId, firstAt: now, lastAt: now,
            title: ad?.title ? String(ad.title).slice(0, 200) : (sourceId === NO_AD ? 'Sin anuncio (persona nueva)' : null),
            mediaType: typeof ad?.mediaType === 'number' ? ad.mediaType : null,
        },
        update: { lastAt: now, messages: { increment: 1 } },
    }).catch((e: any) => {
        if (e?.code !== 'P2002') logger.warn(`[ADS][${instanceId}] No pude anotar el anuncio de ${phone}: ${e.message}`);
    });
}

export interface AdStatRow {
    sourceId: string;
    title: string;
    kind: 'video' | 'imagen' | 'sin anuncio' | '?';
    leads: number;
    today: number;
    last7: number;
    orders: number;
    conversion: number;   // % de contactos con pedido
    firstAt: string | null;
    lastAt: string | null;
}

/** Contactos por anuncio en los últimos `days` días, con los que terminaron en pedido. */
export async function getAdStats(instanceId: string, days: number, now: Date = new Date()): Promise<AdStatRow[]> {
    const since = new Date(now.getTime() - days * 86400e3);
    const leads = await prisma.adLead.findMany({
        where: { instanceId, firstAt: { gte: since } },
        select: { phone: true, sourceId: true, title: true, mediaType: true, firstAt: true },
    });
    // Pedidos de esos teléfonos hechos después de llegar por el anuncio.
    const phones = [...new Set(leads.map((l: any) => l.phone))];
    const orders = phones.length
        ? await prisma.order.findMany({
            where: { instanceId, userPhone: { in: phones }, createdAt: { gte: since }, status: { not: 'Cancelado' } },
            select: { userPhone: true, createdAt: true },
        })
        : [];
    const firstOrder = new Map<string, Date>();
    for (const o of orders) {
        const prev = firstOrder.get(o.userPhone);
        if (!prev || o.createdAt < prev) firstOrder.set(o.userPhone, o.createdAt);
    }

    // Inicio del día en Argentina (UTC-3) para "hoy".
    const argNow = new Date(now.getTime() - 3 * 3600e3);
    const todayStart = new Date(Date.UTC(argNow.getUTCFullYear(), argNow.getUTCMonth(), argNow.getUTCDate()) + 3 * 3600e3);
    const weekStart = new Date(now.getTime() - 7 * 86400e3);

    const by = new Map<string, AdStatRow>();
    for (const l of leads) {
        let r = by.get(l.sourceId);
        if (!r) {
            r = {
                sourceId: l.sourceId,
                title: l.title || l.sourceId,
                kind: l.sourceId === 'sin_anuncio' ? 'sin anuncio' : l.mediaType === 2 ? 'video' : l.mediaType === 1 ? 'imagen' : '?',
                leads: 0, today: 0, last7: 0, orders: 0, conversion: 0, firstAt: null, lastAt: null,
            };
            by.set(l.sourceId, r);
        }
        if (l.title && r.title === r.sourceId) r.title = l.title;
        r.leads++;
        if (l.firstAt >= todayStart) r.today++;
        if (l.firstAt >= weekStart) r.last7++;
        const o = firstOrder.get(l.phone);
        if (o && o >= l.firstAt) r.orders++;
        const iso = l.firstAt.toISOString();
        if (!r.firstAt || iso < r.firstAt) r.firstAt = iso;
        if (!r.lastAt || iso > r.lastAt) r.lastAt = iso;
    }
    const rows = [...by.values()];
    for (const r of rows) r.conversion = r.leads ? Math.round((r.orders / r.leads) * 1000) / 10 : 0;
    return rows.sort((a, b) => b.leads - a.leads);
}
