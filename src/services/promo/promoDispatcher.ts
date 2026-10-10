/**
 * promoDispatcher.ts — manda la promo de a UNA persona, al ritmo de alguien que
 * escribe de a ratos.
 *
 * El scheduler per-seller llama a promoTick() cada minuto. El tick:
 *   1. busca la campaña `running` del seller (una sola por seller);
 *   2. respeta la ventana horaria (Argentina), el tope diario y la hora del
 *      próximo envío (`nextSendAt`), que se sortea después de cada envío con
 *      pausas irregulares y, de tanto en tanto, un corte largo;
 *   3. toma al siguiente destinatario pendiente, lo re-valida en el momento
 *      (¿compró? ¿está pausado? ¿escribió hace poco? ¿pidió que no le escriban?)
 *      y si no corresponde lo salta y sigue con el próximo;
 *   4. prepara su estado (step `promo_offer`, promo activa), arma el texto con
 *      su variante y lo manda por sendMessageWithDelay (eco reconocido por
 *      trackBotSends, historial anotado adentro, delay humanizado).
 *
 * Tres envíos fallidos seguidos pausan la campaña y avisan al admin: si el
 * número está bloqueado o la sesión cayó, seguir insistiendo es lo peor.
 */

import fs from 'fs';
import path from 'path';
import { formatInTimeZone } from 'date-fns-tz';
import { UserState } from '../../types/state';
import { _setStep, _cleanPhone, _pushHistory } from '../../flows/utils/flowHelpers';
import { createInitialUserState } from '../../flows/leadClassifier';
import { _getPromoPrice60 } from '../../flows/utils/pricing';
import { renderPromoMessage, PromoTemplates } from './promoTemplates';
import { generatePromoVariation, DEFAULT_BASE_MESSAGE } from './promoVariation';
import { AudienceFilters, DEFAULT_AUDIENCE_FILTERS, normalizeAudienceFilters } from './promoAudience';
import logger from '../../utils/logger';

const { prisma } = require('../../../db');

const ARG_TZ = 'America/Argentina/Buenos_Aires';
const MIN = 60 * 1000;

export interface PromoCampaignConfig {
    /** Hora (ARG) desde la que se manda, inclusive. */
    windowStartHour: number;
    /** Hora (ARG) hasta la que se manda, exclusive. */
    windowEndHour: number;
    /** Máximo de mensajes por día. */
    dailyCap: number;
    /** Pausa entre envíos, en minutos (se sortea en el rango, cargado hacia abajo). */
    minGapMinutes: number;
    maxGapMinutes: number;
    /** Cada tantos envíos (en promedio) hay un corte largo. 0 = nunca. */
    longBreakEvery: number;
    /** Duración del corte largo, en minutos (rango). */
    longBreakMinMinutes: number;
    longBreakMaxMinutes: number;
    /** No mandar sábados ni domingos. */
    skipWeekends: boolean;
    /** Si el cliente nos escribió hace menos de estas horas, saltearlo (está en una charla viva). */
    skipIfInboundHours: number;
    /** Envíos fallidos seguidos que pausan la campaña. */
    maxFailStreak: number;
    /**
     * Cómo se arma el texto de cada envío:
     *   'ai'        → Claude reescribe `baseMessage` con ligeras diferencias (default);
     *                 si falla o devuelve algo inválido, cae a las plantillas.
     *   'templates' → solo las variantes por bloques de promoTemplates.
     */
    variationMode: 'ai' | 'templates';
    /** El mensaje del vendedor; {{PROMO_60}} es el precio y {{NAME_COMMA}} el nombre (opcional). */
    baseMessage: string;
    /** Textos propios por bloque (modo 'templates' y respaldo del modo 'ai'). */
    templates?: Partial<PromoTemplates> | null;
    /** Mandar la imagen del flyer (public/promo/promo-60-dias.jpg) unos segundos después del texto. */
    imageEnabled: boolean;
    /** Con qué filtros se armó la lista. */
    audience: Omit<AudienceFilters, 'instanceId'>;
}

export const DEFAULT_PROMO_CONFIG: PromoCampaignConfig = {
    windowStartHour: 10,
    windowEndHour: 20,
    dailyCap: 30,
    minGapMinutes: 6,
    maxGapMinutes: 25,
    longBreakEvery: 8,
    longBreakMinMinutes: 35,
    longBreakMaxMinutes: 90,
    skipWeekends: false,
    skipIfInboundHours: 48,
    maxFailStreak: 3,
    variationMode: 'ai',
    baseMessage: DEFAULT_BASE_MESSAGE,
    templates: null,
    imageEnabled: true,
    audience: { ...DEFAULT_AUDIENCE_FILTERS },
};

/** El flyer de la promo, commiteado en el repo (public/media está ignorado; public/promo no). */
export const PROMO_IMAGE_PATH = path.join(__dirname, '../../../public/promo/promo-60-dias.jpg');

let _imageCache: { mimetype: string; data: string; filename: string } | null = null;
/** La imagen como MessageMedia ({mimetype, data, filename}); null si no está. Cacheada en memoria. */
export function loadPromoImage(filePath: string = PROMO_IMAGE_PATH): { mimetype: string; data: string; filename: string } | null {
    if (_imageCache) return _imageCache;
    try {
        if (!fs.existsSync(filePath)) return null;
        _imageCache = { mimetype: 'image/jpeg', data: fs.readFileSync(filePath).toString('base64'), filename: 'promo-60-dias.jpg' };
        return _imageCache;
    } catch (e: any) {
        logger.warn(`[PROMO] No pude leer la imagen de la promo: ${e.message}`);
        return null;
    }
}

export function normalizePromoConfig(raw: any, instanceId: string = 'default'): PromoCampaignConfig {
    const d = DEFAULT_PROMO_CONFIG;
    const num = (v: any, def: number, min: number, max: number) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return def;
        return Math.min(max, Math.max(min, Math.round(n)));
    };
    const cfg: PromoCampaignConfig = {
        windowStartHour: num(raw?.windowStartHour, d.windowStartHour, 0, 23),
        windowEndHour: num(raw?.windowEndHour, d.windowEndHour, 1, 24),
        dailyCap: num(raw?.dailyCap, d.dailyCap, 1, 500),
        minGapMinutes: num(raw?.minGapMinutes, d.minGapMinutes, 1, 24 * 60),
        maxGapMinutes: num(raw?.maxGapMinutes, d.maxGapMinutes, 1, 24 * 60),
        longBreakEvery: num(raw?.longBreakEvery, d.longBreakEvery, 0, 1000),
        longBreakMinMinutes: num(raw?.longBreakMinMinutes, d.longBreakMinMinutes, 1, 24 * 60),
        longBreakMaxMinutes: num(raw?.longBreakMaxMinutes, d.longBreakMaxMinutes, 1, 24 * 60),
        skipWeekends: raw?.skipWeekends === true,
        skipIfInboundHours: num(raw?.skipIfInboundHours, d.skipIfInboundHours, 0, 24 * 30),
        maxFailStreak: num(raw?.maxFailStreak, d.maxFailStreak, 1, 50),
        variationMode: raw?.variationMode === 'templates' ? 'templates' : 'ai',
        baseMessage: typeof raw?.baseMessage === 'string' && raw.baseMessage.trim().length >= 40 ? raw.baseMessage.replace(/\r/g, '').trim() : d.baseMessage,
        templates: raw?.templates && typeof raw.templates === 'object' ? raw.templates : null,
        imageEnabled: raw?.imageEnabled !== false,
        audience: (() => { const { instanceId: _i, ...rest } = normalizeAudienceFilters(instanceId, raw?.audience); return rest; })(),
    };
    if (cfg.windowEndHour <= cfg.windowStartHour) cfg.windowEndHour = Math.min(24, cfg.windowStartHour + 1);
    if (cfg.maxGapMinutes < cfg.minGapMinutes) cfg.maxGapMinutes = cfg.minGapMinutes;
    if (cfg.longBreakMaxMinutes < cfg.longBreakMinMinutes) cfg.longBreakMaxMinutes = cfg.longBreakMinMinutes;
    return cfg;
}

// ── Tiempo (Argentina) ───────────────────────────────────────────────────────

export function argDateKey(now: Date = new Date()): string {
    return formatInTimeZone(now, ARG_TZ, 'yyyy-MM-dd');
}
function argHour(now: Date): number {
    return parseInt(formatInTimeZone(now, ARG_TZ, 'HH'), 10) + parseInt(formatInTimeZone(now, ARG_TZ, 'mm'), 10) / 60;
}
function argIsWeekend(now: Date): boolean {
    const dow = formatInTimeZone(now, ARG_TZ, 'i'); // 1 = lunes … 7 = domingo
    return dow === '6' || dow === '7';
}
/** Instante de `hour` (ARG) del día de `now`. Argentina no tiene horario de verano: -03 fijo. */
function argInstantAt(now: Date, hour: number): Date {
    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);
    return new Date(`${argDateKey(now)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`);
}

export function isInsideWindow(cfg: PromoCampaignConfig, now: Date = new Date()): boolean {
    if (cfg.skipWeekends && argIsWeekend(now)) return false;
    const h = argHour(now);
    return h >= cfg.windowStartHour && h < cfg.windowEndHour;
}

/**
 * Próximo envío. La pausa se sortea en [min, max] con sesgo hacia el mínimo
 * (como alguien que manda varios seguidos y de vez en cuando se distrae), más
 * segundos sueltos para que nunca caiga en el minuto redondo. Cada
 * `longBreakEvery` envíos en promedio se suma un corte largo.
 */
export function computeNextSendAt(cfg: PromoCampaignConfig, now: Date = new Date(), rand: () => number = Math.random): Date {
    const span = cfg.maxGapMinutes - cfg.minGapMinutes;
    // Sesgo: el mínimo de dos uniformes carga la distribución hacia abajo.
    const skewed = Math.min(rand(), rand());
    let minutes = cfg.minGapMinutes + skewed * span;
    if (cfg.longBreakEvery > 0 && rand() < 1 / cfg.longBreakEvery) {
        minutes += cfg.longBreakMinMinutes + rand() * (cfg.longBreakMaxMinutes - cfg.longBreakMinMinutes);
    }
    const seconds = Math.floor(rand() * 60);
    return new Date(now.getTime() + Math.round(minutes * MIN) + seconds * 1000);
}

/** Arranque del día: no al minuto exacto de abrir la ventana, sino un rato después. */
export function computeDayStart(cfg: PromoCampaignConfig, now: Date = new Date(), rand: () => number = Math.random): Date {
    const base = argInstantAt(now, cfg.windowStartHour);
    const offsetMin = 3 + rand() * 40;
    const start = new Date(Math.max(base.getTime(), now.getTime()) + offsetMin * MIN);
    return start;
}

// ── Estado del cliente ───────────────────────────────────────────────────────

/** Último mensaje ENTRANTE del cliente (ms), según el estado guardado. */
function _lastInboundAt(state: UserState | null | undefined): number | null {
    const hist: any[] = (state?.history as any[]) || [];
    for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i]?.role === 'user' && hist[i].timestamp) return hist[i].timestamp;
    }
    return null;
}

/**
 * Deja el estado del cliente listo para recibir la promo: step promo_offer,
 * promo activa, sin restos del pedido viejo. Devuelve el step previo. Si el
 * cliente no está en memoria intenta rehidratarlo de la DB (HYDRATE_LIMIT deja
 * afuera a los menos recientes) y si tampoco está, arranca uno limpio.
 */
export async function preparePromoState(
    userId: string,
    sharedState: any,
    campaignId: string,
    price60: string,
    now: number = Date.now()
): Promise<{ state: UserState; prevStep: string | null }> {
    const userState: Record<string, UserState> = sharedState.userState;
    let state = userState[userId];
    if (!state) {
        try {
            const row = await prisma.user.findUnique({
                where: { phone_instanceId: { phone: _cleanPhone(userId), instanceId: sharedState.sellerId } },
                select: { profileData: true },
            });
            if (row?.profileData) state = JSON.parse(row.profileData);
        } catch (e: any) {
            logger.warn(`[PROMO] No pude rehidratar el estado de ${userId}: ${e.message}`);
        }
        if (!state || typeof state !== 'object') state = createInitialUserState({ step: 'greeting' });
        userState[userId] = state;
    }
    const prevStep = state.step || null;

    state.cart = [];
    state.selectedPlan = null;
    state.totalPrice = null;
    state.pendingOrder = null;
    state.paymentMethod = null;
    state.shippingChoice = null;
    state.paymentSubChoiceAsked = false;
    state.pendingCancelConfirm = false;
    state.awaitingResume = false;
    state.mpPaymentLinkId = null;
    state.mpPaymentLinkUrl = null;
    state.senaAmount = null;
    state.senaPaid = false;
    state.promo = { active: true, campaignId, sentAt: now, price60, prevStep, outcome: null };
    state.lastActivityAt = now;
    _setStep(state, 'promo_offer');
    return { state, prevStep };
}

// ── Texto del envío ──────────────────────────────────────────────────────────

/** Modelo barato de Claude: el mismo que usa ai.ts para lo simple. */
export const PROMO_AI_MODEL = process.env.CLAUDE_MODEL_SIMPLE || 'claude-haiku-4-5-20251001';

/** Cliente de Anthropic del servicio de IA (require diferido: ai.ts es pesado y los tests lo mockean). */
function _anthropicClient(): any {
    try {
        return require('../ai').aiService?.anthropic || null;
    } catch {
        return null;
    }
}

export interface BuildTextArgs {
    cfg: PromoCampaignConfig;
    campaignId: string;
    phone: string;
    name?: string | null;
    price60: string;
    anthropic?: any;
    rand?: () => number;
}

/**
 * El texto para un destinatario. En modo 'ai' lo reescribe Claude a partir del
 * mensaje base; si la IA falla o devuelve algo inválido, sale una variante de
 * las plantillas (nunca el mismo texto para todos, y la campaña no se frena).
 */
export async function buildPromoText(args: BuildTextArgs): Promise<{ text: string; via: 'ai' | 'templates' }> {
    const { cfg } = args;
    if (cfg.variationMode === 'ai') {
        try {
            const anthropic = args.anthropic === undefined ? _anthropicClient() : args.anthropic;
            const text = await generatePromoVariation({
                baseMessage: cfg.baseMessage, price60: args.price60, name: args.name, anthropic, model: PROMO_AI_MODEL, rand: args.rand,
            });
            return { text, via: 'ai' };
        } catch (e: any) {
            logger.warn(`[PROMO-IA] Sin reescritura para ${args.phone} (${e.message}) — sale una variante de plantilla.`);
        }
    }
    const text = renderPromoMessage({ phone: args.phone, campaignId: args.campaignId, name: args.name, templates: cfg.templates, price60: args.price60 });
    return { text, via: 'templates' };
}

// ── Tick ─────────────────────────────────────────────────────────────────────

interface TickDeps {
    sendMessageWithDelay: (userId: string, msg: string, startTime?: number, stillValid?: () => boolean) => Promise<boolean>;
    saveState: (userId?: string) => void;
    notifyAdmin?: (title: string, userId: string, msg: string) => Promise<any>;
    /** Cliente de WhatsApp del seller, para mandar la imagen (sendMessageWithDelay solo manda texto). */
    client?: any;
}

/**
 * Manda el flyer unos segundos después del texto, como quien adjunta la foto
 * después de escribir. Nunca hace fallar el envío: sin imagen o con error, el
 * texto ya salió y la campaña sigue. Deja marcador en el historial y en el
 * panel (misma convención que la imagen del saludo).
 */
async function _sendPromoImage(userId: string, state: UserState, sharedState: any, deps: TickDeps, rand: () => number): Promise<boolean> {
    if (!deps.client) return false;
    const media = loadPromoImage();
    if (!media) {
        logger.warn(`[PROMO][${sharedState.sellerId}] Sin imagen de la promo en ${PROMO_IMAGE_PATH} — va solo el texto.`);
        return false;
    }
    try {
        await new Promise(r => setTimeout(r, 2000 + Math.floor(rand() * 4000)));
        if (sharedState.pausedUsers?.has(userId)) return false;
        await deps.client.sendMessage(userId, media, { caption: '' });
        _pushHistory(state, { role: 'bot', content: '[Imagen adjunta: flyer de la promo 60 días]' });
        if (typeof sharedState.logAndEmit === 'function') {
            try { sharedState.logAndEmit(userId, 'bot', '📷 Imagen enviada: flyer de la promo', 'promo_offer'); } catch { /* best effort */ }
        }
        return true;
    } catch (e: any) {
        logger.warn(`[PROMO][${sharedState.sellerId}] No salió la imagen a ${userId}: ${e.message}`);
        return false;
    }
}

const MAX_SKIPS_PER_TICK = 15;
const TICK_MAX_DURATION_MS = 3 * MIN;

async function _skipRecipient(r: any, reason: string): Promise<void> {
    await prisma.promoRecipient.update({ where: { id: r.id }, data: { status: 'skipped', skipReason: reason } });
    logger.info(`[PROMO] ${r.phone} salteado: ${reason}`);
}

async function _finishCampaign(c: any, sharedState: any, deps: TickDeps): Promise<void> {
    await prisma.promoCampaign.update({ where: { id: c.id }, data: { status: 'finished', finishedAt: new Date(), nextSendAt: null } });
    logger.info(`[PROMO][${sharedState.sellerId}] Campaña "${c.name}" terminada (${c.totalSent} enviados).`);
    if (deps.notifyAdmin) {
        deps.notifyAdmin('🎁 Campaña promo terminada', 'system', `"${c.name}": se mandaron ${c.totalSent} mensajes. Mirá los resultados en Promos.`).catch(() => {});
    }
}

/**
 * Un tick del despachador. Exportado para los tests y para el botón "mandar
 * ahora" del panel (que lo llama con `force`, saltando ventana y hora).
 */
export async function promoTick(
    sharedState: any,
    deps: TickDeps,
    opts: { now?: Date; force?: boolean; rand?: () => number; /** cliente de Anthropic a usar (tests); undefined = el del servicio de IA, null = sin IA */ anthropic?: any } = {}
): Promise<{ sent: boolean; reason: string }> {
    const now = opts.now || new Date();
    const rand = opts.rand || Math.random;
    const sellerId = sharedState.sellerId;

    const startedAt = sharedState._promoTickStartedAt || 0;
    if (startedAt > 0 && now.getTime() - startedAt < TICK_MAX_DURATION_MS) return { sent: false, reason: 'tick_en_curso' };
    sharedState._promoTickStartedAt = now.getTime();

    try {
        if (!sharedState.isConnected) return { sent: false, reason: 'desconectado' };
        if (sharedState.config?.globalPause) return { sent: false, reason: 'pausa_global' };

        const campaign = await prisma.promoCampaign.findFirst({ where: { instanceId: sellerId, status: 'running' }, orderBy: { startedAt: 'asc' } });
        if (!campaign) return { sent: false, reason: 'sin_campaña' };
        const cfg = normalizePromoConfig(JSON.parse(campaign.config || '{}'), sellerId);

        // Día nuevo: contador a cero y arranque del día con un retraso al azar.
        const today = argDateKey(now);
        let sentToday = campaign.sentToday;
        let nextSendAt: Date | null = campaign.nextSendAt ? new Date(campaign.nextSendAt) : null;
        if (campaign.sentTodayDate !== today) {
            sentToday = 0;
            nextSendAt = computeDayStart(cfg, now, rand);
            await prisma.promoCampaign.update({ where: { id: campaign.id }, data: { sentToday: 0, sentTodayDate: today, nextSendAt } });
        }

        if (!opts.force) {
            if (!isInsideWindow(cfg, now)) return { sent: false, reason: 'fuera_de_ventana' };
            if (sentToday >= cfg.dailyCap) return { sent: false, reason: 'tope_diario' };
            if (nextSendAt && now.getTime() < nextSendAt.getTime()) return { sent: false, reason: 'esperando_turno' };
        }

        // Siguiente destinatario válido.
        let recipient: any = null;
        for (let i = 0; i < MAX_SKIPS_PER_TICK; i++) {
            const r = await prisma.promoRecipient.findFirst({ where: { campaignId: campaign.id, status: 'pending' }, orderBy: { position: 'asc' } });
            if (!r) break;
            const userId = `${r.phone}@c.us`;

            if (sharedState.pausedUsers?.has(userId)) { await _skipRecipient(r, 'pausado'); continue; }
            const order = await prisma.order.findFirst({ where: { userPhone: r.phone, instanceId: { in: [sellerId, '__legacy_import__'] } }, select: { id: true } });
            if (order) { await _skipRecipient(r, 'ya_compro'); continue; }
            const optedOut = await prisma.promoRecipient.findFirst({ where: { instanceId: sellerId, phone: r.phone, OR: [{ status: 'opted_out' }, { outcome: 'opted_out' }] }, select: { id: true } });
            if (optedOut) { await _skipRecipient(r, 'pidio_no_recibir'); continue; }
            const st = sharedState.userState?.[userId];
            if (st?.promo?.active) { await _skipRecipient(r, 'ya_recibio_promo'); continue; }
            const lastIn = _lastInboundAt(st);
            if (lastIn && now.getTime() - lastIn < cfg.skipIfInboundHours * 3600 * 1000) { await _skipRecipient(r, 'charla_reciente'); continue; }
            if (st && ['completed', 'rejected_medical', 'rejected_abusive', 'rejected_geo'].includes(st.step)) { await _skipRecipient(r, 'estado_terminal'); continue; }
            if (st?.pendingOrder) { await _skipRecipient(r, 'pedido_en_curso'); continue; }

            recipient = r;
            break;
        }

        if (!recipient) {
            const pendingLeft = await prisma.promoRecipient.count({ where: { campaignId: campaign.id, status: 'pending' } });
            if (pendingLeft === 0) await _finishCampaign(campaign, sharedState, deps);
            return { sent: false, reason: pendingLeft === 0 ? 'terminada' : 'solo_salteados' };
        }

        const price60 = _getPromoPrice60('Cápsulas');
        if (!price60) {
            await prisma.promoCampaign.update({ where: { id: campaign.id }, data: { status: 'paused' } });
            logger.error(`[PROMO][${sellerId}] Sin promoPrice60 en prices.json — campaña pausada.`);
            if (deps.notifyAdmin) deps.notifyAdmin('⚠️ Campaña promo pausada', 'system', 'No hay precio promo cargado (Editor de Precios → Precio promo plan 60).').catch(() => {});
            return { sent: false, reason: 'sin_precio_promo' };
        }

        const userId = `${recipient.phone}@c.us`;
        const { state, prevStep } = await preparePromoState(userId, sharedState, campaign.id, price60, now.getTime());
        deps.saveState(userId);

        let text: string;
        let via: 'ai' | 'templates' = 'templates';
        try {
            const built = await buildPromoText({
                cfg, campaignId: campaign.id, phone: recipient.phone, price60, rand,
                name: state.userName || state.partialAddress?.nombre || null,
                anthropic: opts.anthropic,
            });
            text = built.text;
            via = built.via;
        } catch (e: any) {
            // Sin texto válido no se manda nada: dejar el estado como estaba.
            _setStep(state, prevStep || 'greeting');
            state.promo = null;
            deps.saveState(userId);
            await prisma.promoCampaign.update({ where: { id: campaign.id }, data: { status: 'paused' } });
            logger.error(`[PROMO][${sellerId}] Plantilla inválida (${e.message}) — campaña pausada.`);
            return { sent: false, reason: 'plantilla_invalida' };
        }

        const ok = await deps.sendMessageWithDelay(userId, text);

        if (ok) {
            const withImage = cfg.imageEnabled ? await _sendPromoImage(userId, state, sharedState, deps, rand) : false;
            if (withImage) deps.saveState(userId);
            const next = computeNextSendAt(cfg, new Date(), rand);
            await Promise.all([
                prisma.promoRecipient.update({ where: { id: recipient.id }, data: { status: 'sent', sentAt: new Date(), messageText: text } }),
                prisma.promoCampaign.update({ where: { id: campaign.id }, data: { sentToday: { increment: 1 }, totalSent: { increment: 1 }, failStreak: 0, nextSendAt: next, sentTodayDate: today } }),
            ]);
            logger.info(`[PROMO][${sellerId}] Promo enviada a ${recipient.phone} vía ${via}${withImage ? ' + imagen' : ''} (${sentToday + 1}/${cfg.dailyCap} hoy). Próximo: ${formatInTimeZone(next, ARG_TZ, 'HH:mm:ss')}`);
            return { sent: true, reason: 'enviado' };
        }

        // No salió: el estado vuelve atrás y se anota el fallo.
        _setStep(state, prevStep || 'greeting');
        state.promo = null;
        deps.saveState(userId);
        const failStreak = (campaign.failStreak || 0) + 1;
        const pauseIt = failStreak >= cfg.maxFailStreak;
        await Promise.all([
            prisma.promoRecipient.update({ where: { id: recipient.id }, data: { status: 'failed', skipReason: 'envio_fallido' } }),
            prisma.promoCampaign.update({ where: { id: campaign.id }, data: { failStreak, ...(pauseIt ? { status: 'paused' } : { nextSendAt: computeNextSendAt(cfg, new Date(), rand) }) } }),
        ]);
        logger.warn(`[PROMO][${sellerId}] Envío a ${recipient.phone} falló (${failStreak} seguidos)${pauseIt ? ' — campaña pausada' : ''}.`);
        if (pauseIt && deps.notifyAdmin) {
            deps.notifyAdmin('⚠️ Campaña promo pausada', 'system', `${failStreak} envíos fallidos seguidos. Revisá la conexión de WhatsApp antes de reanudarla desde Promos.`).catch(() => {});
        }
        return { sent: false, reason: pauseIt ? 'pausada_por_fallos' : 'envio_fallido' };
    } catch (e: any) {
        logger.error(`[PROMO][${sellerId}] tick falló: ${e.message}`);
        return { sent: false, reason: 'error' };
    } finally {
        sharedState._promoTickStartedAt = 0;
    }
}

/**
 * Anota la respuesta de un destinatario (la llama el step promo_offer).
 * Best effort: no puede frenar la conversación.
 */
export function markPromoReply(instanceId: string, userId: string, outcome: 'interested' | 'declined' | 'opted_out' | 'question'): void {
    const phone = _cleanPhone(userId);
    (async () => {
        const r = await prisma.promoRecipient.findFirst({ where: { instanceId, phone, status: 'sent' }, orderBy: { sentAt: 'desc' } });
        if (!r) return;
        const data: any = { outcome };
        if (!r.repliedAt) data.repliedAt = new Date();
        if (outcome === 'opted_out') data.status = 'opted_out';
        await prisma.promoRecipient.update({ where: { id: r.id }, data });
    })().catch((e: any) => logger.warn(`[PROMO] No pude anotar la respuesta de ${phone}: ${e.message}`));
}
