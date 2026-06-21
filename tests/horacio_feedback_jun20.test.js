/**
 * Feedback del dueño sobre charlas reales (20-jun-2026):
 *  - 5491122475361: "Merlo libertad 1716" → el CP 1716 no se detectaba (lo tomaba
 *    como altura de calle) y la orden de retiro no se armaba.
 *  - 5493735508638: la clienta dijo "un momento / ya me desocupo y estoy con ud"
 *    y el bot la apuró con "falta nombre" → genera rechazo.
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
    logStepTransition: jest.fn(),
    markExit: jest.fn().mockResolvedValue(undefined),
    logMessage: jest.fn().mockResolvedValue(undefined),
}));

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const { handleWaitingData } = require('../src/flows/steps/stepWaitingData');

const baseState = (over = {}) => ({
    step: 'waiting_data',
    shippingChoice: 'retiro',
    paymentMethod: 'contrarembolso',
    selectedProduct: 'Cápsulas de nuez de la india',
    selectedPlan: '60',
    partialAddress: { calle: 'A sucursal' },
    cart: [],
    history: [],
    ...over,
});

// ════════════════════════════════════════════════════════════════════════════
// 1. CP pegado a la localidad — "Merlo libertad 1716" → CP 1716 (5491122475361)
// ════════════════════════════════════════════════════════════════════════════
describe('Retiro — CP embebido en "localidad + número"', () => {
    test('"Merlo libertad 1716" arma la orden con cp=1716 aunque el parser no lo extraiga', async () => {
        const sent = [];
        const deps = {
            sendMessageWithDelay: async (_id, m) => { sent.push(m); },
            saveState: jest.fn(),
            aiService: {},
            // El parser real tomaba "Libertad 1716" como calle y devolvía cp null:
            mockAiService: { parseAddress: async () => ({ ciudad: 'Merlo' }) },
        };
        const state = baseState({ partialAddress: { calle: 'A sucursal', nombre: 'Maria Jose Robledo', ciudad: 'Merlo' } });
        const text = 'Merlo libertad 1716';
        const res = await handleWaitingData('cp1@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        expect(state.pendingOrder).toBeTruthy();
        expect(state.pendingOrder.cp).toBe('1716');
        // El bot cierra la venta solo (jun-2026): retiro con datos completos → 'completed'.
        expect(state.step).toBe('completed');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. "Un momento" / "ya me desocupo" — aflojar, NO apurar (5493735508638)
// ════════════════════════════════════════════════════════════════════════════
describe('Waiting data — el cliente pide esperar', () => {
    test('"Ok, un momento, por favor" → afloja y NO re-pide datos', async () => {
        const sent = [];
        const deps = {
            sendMessageWithDelay: async (_id, m) => { sent.push(m); },
            saveState: jest.fn(),
            aiService: { parseAddress: async () => ({}) },
        };
        const state = baseState({ partialAddress: { calle: 'A sucursal', ciudad: 'Merlo' } }); // falta nombre
        const text = 'Ok, un momento, por favor';
        const res = await handleWaitingData('w1@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        expect(state.awaitingResume).toBe(true);
        const all = sent.join(' ').toLowerCase();
        expect(all).not.toMatch(/falta|nombre y apellido|me los pas/);
        expect(all).toMatch(/te espero|tranqui/);
    });

    test('"Sisi, un segundo, ya me desocupo, y estoy con ud" → afloja, no apura', async () => {
        const sent = [];
        const deps = { sendMessageWithDelay: async (_id, m) => { sent.push(m); }, saveState: jest.fn(), aiService: { parseAddress: async () => ({}) } };
        const state = baseState({ partialAddress: { calle: 'A sucursal', ciudad: 'Merlo' } });
        const text = 'Sisi, un segundo, ya me desocupo, y estoy con ud';
        const res = await handleWaitingData('w2@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        expect(state.awaitingResume).toBe(true);
        expect(sent.join(' ').toLowerCase()).not.toMatch(/falta|nombre y apellido/);
    });

    test('tras pedir esperar, "Ok, gracias, muy amable" NO dispara re-pedido de datos', async () => {
        const sent = [];
        const deps = { sendMessageWithDelay: async (_id, m) => { sent.push(m); }, saveState: jest.fn(), aiService: { parseAddress: async () => ({}) } };
        const state = baseState({ awaitingResume: true, partialAddress: { calle: 'A sucursal', ciudad: 'Merlo' } });
        const text = 'Ok, gracias, muy amable';
        const res = await handleWaitingData('w3@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        expect(sent.join(' ').toLowerCase()).not.toMatch(/falta|nombre y apellido|me los pas/);
    });

    test('un mensaje con datos reales SÍ retoma (limpia awaitingResume y arma orden)', async () => {
        const sent = [];
        const deps = {
            sendMessageWithDelay: async (_id, m) => { sent.push(m); },
            saveState: jest.fn(),
            aiService: {},
            mockAiService: { parseAddress: async () => ({ nombre: 'Maria Jose Robledo' }) },
        };
        const state = baseState({ awaitingResume: true, partialAddress: { calle: 'A sucursal', ciudad: 'Merlo', cp: '1716' } });
        const text = 'Maria Jose Robledo';
        const res = await handleWaitingData('w4@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        expect(state.awaitingResume).toBe(false);
        expect(state.pendingOrder).toBeTruthy();
        expect(state.pendingOrder.nombre).toBe('Maria Jose Robledo');
    });
});
