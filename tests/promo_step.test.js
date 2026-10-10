/**
 * Campañas promo — el guion de quien contesta (step promo_offer, oct-2026).
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../src/services/funnelLogger');

const mockDb = {
    promoRecipient: { findFirst: jest.fn().mockResolvedValue({ id: 'r1', repliedAt: null }), update: jest.fn().mockResolvedValue({}) },
    user: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    chatLog: { create: jest.fn().mockResolvedValue({}) },
    order: { findFirst: jest.fn().mockResolvedValue(null) },
};
jest.mock('../db', () => ({ prisma: mockDb }));

const fs = require('fs');
const path = require('path');
const { processStep } = require('../src/flows/steps');
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v7.json'), 'utf8'));

const USER = '5493410000001@c.us';
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function promoState(over = {}) {
    return {
        step: 'promo_offer', history: [{ role: 'bot', content: 'Hola 👋 … promo …', timestamp: Date.now() - 3600000 }],
        cart: [], partialAddress: {}, summary: '',
        promo: { active: true, campaignId: 'c1', sentAt: Date.now() - 3600000, price60: '44.900', prevStep: 'waiting_plan_choice', outcome: null },
        ...over,
    };
}
function deps(aiResponse) {
    const sharedState = { sellerId: 'horacio', pausedUsers: new Set(), logAndEmit: jest.fn() };
    return {
        sendMessageWithDelay: jest.fn().mockResolvedValue(true),
        saveState: jest.fn(),
        notifyAdmin: jest.fn().mockResolvedValue(undefined),
        sharedState,
        sellerId: 'horacio',
        config: { mpEnabled: true },
        aiService: { chat: jest.fn().mockResolvedValue(aiResponse || { response: 'Respuesta IA', goalMet: false, extractedData: '' }) },
    };
}
const run = (text, state, d) => processStep(USER, text, norm(text), state, knowledge, d);
const sent = (d) => d.sendMessageWithDelay.mock.calls.map(c => c[1]);
const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => jest.clearAllMocks());

describe('promo_offer', () => {
    test('"PROMO" → pregunta la presentación con el precio promo, sin pedir kilos', async () => {
        const st = promoState(); const d = deps();
        const r = await run('PROMO', st, d);
        expect(r.matched).toBe(true);
        expect(st.step).toBe('promo_offer');
        expect(sent(d)).toHaveLength(1);
        expect(sent(d)[0]).toMatch(/44\.900/);
        expect(sent(d)[0]).toMatch(/Cápsulas[\s\S]*Gotas/);
        expect(sent(d)[0]).not.toMatch(/Semillas/); // la promo es solo cápsulas o gotas
        expect(sent(d)[0]).not.toMatch(/kilos/i);
        expect(st.promo.outcome).toBe('interested');
        expect(st.promo.repliedAt).toBeTruthy();
        await flush();
        expect(mockDb.promoRecipient.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome: 'interested' }) }));
    });

    test.each([
        ['cápsulas', 'Cápsulas de nuez de la india', '44.900'],
        ['2', 'Gotas de nuez de la india', '44.900'],
        ['las semillas', 'Semillas de nuez de la india', '36.900'],
    ])('"%s" → carrito del plan 60 a precio promo y menú de pago', async (text, product, price) => {
        const st = promoState(); const d = deps();
        await run(text, st, d);
        expect(st.step).toBe('waiting_payment_method');
        expect(st.selectedProduct).toBe(product);
        expect(st.selectedPlan).toBe('60');
        expect(st.cart).toEqual([{ product, plan: '60', price }]);
        expect(st.totalPrice).toBe(price);
        expect(sent(d)).toHaveLength(2);
        expect(sent(d)[0]).toMatch(new RegExp(price.replace('.', '\\.')));
        if (/semilla/i.test(product)) expect(sent(d)[0]).toMatch(/no entran en la promo/i); else expect(sent(d)[0]).toMatch(/precio promo/);
        expect(sent(d)[1]).toMatch(/Retiro en sucursal/i);
        expect(sent(d)[1]).toMatch(/domicilio/i);
    });

    test('"no gracias" → cierre cordial, pausa silenciosa (sin alerta al admin)', async () => {
        const st = promoState(); const d = deps();
        await run('no gracias', st, d);
        expect(sent(d)).toHaveLength(1);
        expect(sent(d)[0]).not.toMatch(/Disculp[aá] la molestia/);
        expect(d.sharedState.pausedUsers.has(USER)).toBe(true);
        expect(d.notifyAdmin).not.toHaveBeenCalled();
        expect(st.promo.outcome).toBe('declined');
        expect(st.promo.active).toBe(true); // el precio promo sigue valiendo si vuelve
    });

    test('"ya no quiero" no dispara la repregunta de cancelación del global', async () => {
        const { processGlobals } = require('../src/flows/globals');
        const st = promoState(); const d = deps();
        const g = await processGlobals(USER, 'ya no quiero', norm('ya no quiero'), st, knowledge, d);
        expect(g).toBeNull();
        expect(st.pendingCancelConfirm).toBeFalsy();
    });

    test('"no me escribas más" → queda excluido para siempre y pausado', async () => {
        const st = promoState(); const d = deps();
        await run('No me escribas más por favor', st, d);
        expect(st.promo.outcome).toBe('opted_out');
        expect(st.promo.active).toBe(false);
        expect(d.sharedState.pausedUsers.has(USER)).toBe(true);
        expect(d.notifyAdmin).not.toHaveBeenCalled();
        await flush();
        expect(mockDb.promoRecipient.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'opted_out', outcome: 'opted_out' }) }));
    });

    test('pregunta → la IA responde con el precio promo en el goal y sigue en promo_offer', async () => {
        const st = promoState(); const d = deps();
        await run('¿Cuánto tarda en llegar?', st, d);
        expect(d.aiService.chat).toHaveBeenCalledTimes(1);
        const ctx = d.aiService.chat.mock.calls[0][1];
        expect(ctx.step).toBe('promo_offer');
        expect(ctx.goal).toMatch(/\$44\.900/);
        expect(ctx.goal).toMatch(/NO cites el precio de lista/);
        expect(sent(d)).toEqual(['Respuesta IA']);
        expect(st.step).toBe('promo_offer');
        expect(d.sharedState.pausedUsers.has(USER)).toBe(false);
    });

    test('la IA extrae PRODUCTO → mismo cierre que la elección directa', async () => {
        const st = promoState(); const d = deps({ response: 'Dale, gotas entonces', goalMet: true, extractedData: 'PRODUCTO: Gotas' });
        await run('las gotas sirven para la panza?', st, d);
        expect(st.step).toBe('waiting_payment_method');
        expect(st.cart[0]).toEqual({ product: 'Gotas de nuez de la india', plan: '60', price: '44.900' });
        expect(sent(d)).toHaveLength(3); // IA + confirmación + menú de pago
    });

    test('IA caída → pausa con alerta al admin', async () => {
        const d = deps(); d.aiService.chat.mockRejectedValue(new Error('429'));
        const st = promoState();
        await run('¿y si no me hace efecto?', st, d);
        expect(d.sharedState.pausedUsers.has(USER)).toBe(true);
        expect(d.notifyAdmin).toHaveBeenCalled();
    });

    test('estado promo_offer sin promo (envío que falló) → vuelve al saludo', async () => {
        const st = promoState({ promo: null }); const d = deps();
        const r = await run('hola', st, d);
        expect(r.matched).toBe(false);
        expect(st.step).toBe('greeting');
    });
});

describe('el precio promo sobrevive al resto del flujo', () => {
    test('buildCartFromSelection cotiza plan 60 al promo solo con promo activa; el 120 no cambia', () => {
        const { buildCartFromSelection } = require('../src/flows/utils/cartHelpers');
        const promo = { promo: { active: true } };
        buildCartFromSelection('Cápsulas de nuez de la india', '60', promo);
        expect(promo.totalPrice).toBe('44.900');
        buildCartFromSelection('Cápsulas de nuez de la india', '120', promo);
        expect(promo.totalPrice).toBe('68.900');
        const plain = {};
        buildCartFromSelection('Cápsulas de nuez de la india', '60', plain);
        expect(plain.totalPrice).toBe('54.900');
    });
});
