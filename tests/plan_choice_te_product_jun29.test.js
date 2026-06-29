/**
 * Regresión (caso 5491131381951, seller horacio, 20-jun): el parser de
 * producto/plan en stepWaitingPlanChoice tenía el alternante `t[ée]` en el
 * matcher de Semillas. Sobre normalizedText (sin acentos) "té" == "te", así que
 * la palabra ubicua "te" ("te puedo pagar", "si te parece") seteaba
 * producto=Semillas. Combinado con el loop sin `break` (ganaba el último match),
 * pisaba la elección real de Cápsulas y generaba el link/cobro del producto
 * equivocado: la clienta dijo "Con tarjeta te puedo pagar 60 sale 49.900"
 * (Cápsulas $49.900) y el bot armó Semillas 60 = $36.900.
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../db', () => ({
    prisma: {
        user: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        order: { create: jest.fn().mockResolvedValue({ id: 'o1' }), findFirst: jest.fn().mockResolvedValue(null) },
    },
}));
jest.mock('../src/services/funnelLogger', () => ({
    logStepTransition: jest.fn(), markExit: jest.fn().mockResolvedValue(undefined), logMessage: jest.fn().mockResolvedValue(undefined),
}));

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const { handleWaitingPlanChoice } = require('../src/flows/steps/stepWaitingPlanChoice');
const { _getPrice } = require('../src/flows/utils/pricing');

const makeDeps = (aiChat) => {
    const sent = [];
    return {
        sent,
        sendMessageWithDelay: async (_id, m) => { sent.push(m); },
        saveState: jest.fn(),
        aiService: { chat: aiChat || jest.fn().mockResolvedValue({ goalMet: false, response: '¿Con cuál plan vas?', extractedData: '' }) },
        notifyAdmin: jest.fn().mockResolvedValue(undefined),
        sharedState: { pausedUsers: new Set(), io: null },
    };
};

const baseState = (over = {}) => ({
    step: 'waiting_plan_choice',
    weightGoal: 10,
    history: [],
    partialAddress: {},
    ...over,
});

const KNOW = { flow: {} }; // payment_menu ausente → buildPaymentMessage cae al fallback fijo

describe('stepWaitingPlanChoice — "te" NO debe interpretarse como Semillas', () => {

    test('"quiero las cápsulas de 60 si te parece" → Cápsulas (no Semillas por el "te")', async () => {
        const deps = makeDeps();
        const state = baseState();
        const txt = 'quiero las cápsulas de 60 si te parece';
        const res = await handleWaitingPlanChoice('te1@c.us', txt, norm(txt), state, KNOW, deps);

        expect(res.matched).toBe(true);
        expect(state.selectedProduct).toBe('Cápsulas');
        expect(state.cart).toHaveLength(1);
        expect(state.cart[0].product).toBe('Cápsulas');
        expect(state.cart[0].product).not.toBe('Semillas');
        expect(state.cart[0].price).toBe(_getPrice('Cápsulas', '60'));
        expect(state.cart[0].price).not.toBe('36.900'); // no es el precio de Semillas
        expect(state.step).toBe('waiting_payment_method');
    });

    test('mensaje exacto del caso: "Con tarjeta te puedo pagar 60 sale 49.900" → NUNCA arma cart de Semillas', async () => {
        const aiChat = jest.fn().mockResolvedValue({ goalMet: false, response: '¿Con cuál plan querés avanzar?', extractedData: '' });
        const deps = makeDeps(aiChat);
        const state = baseState({ selectedProduct: undefined, cart: undefined });
        const txt = 'Con tarjeta te puedo pagar 60 sale 49.900';
        const res = await handleWaitingPlanChoice('te2@c.us', txt, norm(txt), state, KNOW, deps);

        expect(res.matched).toBe(true);
        // Lo crítico: el "te" no debe haber generado un cart de Semillas antes de la IA.
        expect((state.cart || []).some(i => i.product === 'Semillas')).toBe(false);
        expect(state.selectedProduct).not.toBe('Semillas');
    });

    test('no rompimos la detección legítima: "quiero semillas de 60" → Semillas', async () => {
        const deps = makeDeps();
        const state = baseState();
        const txt = 'quiero semillas de 60';
        const res = await handleWaitingPlanChoice('te3@c.us', txt, norm(txt), state, KNOW, deps);

        expect(res.matched).toBe(true);
        expect(state.selectedProduct).toBe('Semillas');
        expect(state.cart[0].product).toBe('Semillas');
    });
});
