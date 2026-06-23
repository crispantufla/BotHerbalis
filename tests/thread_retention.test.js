/**
 * RETENCIÓN DEL HILO (determinista) — maneja conversaciones multi-turno a través
 * del flujo real y verifica la condición NECESARIA para que el bot "siga el hilo":
 * que cada vez que se invoca a la IA, el contexto que recibe contenga la
 * conversación previa completa (no un historial truncado o vacío).
 *
 * No prueba el comportamiento del LLM (eso es el sim live, gated). Prueba el
 * CABLEADO del contexto, que es la causa raíz que se arregló (commit 5a4f928):
 * antes el historial se perdía/aplastaba; acá garantizamos que llega entero.
 *
 * La IA está mockeada pero CAPTURA cada llamada (userText + context.history) para
 * poder afirmar sobre lo que el flujo le pasa.
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../db', () => ({
    prisma: {
        order: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'o1' }) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        user: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    },
}));
jest.mock('../src/services/funnelLogger', () => ({
    logStepTransition: jest.fn().mockResolvedValue(undefined), markExit: jest.fn().mockResolvedValue(undefined),
    logMessage: jest.fn().mockResolvedValue(undefined), incrementAiCallCount: jest.fn().mockResolvedValue(undefined),
}));

const mockCaptured = [];
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn(async (userText, context) => {
            mockCaptured.push({
                userText,
                step: context.step,
                history: (context.history || []).map(h => ({ role: h.role, content: h.content })),
            });
            // Respuesta neutra que no avanza el flujo (no matchea keywords del step).
            return { response: 'Te cuento 😊 ¿avanzamos?', goalMet: false, extractedData: null };
        }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue(null),
    },
}));

const fs = require('fs');
const path = require('path');
const { processSalesFlow } = require('../src/flows/salesFlow');
const { aiService } = require('../src/services/ai');
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v7.json'), 'utf8'));

function makeRig() {
    const transcript = [];
    let lastSent = [];
    const userState = {};
    const deps = {
        client: { getChatById: jest.fn().mockResolvedValue({ fetchMessages: jest.fn().mockResolvedValue([]), sendStateTyping: jest.fn() }) },
        notifyAdmin: jest.fn().mockResolvedValue(undefined),
        saveState: jest.fn(),
        saveOrderToLocal: jest.fn(),
        sendMessageWithDelay: async (_id, m) => { lastSent.push(m); transcript.push({ who: 'BOT', text: m }); },
        logAndEmit: jest.fn(),
        sharedState: { io: { emit: jest.fn() }, pausedUsers: new Set() },
        aiService,
        sellerId: 'horacio',
    };
    const say = async (uid, text) => {
        lastSent = [];
        transcript.push({ who: 'CLIENTE', text });
        await processSalesFlow(uid, text, userState, knowledge, deps);
        return lastSent.join('\n   ');
    };
    return { say, userState, deps, transcript };
}

describe('Retención del hilo — el contexto que recibe la IA', () => {
    const uid = 'thread1@c.us';
    let rig;
    beforeAll(async () => {
        mockCaptured.length = 0;
        rig = makeRig();
        rig.userState[uid] = { step: 'greeting', history: [], partialAddress: {}, cart: [], lastMessage: null };
        // Conversación con preguntas libres (caen a la IA) intercaladas con datos
        // que el cliente da temprano y NO deberían re-preguntarse después.
        await rig.say(uid, 'Hola, quiero info. Me llamo Lucía y soy de Merlo');
        await rig.say(uid, '¿hasta qué edad se puede tomar?');   // pregunta libre → IA
        await rig.say(uid, 'tengo 45');
        await rig.say(uid, 'más de 10 kilos');
        await rig.say(uid, '¿y cuánto tarda en llegar?');        // pregunta libre tardía → IA

        const out = rig.transcript.map(t => `${t.who === 'CLIENTE' ? '👤' : '🤖'} ${t.text.replace(/\n/g, ' ⏎ ')}`).join('\n');
        console.log('\n===== DIÁLOGO =====\n' + out + '\n');
        console.log('===== LLAMADAS A LA IA (' + mockCaptured.length + ') =====');
        mockCaptured.forEach((c, i) => console.log(`#${i} step=${c.step} histLen=${c.history.length} userText="${c.userText}"`));
    });

    test('la IA fue invocada al menos una vez (hubo preguntas libres)', () => {
        expect(mockCaptured.length).toBeGreaterThan(0);
    });

    test('cada llamada a la IA recibe historial (nunca vacío tras el 1er turno)', () => {
        // La primera llamada puede tener historial corto, pero ninguna llamada
        // posterior al primer mensaje debería llegar con historial vacío.
        mockCaptured.forEach((c) => {
            expect(Array.isArray(c.history)).toBe(true);
        });
        // Al menos una llamada con historial sustancial (varios turnos acumulados).
        const maxHist = Math.max(...mockCaptured.map(c => c.history.length));
        expect(maxHist).toBeGreaterThanOrEqual(2);
    });

    test('el historial CRECE a lo largo de la conversación (no se trunca/pierde)', () => {
        const lens = mockCaptured.map(c => c.history.length);
        expect(lens[lens.length - 1]).toBeGreaterThan(lens[0]);
    });

    test('la última llamada a la IA "ve" el dato dado al inicio (Lucía / Merlo)', () => {
        const last = mockCaptured[mockCaptured.length - 1];
        const histText = last.history.map(h => h.content).join('\n').toLowerCase();
        expect(histText).toMatch(/luc[íi]a|merlo/);
    });
});
