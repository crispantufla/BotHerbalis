/**
 * Regresión 06-jun-2026 — todos los problemas detectados hoy en una sola corrida.
 *
 *  1. Falso "abuso" por modismos ("como un hijo de puta")        → 5491130735300
 *  2. Cápsulas presentadas como quemador de grasa                → guion
 *  3. Retiro en sucursal: datos capturados, no re-pedidos        → 5493405456106
 *  4. Submenú de pago: responde la duda, no entra en bucle       → 5491156581277
 *  5. Backstop global: nunca envía el mismo mensaje 2 veces       → sendMessageWithDelay
 */

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));

jest.mock('../db', () => ({
    prisma: {
        user: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        order: { create: jest.fn().mockResolvedValue({ id: 'o1' }), findFirst: jest.fn().mockResolvedValue(null) },
        paymentLink: { create: jest.fn().mockResolvedValue({ id: 'pl1' }), findUnique: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
    },
}));

// funnelLogger toca DB — lo silenciamos (best-effort en producción de todos modos).
jest.mock('../src/services/funnelLogger', () => ({
    logStepTransition: jest.fn(),
    markExit: jest.fn().mockResolvedValue(undefined),
    logMessage: jest.fn().mockResolvedValue(undefined),
}));

const fs = require('fs');
const path = require('path');

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const { handleSystemGlobals } = require('../src/flows/globals/globalSystem');
const { handleWaitingData } = require('../src/flows/steps/stepWaitingData');
const { handleWaitingPaymentMethod } = require('../src/flows/steps/stepWaitingPaymentMethod');
const { createBotHelpers } = require('../src/handlers/botHelpers');

// ════════════════════════════════════════════════════════════════════════════
// 1. FALSO ABUSO (5491130735300)
// ════════════════════════════════════════════════════════════════════════════
describe('1. Falso abuso por modismos', () => {
    const makeDeps = () => ({
        sendMessageWithDelay: jest.fn().mockResolvedValue(undefined),
        aiService: { chat: jest.fn().mockResolvedValue({ response: '', goalMet: false }) },
        saveState: jest.fn(),
        notifyAdmin: jest.fn().mockResolvedValue(undefined),
        sharedState: { pausedUsers: new Set(), io: null },
    });

    test('"como un hijo de puta" (intensificador) NO rechaza al comprador', async () => {
        const deps = makeDeps();
        const state = { step: 'waiting_preference', history: [] };
        const text = 'Dame esas cápsulas, como como un hijo de puta, necesito un quemador de grasa';
        const res = await handleSystemGlobals('u1@c.us', text, norm(text), state, deps);
        expect(state.step).not.toBe('rejected_abusive');
        expect(deps.sharedState.pausedUsers.size).toBe(0);
        // No matcheó como global de sistema (sigue el flujo normal de venta)
        expect(res === null || res === undefined || res.matched !== true).toBe(true);
    });

    test('"de puta madre" (expresión) NO rechaza', async () => {
        const deps = makeDeps();
        const state = { step: 'waiting_preference', history: [] };
        const text = 'Está de puta madre, gracias';
        await handleSystemGlobals('u2@c.us', text, norm(text), state, deps);
        expect(state.step).not.toBe('rejected_abusive');
    });

    test('abuso DIRIGIDO "sos un hijo de puta" SÍ rechaza', async () => {
        const deps = makeDeps();
        const state = { step: 'waiting_preference', history: [] };
        const text = 'sos un hijo de puta';
        const res = await handleSystemGlobals('u3@c.us', text, norm(text), state, deps);
        expect(res.matched).toBe(true);
        expect(state.step).toBe('rejected_abusive');
    });

    test('"son unos estafadores" SÍ rechaza', async () => {
        const deps = makeDeps();
        const state = { step: 'waiting_preference', history: [] };
        const text = 'son unos estafadores, me robaron';
        const res = await handleSystemGlobals('u4@c.us', text, norm(text), state, deps);
        expect(res.matched).toBe(true);
        expect(state.step).toBe('rejected_abusive');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. CÁPSULAS — cómo se presentan
//
// Este bloque comprobaba lo contrario: que la respuesta dijera "quemagrasa".
// Venía del guion argentino y en España ese claim es ilegal (Reglamento CE
// 1924/2006; presentar el complemento como adelgazante lo convierte en
// medicamento sin autorización, precedente AEMPS 13/2012 sobre este mismo
// producto). El test se invierte: ahora fija que NO aparezca, y que las
// cápsulas se sigan vendiendo por lo que sí se puede decir — la comodidad.
// ════════════════════════════════════════════════════════════════════════════
describe('2. Cápsulas — presentación conforme', () => {
    const knowledge = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v7.json'), 'utf8'));

    test('la respuesta de cápsulas NO usa claims prohibidos', () => {
        const resp = knowledge().flow.preference_capsulas.response;
        const { checkCompliance } = require('../src/services/compliance');
        expect(checkCompliance([resp])).toEqual([]);
    });

    test('sigue posicionando las cápsulas por su comodidad', () => {
        const resp = knowledge().flow.preference_capsulas.response.toLowerCase();
        expect(resp).toMatch(/c[óo]modo|una al d[íi]a/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. RETIRO: datos capturados y orden armada, sin re-pedir (5493405456106)
// ════════════════════════════════════════════════════════════════════════════
describe('3. Retiro en sucursal — captura de datos', () => {
    test('bloque de datos (con pregunta pegada) → arma la orden y NO re-pide', async () => {
        const sent = [];
        const deps = {
            sendMessageWithDelay: async (_id, m) => { sent.push(m); },
            saveState: jest.fn(),
            aiService: {},
            mockAiService: { parseAddress: async () => ({ nombre: 'Regina B. Bode', ciudad: 'Helvecia', cp: '3003' }) },
        };
        const state = {
            step: 'waiting_data', shippingChoice: 'retiro', paymentMethod: 'contrarembolso',
            selectedProduct: 'Cápsulas de nuez de la india', selectedPlan: '120',
            partialAddress: { calle: 'A oficina de Correos' }, cart: [], history: [],
        };
        const text = 'Regina B. Bode\nCiudad: Helvecia.\nCodigo P. 3003\nSucursal correo: San Martin 555\nNecesitas algo mas?';
        const res = await handleWaitingData('r1@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        // El bot cierra la venta solo (jun-2026): retiro con datos completos → 'completed'.
        expect(state.step).toBe('completed');
        expect(state.pendingOrder).toBeTruthy();
        expect(state.pendingOrder.nombre).toBe('Regina B. Bode');
        expect(state.pendingOrder.calle).toBe('A oficina de Correos');
        expect(state.pendingOrder.cp).toBe('3003');
        // No volvió a pedir "dirección/calle"
        const all = sent.join(' ').toLowerCase();
        expect(all).not.toContain('a qué dirección');
        expect(all).not.toMatch(/calle y n[uú]mero/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. BACKSTOP GLOBAL — nunca el mismo mensaje 2 veces (sendMessageWithDelay)
// ════════════════════════════════════════════════════════════════════════════
describe('5. Anti-duplicado global', () => {
    const makeHelpers = () => {
        const client = {
            sendMessage: jest.fn().mockResolvedValue(undefined),
            getChatById: jest.fn().mockResolvedValue({ sendStateTyping: jest.fn() }),
        };
        const ctx = {
            sellerId: 'test', sharedState: { io: null, config: {} }, client,
            userState: {}, config: { alertNumbers: [], globalPause: false },
            pausedUsers: new Set(), redlock: {},
        };
        return { helpers: createBotHelpers(ctx), client };
    };
    const past = () => Date.now() - 20000; // startTime viejo → sin delay

    test('mismo texto consecutivo → se envía UNA sola vez', async () => {
        const { helpers, client } = makeHelpers();
        await helpers.sendMessageWithDelay('c1@c.us', 'Hola, ¿cómo querés abonar?', past());
        await helpers.sendMessageWithDelay('c1@c.us', 'Hola, ¿cómo querés abonar?', past());
        await helpers.sendMessageWithDelay('c1@c.us', 'Hola, ¿cómo querés abonar?', past());
        expect(client.sendMessage).toHaveBeenCalledTimes(1);
    });

    test('textos distintos → se envían todos', async () => {
        const { helpers, client } = makeHelpers();
        await helpers.sendMessageWithDelay('c2@c.us', 'Mensaje A', past());
        await helpers.sendMessageWithDelay('c2@c.us', 'Mensaje B', past());
        expect(client.sendMessage).toHaveBeenCalledTimes(2);
    });

    test('mismo texto pero a chats distintos → se envía a cada uno', async () => {
        const { helpers, client } = makeHelpers();
        await helpers.sendMessageWithDelay('c3@c.us', 'Igual', past());
        await helpers.sendMessageWithDelay('c4@c.us', 'Igual', past());
        expect(client.sendMessage).toHaveBeenCalledTimes(2);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. El motivo de la pausa queda registrado en el historial (auditable)
// ════════════════════════════════════════════════════════════════════════════
describe('6. Motivo de pausa registrado en el historial', () => {
    const { _pauseAndAlert } = require('../src/flows/utils/flowHelpers');

    test('_pauseAndAlert escribe un registro "system" con el motivo', async () => {
        const logAndEmit = jest.fn();
        const deps = {
            notifyAdmin: jest.fn().mockResolvedValue(undefined),
            saveState: jest.fn(),
            sendMessageWithDelay: jest.fn().mockResolvedValue(undefined),
            sharedState: { pausedUsers: new Set(), io: null },
            logAndEmit,
        };
        const state = { step: 'waiting_payment_method', history: [] };
        await _pauseAndAlert('z1@c.us', state, deps, 'mensaje del cliente', 'Motivo de prueba XYZ');
        const sysCall = logAndEmit.mock.calls.find(([, role]) => role === 'system');
        expect(sysCall).toBeTruthy();
        expect(sysCall[2]).toContain('Motivo de prueba XYZ');
    });
});
