/**
 * promoAudience.ts — a quién le mandamos la promo.
 *
 * "Gente que consultó en los últimos 6 meses, menos los últimos 30 días, y no
 * compró". Dos fuentes, porque ninguna sola alcanza:
 *
 *   - FunnelEvent: queda para siempre y es la ÚNICA memoria de quién habló con
 *     el bot hace más de un mes (medido el 8-oct-2026: 6.325 teléfonos entre 30
 *     y 180 días; ni User.profileData ni ChatLog conservan nada más viejo que
 *     ~40 días, por la limpieza nocturna de estados y la purga de ChatLog).
 *   - User.profileData: para los recientes trae el estado del chat (nombre,
 *     step, carrito) y sirve para afinar: sin mensajes del cliente, con pedido
 *     en curso o en estado terminal, afuera.
 *
 * Quedan afuera: con pedidos (en este seller o en el padrón importado),
 * pausados para atención humana, estados terminales (compró, rechazos), y
 * quien ya recibió una promo en la ventana de enfriamiento o pidió que no le
 * escribamos más.
 */

import logger from '../../utils/logger';

const { prisma } = require('../../../db');

export interface AudienceFilters {
    instanceId: string;
    /** Días desde el último contacto, mínimo: a quien habló hace poco (o tiene un pedido en curso) no se lo molesta. */
    minDaysSinceLastSeen: number;
    /** Días desde el último contacto, máximo. */
    maxDaysSinceLastSeen: number;
    /** Tope de destinatarios. */
    limit: number;
    /** Días sin repetir promo a la misma persona. */
    cooldownDays: number;
    /** Teléfonos a excluir siempre (admins). */
    excludePhones?: string[];
}

export interface AudienceMember {
    phone: string;
    name: string | null;
    step: string;
    lastSeen: Date;
    /** 'state' si tenemos el chat guardado, 'funnel' si solo queda el rastro del embudo. */
    source: 'state' | 'funnel';
}

export interface AudienceSummary {
    total: number;
    byStep: Record<string, number>;
    bySource: Record<string, number>;
    excluded: Record<string, number>;
}

const TERMINAL_STEPS = new Set(['completed', 'rejected_medical', 'rejected_abusive', 'rejected_geo', 'promo_offer']);

export const DEFAULT_AUDIENCE_FILTERS: Omit<AudienceFilters, 'instanceId'> = {
    minDaysSinceLastSeen: 30,
    maxDaysSinceLastSeen: 180,
    limit: 10000,
    cooldownDays: 90,
};

export function normalizeAudienceFilters(instanceId: string, raw: any): AudienceFilters {
    const num = (v: any, def: number, min: number, max: number) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return def;
        return Math.min(max, Math.max(min, Math.round(n)));
    };
    const d = DEFAULT_AUDIENCE_FILTERS;
    const f: AudienceFilters = {
        instanceId,
        minDaysSinceLastSeen: num(raw?.minDaysSinceLastSeen, d.minDaysSinceLastSeen, 0, 365),
        maxDaysSinceLastSeen: num(raw?.maxDaysSinceLastSeen, d.maxDaysSinceLastSeen, 1, 3650),
        limit: num(raw?.limit, d.limit, 1, 20000),
        cooldownDays: num(raw?.cooldownDays, d.cooldownDays, 0, 3650),
        excludePhones: Array.isArray(raw?.excludePhones) ? raw.excludePhones.map((p: any) => String(p).replace(/\D/g, '')) : [],
    };
    if (f.maxDaysSinceLastSeen < f.minDaysSinceLastSeen) f.maxDaysSinceLastSeen = f.minDaysSinceLastSeen;
    return f;
}

/** Mezcla al azar (Fisher-Yates): el orden de envío no sigue ningún patrón. */
export function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

const _digits = (p: any) => String(p || '').replace(/\D/g, '');

interface Candidate {
    phone: string;
    lastSeen: Date;      // último rastro, de cualquier fuente
    funnelStep: string | null;
    funnelExit: string | null;
    user: any | null;    // fila de User si existe (puede ser más vieja que el rastro del embudo)
}

/**
 * Candidatos de la promo, ya mezclados. `summary` cuenta también a los que
 * quedaron afuera y por qué, para que el panel lo muestre antes de crear la
 * campaña.
 */
export async function selectPromoAudience(filters: AudienceFilters): Promise<{ members: AudienceMember[]; summary: AudienceSummary }> {
    const now = Date.now();
    const DAY = 86400000;
    const newest = new Date(now - filters.minDaysSinceLastSeen * DAY);
    const oldest = new Date(now - filters.maxDaysSinceLastSeen * DAY);

    const [funnelLast, users, orders, promoRows] = await Promise.all([
        // Último evento del embudo por teléfono, dentro de la ventana ampliada
        // hacia atrás (para saber también quién volvió a escribir DESPUÉS del
        // mínimo: ese no entra, está en una charla viva).
        prisma.funnelEvent.groupBy({
            by: ['phone'],
            where: { sellerId: filters.instanceId, enteredAt: { gte: oldest } },
            _max: { enteredAt: true },
        }),
        prisma.user.findMany({
            where: { instanceId: filters.instanceId, lastSeen: { gte: oldest } },
            select: { phone: true, lastSeen: true, pausedAt: true, profileData: true },
        }),
        prisma.order.findMany({
            where: { instanceId: { in: [filters.instanceId, '__legacy_import__'] } },
            select: { userPhone: true },
            distinct: ['userPhone'],
        }),
        prisma.promoRecipient.findMany({
            where: {
                instanceId: filters.instanceId,
                OR: [
                    { status: 'opted_out' },
                    { outcome: 'opted_out' },
                    { outcome: 'declined' },
                    { sentAt: { gte: new Date(now - filters.cooldownDays * DAY) } },
                    { status: 'pending' },
                ],
            },
            select: { phone: true },
        }),
    ]);

    // Dónde terminó cada uno en el embudo (el evento más reciente), para
    // descartar rechazos y compras que no dejaron pedido en este seller.
    const lastEvents: any[] = funnelLast.length
        ? await prisma.funnelEvent.findMany({
            where: {
                sellerId: filters.instanceId,
                OR: funnelLast.map((g: any) => ({ phone: g.phone, enteredAt: g._max.enteredAt })),
            },
            select: { phone: true, stepTo: true, exitType: true, enteredAt: true },
        })
        : [];
    const lastEventByPhone = new Map<string, any>();
    for (const e of lastEvents) {
        const p = _digits(e.phone);
        const prev = lastEventByPhone.get(p);
        if (!prev || e.enteredAt > prev.enteredAt) lastEventByPhone.set(p, e);
    }

    const candidates = new Map<string, Candidate>();
    for (const g of funnelLast) {
        const phone = _digits(g.phone);
        if (!phone) continue;
        const ev = lastEventByPhone.get(phone);
        candidates.set(phone, { phone, lastSeen: new Date(g._max.enteredAt), funnelStep: ev?.stepTo || null, funnelExit: ev?.exitType || null, user: null });
    }
    for (const u of users) {
        const phone = _digits(u.phone);
        if (!phone) continue;
        const c = candidates.get(phone);
        const seen = new Date(u.lastSeen);
        if (c) {
            c.user = u;
            if (seen > c.lastSeen) c.lastSeen = seen;
        } else {
            candidates.set(phone, { phone, lastSeen: seen, funnelStep: null, funnelExit: null, user: u });
        }
    }

    const bought = new Set<string>(orders.map((o: any) => _digits(o.userPhone)));
    const alreadyPromoed = new Set<string>(promoRows.map((r: any) => _digits(r.phone)));
    const excluded = new Set<string>((filters.excludePhones || []).map(_digits));

    const excludedCounts: Record<string, number> = {};
    const bump = (k: string) => { excludedCounts[k] = (excludedCounts[k] || 0) + 1; };

    const members: AudienceMember[] = [];
    for (const c of candidates.values()) {
        if (c.phone.length < 8) { bump('telefono_invalido'); continue; }
        if (excluded.has(c.phone)) { bump('excluido'); continue; }
        if (bought.has(c.phone)) { bump('ya_compro'); continue; }
        if (alreadyPromoed.has(c.phone)) { bump('ya_recibio_promo'); continue; }
        if (c.lastSeen > newest) { bump('contacto_reciente'); continue; }
        if (c.lastSeen < oldest) { bump('muy_viejo'); continue; }
        if (c.user?.pausedAt) { bump('pausado'); continue; }
        if (c.funnelExit === 'completed' || (c.funnelStep && TERMINAL_STEPS.has(c.funnelStep))) {
            bump(c.funnelStep === 'promo_offer' ? 'ya_recibio_promo' : 'estado_terminal'); continue;
        }

        let st: any = null;
        if (c.user?.profileData) {
            try { st = JSON.parse(c.user.profileData); } catch { st = null; }
        }
        if (st && typeof st === 'object') {
            const hist: any[] = Array.isArray(st.history) ? st.history : [];
            const inbound = hist.filter((h) => h && h.role === 'user').length;
            const step = String(st.step || 'greeting');
            if (inbound === 0 && !c.funnelStep) { bump('sin_conversacion'); continue; }
            if (TERMINAL_STEPS.has(step)) { bump(step === 'promo_offer' ? 'ya_recibio_promo' : 'estado_terminal'); continue; }
            if (st.pendingOrder) { bump('pedido_en_curso'); continue; }
            if (st.geoRejected) { bump('estado_terminal'); continue; }
            members.push({ phone: c.phone, name: st.userName || st.partialAddress?.nombre || null, step, lastSeen: c.lastSeen, source: 'state' });
            continue;
        }
        if (!c.funnelStep) { bump('sin_conversacion'); continue; }
        members.push({ phone: c.phone, name: null, step: c.funnelStep, lastSeen: c.lastSeen, source: 'funnel' });
    }

    const picked = shuffle(members).slice(0, filters.limit);
    const byStep: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const m of picked) {
        byStep[m.step] = (byStep[m.step] || 0) + 1;
        bySource[m.source] = (bySource[m.source] || 0) + 1;
    }
    if (members.length > picked.length) excludedCounts['fuera_del_tope'] = members.length - picked.length;

    logger.info(`[PROMO][${filters.instanceId}] Audiencia: ${picked.length} de ${candidates.size} candidatos (${JSON.stringify(excludedCounts)})`);
    return { members: picked, summary: { total: picked.length, byStep, bySource, excluded: excludedCounts } };
}
