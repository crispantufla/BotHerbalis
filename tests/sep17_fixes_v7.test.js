/**
 * Arreglos de la revisión del 17-sep-2026 que no dependían del guion por zona,
 * traídos de vuelta al guion V7 después del revert (ver 85b1f98, donde estaban
 * junto con los del paso de zona). Cada test reproduce un caso real (el
 * teléfono está en el nombre).
 */

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../db', () => ({
    prisma: {
        order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
        user: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        paymentLink: { create: jest.fn(), findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    },
}));
jest.mock('../src/services/pauseService', () => ({
    pauseUser: jest.fn(async (userId, reason, { sharedState }) => { sharedState.pausedUsers.add(userId); }),
    unpauseUser: jest.fn(),
}));
jest.mock('../src/services/timeUtils', () => {
    const actual = jest.requireActual('../src/services/timeUtils');
    return { ...actual, isBusinessHours: () => true };
});

const mockParseAddress = jest.fn().mockResolvedValue({});
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: 'AI fallback', goalMet: false, extractedData: null }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: (...args) => mockParseAddress(...args),
    },
}));

const fs = require('fs');
const path = require('path');
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v7.json'), 'utf8'));

const { handleWaitingPlanChoice } = require('../src/flows/steps/stepWaitingPlanChoice');
const { handleWaitingPreference } = require('../src/flows/steps/stepWaitingPreference');
const { handleWaitingWeight } = require('../src/flows/steps/stepWaitingWeight');
const { detectObjection } = require('../src/flows/utils/objectionDetector');
const { _isGhostClose, _detectPostdatado } = require('../src/flows/utils/flowHelpers');
const { handleFaq } = require('../src/flows/globals/globalFaq');
const { checkAbandonedCarts } = require('../src/services/scheduler');
const { aiService } = require('../src/services/ai');
const { _getPrice } = require('../src/flows/utils/pricing');

// ─── Arnés ───────────────────────────────────────────────────────────────────
const sent = [];
const orders = [];
const pausedUsers = new Set();
const deps = {
    saveState: jest.fn(),
    sendMessageWithDelay: jest.fn(async (userId, msg) => { sent.push(msg); return true; }),
    notifyAdmin: jest.fn(async () => {}),
    saveOrderToLocal: jest.fn((o) => { orders.push(o); }),
    aiService,
    sellerId: 'vendedor_test',
    sharedState: { pausedUsers, io: null, saveState: jest.fn(), config: { alertNumbers: [] } },
    config: { alertNumbers: [] },
    logAndEmit: jest.fn(),
};
const USER = '5493410000002@c.us';
const lastSent = () => sent[sent.length - 1] || '';
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const RECOMMEND_120 = 'Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌';

function makeState(overrides = {}) {
    const price = _getPrice('Cápsulas', '120');
    return {
        step: 'waiting_plan_choice',
        history: [],
        cart: [{ product: 'Cápsulas', plan: '120', price }],
        selectedProduct: 'Cápsulas de nuez de la india',
        selectedPlan: '120',
        totalPrice: price,
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        ...overrides,
    };
}

beforeEach(() => {
    sent.length = 0; orders.length = 0; pausedUsers.clear();
    mockParseAddress.mockReset().mockResolvedValue({});
    aiService.chat.mockReset().mockResolvedValue({ response: 'AI fallback', goalMet: false, extractedData: null });
});

describe('scheduler — el nombre no parte el emoji del recordatorio', () => {
    test('"¡Hola, Acosta! 😊 ..." con el emoji entero (5493417504028)', async () => {
        const H = 3600 * 1000;
        const state = {
            step: 'waiting_data', cartRecovered: false, reengagementSent: false,
            lastActivityAt: Date.now() - 10 * H, userName: 'acosta veronica',
            history: [{ role: 'user', content: 'hola', timestamp: Date.now() - 10 * H }],
            partialAddress: { nombre: 'acosta veronica' },
        };
        const d = { sendMessageWithDelay: jest.fn().mockResolvedValue(true), saveState: jest.fn() };
        await checkAbandonedCarts({ userState: { [USER]: state }, pausedUsers: new Set() }, d);
        const msgs = d.sendMessageWithDelay.mock.calls.map((c) => c[1]);
        expect(msgs).toHaveLength(1);
        expect(msgs[0]).toMatch(/^¡?Hola, Acosta/);
        expect(msgs[0]).not.toMatch(/�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    });
});

describe('waiting_plan_choice — acuse y preguntas no son elegir el plan', () => {
    const planState = (history) => makeState({ step: 'waiting_plan_choice', cart: [], totalPrice: null, selectedPlan: null, history });

    test('"Ah bueno gracias" tras la recomendación del 120 → no arma el pedido (5493364210653)', async () => {
        const st = planState([{ role: 'bot', content: RECOMMEND_120, timestamp: 1 }]);
        await handleWaitingPlanChoice(USER, 'Ah bueno gracias', norm('Ah bueno gracias'), st, knowledge, deps);
        expect(st.step).toBe('waiting_plan_choice');
        expect(st.selectedPlan).toBeNull();
        expect(aiService.chat).toHaveBeenCalledTimes(1);
    });

    test('"Buenísimo" tras la recomendación sigue contando como sí (5493416188233)', async () => {
        const st = planState([{ role: 'bot', content: RECOMMEND_120, timestamp: 1 }]);
        await handleWaitingPlanChoice(USER, 'Buenísimo', norm('Buenísimo'), st, knowledge, deps);
        expect(st.selectedPlan).toBe('120');
        expect(st.step).not.toBe('waiting_plan_choice');
    });

    test('"Ese será dos meses ?" es una pregunta, no la elección del de 60 (5493400497043)', async () => {
        const st = planState([{ role: 'bot', content: '¡Perfecto, el de 60 días es ideal para probar! ¿Lo armamos?', timestamp: 1 }]);
        await handleWaitingPlanChoice(USER, 'Ese será dos meses ?', norm('Ese será dos meses ?'), st, knowledge, deps);
        expect(st.step).toBe('waiting_plan_choice');
        expect(st.selectedPlan).toBeNull();
        expect(aiService.chat).toHaveBeenCalledTimes(1);
    });

    test('"60ndias" pegado → elige el 60 sin IA (5493417504028)', async () => {
        const st = planState([]);
        await handleWaitingPlanChoice(USER, '60ndias', norm('60ndias'), st, knowledge, deps);
        expect(st.selectedPlan).toBe('60');
        expect(st.step).not.toBe('waiting_plan_choice');
        expect(aiService.chat).not.toHaveBeenCalled();
    });
});

describe('waiting_weight — preguntar el precio no es despedirse', () => {
    const weightState = (history = []) => ({ step: 'waiting_weight', history, partialAddress: {}, summary: '' });

    test('"Yo quería saber el precio de las botas" → NO pausa (5492657232296)', async () => {
        const st = weightState();
        const t = 'Yo quería saber el precio de las botas';
        await handleWaitingWeight(USER, t, norm(t), st, knowledge, deps);
        expect(pausedUsers.size).toBe(0);
        expect(lastSent()).not.toMatch(/que tengas un lindo día/i);
    });

    test('"solo quería saber el precio, gracias" después de darle el precio → sigue soltando', async () => {
        const st = weightState([{ role: 'bot', content: '$36.900 a $68.900 según el producto y plan 😊 ¿Cuántos kilos querés bajar?', timestamp: 1 }]);
        const t = 'solo quería saber el precio, gracias';
        await handleWaitingWeight(USER, t, norm(t), st, knowledge, deps);
        expect(pausedUsers.has(USER)).toBe(true);
    });

    test('"más d 10" es más de 10 → plan de 120 (5493364634777)', async () => {
        const st = weightState();
        await handleWaitingWeight(USER, 'más d 10', norm('más d 10'), st, knowledge, deps);
        expect(st.weightGoal).toBeGreaterThan(10);
        expect(aiService.chat.mock.calls[0][1].goal).toMatch(/plan de \*120 días\*/);
    });

    test('kilos + pregunta nombrando "pastillas" → la IA no pregunta y siguen los precios de cápsulas (5493413552069)', async () => {
        aiService.chat.mockResolvedValue({ response: '¡Qué bueno que se animen los dos! 💪', goalMet: false, extractedData: null });
        const st = weightState();
        const t = 'Más de 10 kilo tengo que bajar más de 40 quilos yo y mi marido que me conviene más pastillas!';
        await handleWaitingWeight(USER, t, norm(t), st, knowledge, deps);
        expect(aiService.chat).toHaveBeenCalledTimes(1);
        expect(aiService.chat.mock.calls[0][1].goal).toMatch(/NO termines con ninguna pregunta/);
        expect(st.selectedProduct).toMatch(/Cápsulas/);
        expect(st.step).toBe('waiting_plan_choice');
        expect(sent).toHaveLength(2);
        expect(lastSent()).toMatch(/cápsulas/i);
    });
});

describe('fecha contestando la oferta de agendar', () => {
    test('"después del 5" tras la oferta de agendar no es otra postergación (5493364634777)', () => {
        const st = makeState({ step: 'waiting_data', history: [{ role: 'bot', content: '¡No hace falta que esperes! 😊 Te lo agendamos. ¿A partir de qué día te queda cómodo recibirlo?', timestamp: 1 }] });
        expect(detectObjection('waiting_data', norm('después del 5'), st)).toBeNull();
    });

    test('sin oferta previa, "después del 5" sigue siendo una postergación para el detector', () => {
        const st = makeState({ step: 'waiting_data', history: [{ role: 'bot', content: 'Pasame tu nombre completo y dirección 🙌', timestamp: 1 }] });
        expect(detectObjection('waiting_data', norm('después del 5'), st)).not.toBeNull();
    });
});

describe('waiting_preference', () => {
    test('"Elegiría la opción 3" → semillas sin IA (5493424784464)', async () => {
        const st = makeState({ step: 'waiting_preference', selectedProduct: null, selectedPlan: null, cart: [], totalPrice: null, weightGoal: 17 });
        const t = 'Elegiría la opción 3';
        await handleWaitingPreference(USER, t, norm(t), st, knowledge, deps);
        expect(aiService.chat).not.toHaveBeenCalled();
        expect(st.selectedProduct).toMatch(/Semillas/);
        expect(sent[0]).toMatch(/las \*semillas\*/);
    });
});

describe('textos', () => {
    test('"ver si realmente nos sirve" ya no dispara "Sí, funciona y posta" (5493413552069)', async () => {
        const st = makeState({ step: 'waiting_preference' });
        const t = 'Para empezar yo y mi marido de menos días pará que me salga un poco más barato y ver si realmente nos sirve y probar ?';
        await handleFaq(USER, t, norm(t), st, knowledge, deps);
        expect(sent.join('\n')).not.toMatch(/funciona y posta/);
    });

    test('guard anti venta-fantasma: "cuando tengas todo listo" no es un cierre (5493549532731)', () => {
        expect(_isGhostClose('¡Perfecto! Acá voy a estar 😊 Cuando tengas todo listo me escribís y lo armamos.', 'waiting_plan_choice', false)).toBe(false);
        expect(_isGhostClose('¡Listo! Ya está todo listo, te llega el lunes', 'waiting_plan_choice', false)).toBe(true);
        expect(_isGhostClose('Todo listo 🙌 queda confirmado', 'waiting_data', false)).toBe(true);
    });

    test('"después del 5" solo es una fecha para _detectPostdatado', () => {
        expect(_detectPostdatado('despues del 5')).toBe('despues del 5');
    });
});
