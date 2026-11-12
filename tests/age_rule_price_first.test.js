/**
 * Caso del 12-nov-2026, clienta de 73 años que llegó por un anuncio:
 *   1. "¿Cuánto cuesta la cápsula?" → el bot le preguntó los kilos en vez del precio.
 *   2. "Hasta 10k. Pero quiero saber el precio. Tengo 73 años" → tabla con los
 *      tres productos, contra la regla del dueño (70 a 79 años: solo gotas).
 *   3. "Capsulas" → "¡Genial, las cápsulas!" con el plan de 120 días empujado.
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../sheets_sync', () => ({ appendOrderToSheet: jest.fn() }), { virtual: true });
jest.mock('../db', () => ({
    prisma: {
        order: { findFirst: jest.fn().mockResolvedValue(null) },
        chatLog: { findMany: jest.fn().mockResolvedValue([]) },
        user: { upsert: jest.fn().mockResolvedValue({}) },
    },
}));
jest.mock('../src/services/pauseService', () => ({
    pauseUser: jest.fn(async (userId, _reason, { sharedState }) => { sharedState.pausedUsers.add(userId); }),
    unpauseUser: jest.fn(),
}));
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: 'RESPUESTA IA', goalMet: false, extractedData: null }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue(null),
    },
}));

const knowledge = require('../knowledge_v7.json');
const { processSalesFlow } = require('../src/flows/salesFlow');
const { handleAgeRule } = require('../src/flows/globals/globalAge');
const { aiService } = require('../src/services/ai');
const { _getPrice } = require('../src/flows/utils/pricing');
const { _buildStateContext } = require('../src/services/aiPrompts');

const USER = '5493410000003@c.us';
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function harness() {
    const sent = [];
    const pausedUsers = new Set();
    const deps = {
        client: undefined,
        notifyAdmin: jest.fn().mockResolvedValue(undefined),
        saveState: jest.fn(),
        sendMessageWithDelay: jest.fn(async (_id, msg) => { sent.push(msg); return true; }),
        logAndEmit: jest.fn(),
        sharedState: { io: { emit: jest.fn(), to: () => ({ emit: jest.fn() }) }, pausedUsers, sellerId: 'horacio', config: {} },
        config: {},
        sellerId: 'horacio',
        aiService,
    };
    return { sent, pausedUsers, deps, userState: {} };
}

beforeEach(() => aiService.chat.mockClear());

describe('precio primero', () => {
    test('"¿Cuánto cuesta la cápsula?" recibe la lista de precios, sin pasar por la IA ni preguntar kilos', async () => {
        const h = harness();
        await processSalesFlow(USER, '¿Cuánto cuesta la cápsula?', h.userState, knowledge, h.deps);
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/Soy Elena de Herbalis/);
        expect(h.sent[0]).toContain(`$${_getPrice('Cápsulas', '60')}`);
        expect(h.sent[0]).not.toMatch(/cu[aá]ntos kilos/i);
        expect(h.userState[USER].step).toBe('waiting_preference');
        expect(aiService.chat).not.toHaveBeenCalled();
    });
});

describe('regla de edad: 70 a 79 años, solo gotas', () => {
    test('la charla real: dice 73 años → solo gotas; pide cápsulas → se le explica y sigue en gotas', async () => {
        const h = harness();
        await processSalesFlow(USER, '¿Cuánto cuesta la cápsula?', h.userState, knowledge, h.deps);
        await processSalesFlow(USER, 'Hasta 10k.  Pero quiero saber el precio.  Tengo 73 años', h.userState, knowledge, h.deps);
        const st = h.userState[USER];
        expect(st.clientAge).toBe(73);
        expect(st.weightGoal).toBe(10);
        expect(st.selectedProduct).toMatch(/Gotas/);
        expect(st.selectedPlan).toBe('60');
        expect(st.step).toBe('waiting_plan_choice');
        expect(h.sent[1]).toMatch(/Con 73 años te recomiendo las \*gotas\*/);
        expect(h.sent[1]).toContain(`$${_getPrice('Gotas', '60')}`);
        expect(h.sent[1]).not.toMatch(/C[aá]psulas|Semillas/);

        await processSalesFlow(USER, 'Capsulas', h.userState, knowledge, h.deps);
        expect(h.sent[2]).toMatch(/Después de los 70 no indicamos las cápsulas/);
        expect(h.sent.join(' ')).not.toMatch(/Genial, las \*cápsulas\*/);
        expect(st.selectedProduct).toMatch(/Gotas/);
        expect(h.pausedUsers.size).toBe(0);
    });

    test('con la edad ya dicha, una duda la contesta la IA y recibe la regla en el contexto', async () => {
        const state = { step: 'waiting_plan_choice', history: [], clientAge: 73, selectedProduct: 'Gotas de nuez de la india', cart: [] };
        const h = harness();
        const res = await handleAgeRule(USER, '¿y me puede hacer mal?', norm('¿y me puede hacer mal?'), state, knowledge, h.deps);
        expect(res).toBeNull();
        expect(h.sent).toEqual([]);
        expect(_buildStateContext({ userState: state, step: 'waiting_plan_choice' })).toMatch(/EDAD DEL CLIENTE: 73 años → SOLO GOTAS/);
    });

    test.each([
        ['Tengo 73 años', 73], ['tengo 71', 71], ['mi mamá tiene 78 años', 78],
    ])('"%s" guarda la edad', async (text, age) => {
        const state = { step: 'waiting_preference', history: [], cart: [] };
        await handleAgeRule(USER, text, norm(text), state, knowledge, harness().deps);
        expect(state.clientAge).toBe(age);
    });

    test.each(['tengo 73 kilos de más', 'hace 13 años que venden', 'tengo 45 años', 'peso 75'])(
        '"%s" no dispara la regla', async (text) => {
            const state = { step: 'waiting_preference', history: [], cart: [] };
            const h = harness();
            expect(await handleAgeRule(USER, text, norm(text), state, knowledge, h.deps)).toBeNull();
            expect(state.clientAge).toBeUndefined();
            expect(h.sent).toEqual([]);
        });

    test('dice la edad con cápsulas ya elegidas y el pedido avanzado → pausa para revisión humana', async () => {
        const state = { step: 'waiting_data', history: [], selectedProduct: 'Cápsulas de nuez de la india', cart: [{ product: 'Cápsulas de nuez de la india', plan: '60', price: '47.000' }] };
        const h = harness();
        const res = await handleAgeRule(USER, 'tengo 74 años, ¿no hay problema?', norm('tengo 74 años, ¿no hay problema?'), state, knowledge, h.deps);
        expect(res).toEqual({ matched: true });
        expect(h.pausedUsers.has(USER)).toBe(true);
    });

    test('no toca a quien conversa por una campaña', async () => {
        const state = { step: 'waiting_preference', history: [], promo: { active: true }, cart: [] };
        const h = harness();
        expect(await handleAgeRule(USER, 'Tengo 73 años', norm('Tengo 73 años'), state, knowledge, h.deps)).toBeNull();
        expect(h.sent).toEqual([]);
    });
});

describe('plan sugerido según los kilos', () => {
    test('quien dijo hasta 10 kg y elige cápsulas no recibe "el de 120 es el que más eligen"', async () => {
        const h = harness();
        await processSalesFlow(USER, '¿Cuánto cuesta la cápsula?', h.userState, knowledge, h.deps);
        await processSalesFlow(USER, 'hasta 10 kilos, las capsulas', h.userState, knowledge, h.deps);
        const last = h.sent[h.sent.length - 1];
        expect(last).toMatch(/Genial, las \*cápsulas\*/);
        expect(last).toMatch(/con el de \*60 días\* te alcanza/);
        expect(last).not.toMatch(/el que más eligen/);
        expect(h.userState[USER].selectedPlan).toBe('60');
    });

    test('sin kilos dichos, el texto del guion queda igual', async () => {
        const h = harness();
        await processSalesFlow(USER, '¿Cuánto cuesta la cápsula?', h.userState, knowledge, h.deps);
        await processSalesFlow(USER, 'capsulas', h.userState, knowledge, h.deps);
        expect(h.sent[h.sent.length - 1]).toMatch(/el que más eligen/);
    });
});
