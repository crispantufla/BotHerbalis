/**
 * Campañas promo — el despachador (oct-2026).
 *
 *  - Manda de a uno, solo dentro de la ventana, hasta el tope diario, y recién
 *    cuando llegó la hora sorteada del próximo envío.
 *  - Re-valida al destinatario antes de mandar: pausado, con pedido, con charla
 *    reciente o que pidió no recibir → se saltea y sigue con el próximo.
 *  - Deja el estado del cliente en promo_offer con la promo activa; si el envío
 *    falla, lo devuelve a donde estaba y anota el fallo; tres fallos seguidos
 *    pausan la campaña.
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../src/services/funnelLogger');

const mockDb = {
    promoCampaign: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    promoRecipient: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(1) },
    order: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
};
jest.mock('../db', () => ({ prisma: mockDb }));

const {
    promoTick, normalizePromoConfig, computeNextSendAt, computeDayStart, isInsideWindow, preparePromoState, argDateKey,
} = require('../src/services/promo/promoDispatcher');

// 14:30 de un miércoles en Argentina (UTC-3) → 17:30Z.
const WED_1430 = new Date('2026-10-07T17:30:00.000Z');
const SAT_1430 = new Date('2026-10-10T17:30:00.000Z');
const H = 3600 * 1000;

const cfg = () => normalizePromoConfig({ windowStartHour: 10, windowEndHour: 20, dailyCap: 3, minGapMinutes: 6, maxGapMinutes: 25 });

function campaign(over = {}) {
    return {
        id: 'c1', instanceId: 'horacio', name: 'Promo oct', status: 'running', config: JSON.stringify(cfg()),
        sentToday: 0, sentTodayDate: argDateKey(WED_1430), totalSent: 0, failStreak: 0,
        nextSendAt: new Date(WED_1430.getTime() - 60000), ...over,
    };
}
function recipient(phone = '5493410000001', over = {}) {
    return { id: `r-${phone}`, campaignId: 'c1', instanceId: 'horacio', phone, position: 0, status: 'pending', ...over };
}
function shared(over = {}) {
    return { sellerId: 'horacio', isConnected: true, config: {}, userState: {}, pausedUsers: new Set(), ...over };
}
function deps(ok = true) {
    return { sendMessageWithDelay: jest.fn().mockResolvedValue(ok), saveState: jest.fn(), notifyAdmin: jest.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.promoRecipient.update.mockResolvedValue({});
    mockDb.promoCampaign.update.mockResolvedValue({});
    mockDb.order.findFirst.mockResolvedValue(null);
    mockDb.promoRecipient.count.mockResolvedValue(1);
});

describe('ventana y pacing', () => {
    test('isInsideWindow respeta hora argentina y fines de semana', () => {
        expect(isInsideWindow(cfg(), WED_1430)).toBe(true);
        expect(isInsideWindow(cfg(), new Date('2026-10-07T23:30:00.000Z'))).toBe(false); // 20:30 ARG
        expect(isInsideWindow(cfg(), new Date('2026-10-07T12:30:00.000Z'))).toBe(false); // 09:30 ARG
        expect(isInsideWindow(normalizePromoConfig({ skipWeekends: true }), SAT_1430)).toBe(false);
        expect(isInsideWindow(normalizePromoConfig({ skipWeekends: false }), SAT_1430)).toBe(true);
    });

    test('computeNextSendAt cae en [min, max] minutos (sin corte largo) y nunca en el minuto redondo', () => {
        const c = normalizePromoConfig({ minGapMinutes: 6, maxGapMinutes: 25, longBreakEvery: 0 });
        for (let i = 0; i < 300; i++) {
            const next = computeNextSendAt(c, WED_1430);
            const min = (next - WED_1430) / 60000;
            expect(min).toBeGreaterThanOrEqual(6);
            expect(min).toBeLessThan(26.1);
        }
    });

    test('con corte largo, a veces la pausa es mucho más larga', () => {
        const c = normalizePromoConfig({ minGapMinutes: 6, maxGapMinutes: 25, longBreakEvery: 2, longBreakMinMinutes: 60, longBreakMaxMinutes: 90 });
        const gaps = Array.from({ length: 200 }, () => (computeNextSendAt(c, WED_1430) - WED_1430) / 60000);
        expect(gaps.some(g => g > 60)).toBe(true);
        expect(gaps.some(g => g < 26)).toBe(true);
    });

    test('computeDayStart arranca después de abrir la ventana, no al minuto exacto', () => {
        const early = new Date('2026-10-07T11:00:00.000Z'); // 08:00 ARG
        const start = computeDayStart(cfg(), early);
        const open = new Date('2026-10-07T13:00:00.000Z'); // 10:00 ARG
        expect(start.getTime()).toBeGreaterThan(open.getTime() + 2 * 60000);
        expect(start.getTime()).toBeLessThan(open.getTime() + 45 * 60000);
    });

    test('normalizePromoConfig corrige rangos invertidos y pone defaults', () => {
        const c = normalizePromoConfig({ windowStartHour: 15, windowEndHour: 12, minGapMinutes: 30, maxGapMinutes: 5, dailyCap: 'x' });
        expect(c.windowEndHour).toBe(16);
        expect(c.maxGapMinutes).toBe(30);
        expect(c.dailyCap).toBe(30);
    });
});

describe('promoTick — cuándo NO manda', () => {
    test('sin WhatsApp conectado', async () => {
        const d = deps();
        expect(await promoTick(shared({ isConnected: false }), d, { now: WED_1430 })).toEqual({ sent: false, reason: 'desconectado' });
        expect(d.sendMessageWithDelay).not.toHaveBeenCalled();
    });
    test('sin campaña corriendo', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(null);
        expect((await promoTick(shared(), deps(), { now: WED_1430 })).reason).toBe('sin_campaña');
    });
    test('fuera de la ventana horaria', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign());
        const d = deps();
        expect((await promoTick(shared(), d, { now: new Date('2026-10-07T23:30:00.000Z') })).reason).toBe('fuera_de_ventana');
        expect(d.sendMessageWithDelay).not.toHaveBeenCalled();
    });
    test('tope diario alcanzado', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign({ sentToday: 3 }));
        expect((await promoTick(shared(), deps(), { now: WED_1430 })).reason).toBe('tope_diario');
    });
    test('todavía no es la hora del próximo envío', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign({ nextSendAt: new Date(WED_1430.getTime() + 5 * 60000) }));
        expect((await promoTick(shared(), deps(), { now: WED_1430 })).reason).toBe('esperando_turno');
    });
    test('día nuevo: resetea el contador y sortea el arranque (no manda en ese tick)', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign({ sentToday: 3, sentTodayDate: '2026-10-06' }));
        const r = await promoTick(shared(), deps(), { now: WED_1430 });
        expect(r.reason).toBe('esperando_turno');
        expect(mockDb.promoCampaign.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sentToday: 0, sentTodayDate: argDateKey(WED_1430) }) }));
    });
});

describe('promoTick — manda y prepara el estado', () => {
    test('envía la variante al siguiente pendiente, deja promo_offer activo y agenda el próximo', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign());
        mockDb.promoRecipient.findFirst
            .mockResolvedValueOnce(recipient()) // pendiente
            .mockResolvedValueOnce(null);        // no pidió no recibir
        const ss = shared({ userState: { '5493410000001@c.us': { step: 'waiting_plan_choice', history: [{ role: 'user', content: 'hola', timestamp: WED_1430 - 5 * 24 * H }], cart: [{ product: 'x' }], selectedPlan: '120', userName: 'Carla' } } });
        const d = deps(true);

        const r = await promoTick(ss, d, { now: WED_1430 });
        expect(r).toEqual({ sent: true, reason: 'enviado' });
        expect(d.sendMessageWithDelay).toHaveBeenCalledTimes(1);
        const [to, text] = d.sendMessageWithDelay.mock.calls[0];
        expect(to).toBe('5493410000001@c.us');
        expect(text).toMatch(/Carla/);
        expect(text).toMatch(/44\.900/);

        const st = ss.userState['5493410000001@c.us'];
        expect(st.step).toBe('promo_offer');
        expect(st.promo).toEqual(expect.objectContaining({ active: true, campaignId: 'c1', price60: '44.900', prevStep: 'waiting_plan_choice' }));
        expect(st.cart).toEqual([]);
        expect(st.selectedPlan).toBeNull();
        expect(d.saveState).toHaveBeenCalledWith('5493410000001@c.us');

        expect(mockDb.promoRecipient.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'sent', messageText: text }) }));
        const campUpdate = mockDb.promoCampaign.update.mock.calls.find(c => c[0].data.nextSendAt);
        expect(campUpdate[0].data).toEqual(expect.objectContaining({ sentToday: { increment: 1 }, totalSent: { increment: 1 }, failStreak: 0 }));
        expect(campUpdate[0].data.nextSendAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60000);
    });

    test('cliente sin estado en memoria ni en DB: arranca uno limpio en promo_offer', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign());
        mockDb.promoRecipient.findFirst.mockResolvedValueOnce(recipient('5493410000002')).mockResolvedValueOnce(null);
        const ss = shared();
        await promoTick(ss, deps(true), { now: WED_1430 });
        const st = ss.userState['5493410000002@c.us'];
        expect(st.step).toBe('promo_offer');
        expect(st.promo.prevStep).toBe('greeting');
        expect(st.history).toEqual([]);
    });

    test('saltea pausados, compradores, charlas recientes y quien pidió no recibir; manda al siguiente', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign());
        const paused = recipient('5493410000010');
        const buyer = recipient('5493410000011');
        const recent = recipient('5493410000012');
        const optout = recipient('5493410000013');
        const good = recipient('5493410000014');
        mockDb.promoRecipient.findFirst
            .mockResolvedValueOnce(paused)
            .mockResolvedValueOnce(buyer)
            .mockResolvedValueOnce(recent).mockResolvedValueOnce(null)
            .mockResolvedValueOnce(optout).mockResolvedValueOnce({ id: 'old' })
            .mockResolvedValueOnce(good).mockResolvedValueOnce(null);
        mockDb.order.findFirst.mockImplementation(({ where }) => Promise.resolve(where.userPhone === buyer.phone ? { id: 'o1' } : null));
        const ss = shared({
            pausedUsers: new Set(['5493410000010@c.us']),
            userState: { '5493410000012@c.us': { step: 'waiting_weight', history: [{ role: 'user', content: 'hola', timestamp: WED_1430 - 2 * H }] } },
        });
        const d = deps(true);
        const r = await promoTick(ss, d, { now: WED_1430 });
        expect(r.sent).toBe(true);
        expect(d.sendMessageWithDelay.mock.calls[0][0]).toBe('5493410000014@c.us');
        const skipped = mockDb.promoRecipient.update.mock.calls.filter(c => c[0].data.status === 'skipped').map(c => [c[0].where.id, c[0].data.skipReason]);
        expect(skipped).toEqual([
            ['r-5493410000010', 'pausado'],
            ['r-5493410000011', 'ya_compro'],
            ['r-5493410000012', 'charla_reciente'],
            ['r-5493410000013', 'pidio_no_recibir'],
        ]);
    });

    test('sin pendientes → la campaña termina y se avisa al admin', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign({ totalSent: 12 }));
        mockDb.promoRecipient.findFirst.mockResolvedValue(null);
        mockDb.promoRecipient.count.mockResolvedValue(0);
        const d = deps();
        const r = await promoTick(shared(), d, { now: WED_1430 });
        expect(r.reason).toBe('terminada');
        expect(mockDb.promoCampaign.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'finished' }) }));
        expect(d.notifyAdmin).toHaveBeenCalled();
    });

    test('envío fallido: el estado vuelve a donde estaba y el 3er fallo seguido pausa la campaña', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign({ failStreak: 2 }));
        mockDb.promoRecipient.findFirst.mockResolvedValueOnce(recipient('5493410000020')).mockResolvedValueOnce(null);
        const ss = shared({ userState: { '5493410000020@c.us': { step: 'waiting_preference', history: [] } } });
        const d = deps(false);
        const r = await promoTick(ss, d, { now: WED_1430 });
        expect(r.reason).toBe('pausada_por_fallos');
        const st = ss.userState['5493410000020@c.us'];
        expect(st.step).toBe('waiting_preference');
        expect(st.promo).toBeNull();
        expect(mockDb.promoRecipient.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }));
        expect(mockDb.promoCampaign.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failStreak: 3, status: 'paused' }) }));
        expect(d.notifyAdmin).toHaveBeenCalled();
    });

    test('force: manda aunque esté fuera de ventana (botón "mandar ahora")', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign({ nextSendAt: new Date(WED_1430.getTime() + 60 * 60000) }));
        mockDb.promoRecipient.findFirst.mockResolvedValueOnce(recipient('5493410000030')).mockResolvedValueOnce(null);
        const d = deps(true);
        const r = await promoTick(shared(), d, { now: new Date('2026-10-07T23:30:00.000Z'), force: true });
        expect(r.sent).toBe(true);
    });
});

describe('preparePromoState', () => {
    test('rehidrata el estado desde la DB si no está en memoria', async () => {
        mockDb.user.findUnique.mockResolvedValueOnce({ profileData: JSON.stringify({ step: 'waiting_data', history: [{ role: 'user', content: 'x', timestamp: 1 }], partialAddress: { nombre: 'Lola' }, pendingOrder: { x: 1 } }) });
        const ss = shared();
        const { state, prevStep } = await preparePromoState('5493410000040@c.us', ss, 'c1', '44.900', WED_1430.getTime());
        expect(prevStep).toBe('waiting_data');
        expect(state.step).toBe('promo_offer');
        expect(state.pendingOrder).toBeNull();
        expect(state.partialAddress.nombre).toBe('Lola');
        expect(ss.userState['5493410000040@c.us']).toBe(state);
    });
});

describe('imagen del flyer', () => {
    const { loadPromoImage, PROMO_IMAGE_PATH } = require('../src/services/promo/promoDispatcher');
    const fs = require('fs');

    test('el flyer está en el repo y se carga como MessageMedia', () => {
        expect(fs.existsSync(PROMO_IMAGE_PATH)).toBe(true);
        const m = loadPromoImage();
        expect(m).toEqual(expect.objectContaining({ mimetype: 'image/jpeg', filename: 'promo-60-dias.jpg' }));
        expect(m.data.length).toBeGreaterThan(1000);
    });

    test('tras el texto manda la imagen por el cliente y deja marcador en el historial', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign());
        mockDb.promoRecipient.findFirst.mockResolvedValueOnce(recipient('5493410000050')).mockResolvedValueOnce(null);
        const ss = shared({ logAndEmit: jest.fn() });
        const d = { ...deps(true), client: { sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'x' } }) } };
        const r = await promoTick(ss, d, { now: WED_1430, rand: () => 0 });
        expect(r.sent).toBe(true);
        expect(d.client.sendMessage).toHaveBeenCalledTimes(1);
        const [to, media] = d.client.sendMessage.mock.calls[0];
        expect(to).toBe('5493410000050@c.us');
        expect(media.mimetype).toBe('image/jpeg');
        const st = ss.userState['5493410000050@c.us'];
        expect(st.history.some(h => h.role === 'bot' && /flyer de la promo/.test(h.content))).toBe(true);
        expect(ss.logAndEmit).toHaveBeenCalledWith('5493410000050@c.us', 'bot', expect.stringMatching(/Imagen/), 'promo_offer');
    });

    test('si la imagen falla, el envío igual cuenta como hecho', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign());
        mockDb.promoRecipient.findFirst.mockResolvedValueOnce(recipient('5493410000051')).mockResolvedValueOnce(null);
        const d = { ...deps(true), client: { sendMessage: jest.fn().mockRejectedValue(new Error('media fail')) } };
        const r = await promoTick(shared(), d, { now: WED_1430, rand: () => 0 });
        expect(r.sent).toBe(true);
        expect(mockDb.promoRecipient.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'sent' }) }));
    });

    test('con imageEnabled=false no manda la imagen', async () => {
        mockDb.promoCampaign.findFirst.mockResolvedValue(campaign({ config: JSON.stringify({ ...cfg(), imageEnabled: false }) }));
        mockDb.promoRecipient.findFirst.mockResolvedValueOnce(recipient('5493410000052')).mockResolvedValueOnce(null);
        const d = { ...deps(true), client: { sendMessage: jest.fn() } };
        await promoTick(shared(), d, { now: WED_1430 });
        expect(d.client.sendMessage).not.toHaveBeenCalled();
    });
});
