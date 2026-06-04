/**
 * V7 golden path — early funnel manejado por los step handlers.
 *
 * Cubre el tramo que ninguna otra suite testeaba tras retirar los tests V3:
 *   greeting → waiting_weight → waiting_preference → (elección de plan 60/120)
 * Rev. 2026-06-04: al elegir producto, preference_X muestra AMBOS planes (60 y
 * 120) y manda a waiting_plan_choice; el menú de pago llega recién tras elegir plan.
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

    test('peso en el saludo → NO manda pregunta de kilos ni presentación larga; pasa a preferencia', async () => {
        const { deps, sent } = makeDeps();
        const state = freshState();
        await handleGreeting('gold1b@c.us', 'Hola, quiero bajar 20 kilos', state, v7, deps);
        expect(state.step).toBe('waiting_preference');     // encadenó solo
        expect(state.weightGoal).toBe(20);
        const allSent = sent.join(' \n ');
        // "Hasta 10 kg" es único de la pregunta de kilos (1️⃣ Hasta 10 kg / 2️⃣ Más
        // de 10 kg). La recomendación sí puede decir "para más de 10 kg te
        // recomiendo 120 días", por eso solo chequeamos "Hasta 10 kg".
        expect(allSent).not.toMatch(/Hasta 10 kg/i);        // no re-preguntó kilos
        expect(allSent).not.toMatch(/contame cu[áa]nto te gustar[íi]a bajar/i); // no presentación con pregunta de kilos
        expect(allSent).not.toMatch(/Te ofrezco la Nuez de la India en tres opciones/i); // no presentación larga
    });

    test('"por ahora no puedo comprar, solo pregunté precio" → back-off + pausa, NO empuja productos', async () => {
        const { deps, sent } = makeDeps();
        const state = freshState();
        state.step = 'waiting_weight';
        const txt = 'Por ahora no puedo comprar, yo pregunté precio, gracias';
        const norm = txt.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        await handleWaitingWeight('decl1@c.us', txt, norm, state, v7, deps);
        expect(state.step).toBe('waiting_weight');                  // NO avanzó a preferencia
        expect(deps.sharedState.pausedUsers.has('decl1@c.us')).toBe(true);
        const allSent = sent.join(' \n ');
        expect(allSent).not.toMatch(/Pasemos directo a ver qu[ée] forma/i); // no empujó productos
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

    test('"capsulas" → asigna Cápsulas y muestra AMBOS planes (60 y 120) → waiting_plan_choice', async () => {
        const { deps, sent } = makeDeps();
        const state = freshState();
        state.step = 'waiting_preference';
        state.weightGoal = 8; // tier 1
        await handleWaitingPreference('gold3@c.us', 'capsulas', 'capsulas', state, v7, deps);

        expect(state.selectedProduct).toMatch(/Cápsulas/i);
        expect(state.step).toBe('waiting_plan_choice');

        const allSent = sent.join(' \n ');
        expect(allSent).toMatch(/60 d[íi]as/i);   // muestra el plan 60
        expect(allSent).toMatch(/120 d[íi]as/i);  // y el plan 120
        expect(allSent).toMatch(/¿Con cu[áa]l vas/i);
    });

    test('+10 kg → tier 2 → muestra ambos planes + upsell al 120 → waiting_plan_choice', async () => {
        const { deps, sent } = makeDeps();
        const state = freshState();
        state.step = 'waiting_preference';
        state.weightGoal = 18; // tier 2 → _maybeUpsell nudgea al 120
        await handleWaitingPreference('gold4@c.us', 'capsulas', 'capsulas', state, v7, deps);
        expect(state.step).toBe('waiting_plan_choice');
        const allSent = sent.join(' \n ');
        expect(allSent).toMatch(/120 d[íi]as/i);
        expect(allSent).toMatch(/recomendar[íi]a el de 120/i); // upsell de _maybeUpsell (peso>10)
    });
});

describe('V7 — ya eligió producto + da el peso (reporte 5491168816042)', () => {
    function suggestedState() {
        const s = freshState();
        s.step = 'waiting_weight';
        s.suggestedProduct = 'Cápsulas de nuez de la india'; // dijo "me quedo con cápsulas" antes
        return s;
    }

    test('"mínimo 25 kilos" → extrae 25 (no 10), asigna Cápsulas 120 (tentativo) → waiting_plan_choice', async () => {
        const { deps } = makeDeps();
        const state = suggestedState();
        const txt = 'Quiero bajar mucho mas de 10 kilos. Tengo sobrepeso minino 25 kilos';
        await handleWaitingWeight('w1@c.us', txt, txt.toLowerCase(), state, v7, deps);
        expect(state.weightGoal).toBe(25);              // no 10
        expect(state.selectedProduct).toMatch(/Cápsulas/i);
        expect(state.selectedPlan).toBe('120');         // tier 2 → 120 (plan tentativo)
        expect(state.step).toBe('waiting_plan_choice');
    });

    test('"más de 10" solo (sin segundo número) → tier 2 / plan 120 → waiting_plan_choice', async () => {
        const { deps } = makeDeps();
        const state = suggestedState();
        const txt = 'quiero bajar mas de 10 kilos';
        await handleWaitingWeight('w3@c.us', txt, txt.toLowerCase(), state, v7, deps);
        expect(state.selectedPlan).toBe('120');
        expect(state.step).toBe('waiting_plan_choice');
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
