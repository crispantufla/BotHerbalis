/**
 * SIMULACIÓN V7 — replica secuencias reales de clientes (de las ventas que Horacio
 * cerró a mano) a través del flujo real del bot y verifica que el bot responda con
 * los patrones de Horacio que bajamos al guion: retiro-first, datos = solo nombre+CP,
 * demora diferenciada (prepago 6-7), descuento de junio, cierre cálido y asumido.
 *
 * La IA está mockeada (sin LLM): el happy-path V7 usa respuestas scripteadas, así que
 * no necesita el modelo. pricing.ts queda REAL → aplica el descuento de junio.
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
    logStepTransition: jest.fn().mockResolvedValue(undefined), markExit: jest.fn().mockResolvedValue(undefined), logMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: '', goalMet: false, extractedData: null }),
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

describe('SIM V7 — el bot vende como Horacio (retiro, +10kg, cápsulas)', () => {
    const uid = 'sim1@c.us';
    let rig;
    beforeAll(async () => {
        rig = makeRig();
        rig.userState[uid] = { step: 'greeting', history: [], partialAddress: {}, cart: [], lastMessage: null };
        await rig.say(uid, '¡Hola! Quiero más información');
        await rig.say(uid, 'mas de 10 kilos');
        await rig.say(uid, 'capsulas');
        await rig.say(uid, '120');
        await rig.say(uid, 'retiro en sucursal');
        aiService.parseAddress.mockResolvedValue({ nombre: 'Maria Jose Robledo', ciudad: 'Merlo', cp: '1716' });
        await rig.say(uid, 'Maria Jose Robledo, Merlo, 1716');
        // Imprimir el diálogo completo para comparar a ojo con Horacio
        const out = rig.transcript.map(t => `${t.who === 'CLIENTE' ? '👤 CLIENTE' : '🤖 BOT    '} | ${t.text.replace(/\n/g, ' ⏎ ')}`).join('\n');
        console.log('\n========== DIÁLOGO SIMULADO ==========\n' + out + '\n======================================\n');
    });

    test('todo el flujo produjo respuestas (no se cayó)', () => {
        expect(rig.transcript.filter(t => t.who === 'BOT').length).toBeGreaterThan(4);
    });

    test('menú de envío lidera con RETIRO y vende velocidad del prepago (6 a 7)', () => {
        const all = rig.transcript.map(t => t.text).join('\n');
        expect(all).toMatch(/Retiro en sucursal/i);
        expect(all).toMatch(/6 a 7 días/);
    });

    test('al elegir retiro pide SOLO localidad/CP — NO calle ni DNI ni teléfono', () => {
        const all = rig.transcript.map(t => t.text).join('\n').toLowerCase();
        expect(all).toMatch(/c[óo]digo postal|localidad/);
        expect(all).not.toMatch(/dni/);
        expect(all).not.toMatch(/n[úu]mero de tel[ée]fono/);
    });

    test('aplica el descuento de junio (cápsulas 120 = 52.900, no 62.900)', () => {
        const all = rig.transcript.map(t => t.text).join('\n');
        expect(all).toMatch(/52\.900/);
        expect(all).not.toMatch(/62\.900/);
    });

    test('cierra cálido y asumido (estilo Horacio), con la orden armada', () => {
        const all = rig.transcript.map(t => t.text).join('\n');
        expect(rig.userState[uid].pendingOrder).toBeTruthy();
        expect(all).toMatch(/en curso tu pedido|Ya queda en curso/i);
    });
});
