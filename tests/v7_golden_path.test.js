/**
 * V7 golden path — early funnel manejado por los step handlers.
 *
 * Cubre el tramo que ninguna otra suite testeaba tras retirar los tests V3:
 *   greeting → waiting_weight → waiting_preference → (menú de pago)
 * Es determinista: usa las rutas por número/keyword, así que NO depende de la IA
 * (el stub de aiService devuelve response:null para forzar el fallback scripted).
 * El tramo de pago en sí (retiro / domicilio / MP / transferencia) lo cubre
 * payment_flow.test.js.
 */

const path = require('path');
const fs = require('fs');

// Mocks de infra para que el require transitivo de salesFlow/steps no toque
// servicios reales (DB / MercadoPago) al importar.
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('mercadopago', () => ({
    MercadoPagoConfig: jest.fn(() => ({})),
    Preference: jest.fn(() => ({ create: jest.fn() })),
    Payment: jest.fn(() => ({ search: jest.fn() })),
}), { virtual: true });
jest.mock('../db', () => ({
    prisma: {
        order: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
        user: { upsert: jest.fn().mockResolvedValue({}) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    },
}));

const { handleGreeting } = require('../src/flows/steps/stepGreeting');
const { handleWaitingWeight } = require('../src/flows/steps/stepWaitingWeight');
const { handleWaitingPreference } = require('../src/flows/steps/stepWaitingPreference');

const v7 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v7.json'), 'utf8'));

function freshState() {
    return {
        step: 'greeting', history: [], cart: [], partialAddress: {},
        selectedProduct: null, selectedPlan: null, stepEnteredAt: Date.now(),
    };
}

function makeDeps() {
    const sent = [];
    const deps = {
        client: { sendMessage: jest.fn() },
        sendMessageWithDelay: jest.fn(async (_id, msg) => { sent.push(msg); }),
        saveState: jest.fn(),
        notifyAdmin: jest.fn(),
        // Stub: response:null fuerza el fallback scripted en todos los handlers.
        aiService: { chat: jest.fn().mockResolvedValue({ response: null, goalMet: false }) },
        sharedState: { pausedUsers: new Set(), io: null, config: { alertNumbers: [] } },
        config: { alertNumbers: [], scriptStats: {}, activeScript: 'v7' },
        effectiveScript: 'v7',
        logAndEmit: jest.fn(),
    };
    return { deps, sent };
}

describe('V7 golden path — greeting → weight → preference → menú de pago', () => {
    test('"hola" → avanza a waiting_weight', async () => {
        const { deps } = makeDeps();
        const state = freshState();
        await handleGreeting('gold1@c.us', 'hola', state, v7, deps);
        expect(state.step).toBe('waiting_weight');
    });

    test('"quiero bajar 8 kilos" → weightGoal=8, tier 1, pasa a waiting_preference', async () => {
        const { deps, sent } = makeDeps();
        const state = freshState();
        state.step = 'waiting_weight';
        await handleWaitingWeight('gold2@c.us', 'quiero bajar 8 kilos', 'quiero bajar 8 kilos', state, v7, deps);
        expect(state.weightGoal).toBe(8);
        expect(state.step).toBe('waiting_preference');
        expect(sent.length).toBeGreaterThan(0); // mandó recomendación + precios
    });

    test('"capsulas" → asigna Cápsulas plan 60 y dispara el menú de pago (waiting_payment_method)', async () => {
        const { deps, sent } = makeDeps();
        const state = freshState();
        state.step = 'waiting_preference';
        state.weightGoal = 8; // tier 1 → plan 60
        await handleWaitingPreference('gold3@c.us', 'capsulas', 'capsulas', state, v7, deps);

        expect(state.selectedProduct).toMatch(/Cápsulas/i);
        expect(state.selectedPlan).toBe('60');
        expect(state.step).toBe('waiting_payment_method');

        const allSent = sent.join(' \n ');
        expect(allSent).toMatch(/Retiro en sucursal/i);
        expect(allSent).toMatch(/Env[íi]o a domicilio/i);
    });

    test('+10 kg → tier 2 → plan 120 (upsell del tratamiento completo)', async () => {
        const { deps } = makeDeps();
        const state = freshState();
        state.step = 'waiting_preference';
        state.weightGoal = 18; // tier 2 → plan 120
        await handleWaitingPreference('gold4@c.us', 'capsulas', 'capsulas', state, v7, deps);
        expect(state.selectedPlan).toBe('120');
        expect(state.step).toBe('waiting_payment_method');
    });
});

describe('V7 — ya eligió producto + da el peso (reporte 5491168816042)', () => {
    function suggestedState() {
        const s = freshState();
        s.step = 'waiting_weight';
        s.suggestedProduct = 'Cápsulas de nuez de la india'; // dijo "me quedo con cápsulas" antes
        return s;
    }

    test('"mínimo 25 kilos" → extrae 25 (no 10), asigna Cápsulas 120 y va al pago', async () => {
        const { deps } = makeDeps();
        const state = suggestedState();
        const txt = 'Quiero bajar mucho mas de 10 kilos. Tengo sobrepeso minino 25 kilos';
        await handleWaitingWeight('w1@c.us', txt, txt.toLowerCase(), state, v7, deps);
        expect(state.weightGoal).toBe(25);              // no 10
        expect(state.selectedProduct).toMatch(/Cápsulas/i);
        expect(state.selectedPlan).toBe('120');         // tier 2 → 120
        expect(state.step).toBe('waiting_payment_method');
    });

    test('"más de 10" solo (sin segundo número) → tier 2 / plan 120', async () => {
        const { deps } = makeDeps();
        const state = suggestedState();
        const txt = 'quiero bajar mas de 10 kilos';
        await handleWaitingWeight('w3@c.us', txt, txt.toLowerCase(), state, v7, deps);
        expect(state.selectedPlan).toBe('120');
        expect(state.step).toBe('waiting_payment_method');
    });

    test('sin cue de piso, "bajar 8, tengo 45 años" → 8 (no 45)', async () => {
        const { deps } = makeDeps();
        const state = suggestedState();
        const txt = 'quiero bajar 8 kilos, tengo 45 años';
        await handleWaitingWeight('w2@c.us', txt, txt.toLowerCase(), state, v7, deps);
        expect(state.weightGoal).toBe(8);               // edad 45 NO se confunde con objetivo
        expect(state.selectedPlan).toBe('60');          // tier 1 → 60
    });
});
