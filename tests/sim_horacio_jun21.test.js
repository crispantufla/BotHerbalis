/**
 * SIMULACIÓN V7/V8 — replica secuencias reales de clientes a través del flujo real
 * del bot y verifica que responda con los patrones de Horacio que bajamos al guion:
 * datos mínimos, precios base, cierre cálido y asumido.
 *
 * Sep-2026 (modelo por zona): la publicidad apunta a Rosario y 60 km, así que
 * después del plan el bot pregunta la LOCALIDAD.
 *   - Cliente de Funes (zona)  → reparto propio, paga al recibir, el bot pide nombre +
 *     calle y CIERRA solo (orden Confirmado + aviso al admin).
 *   - Cliente de Merlo (fuera) → Correo prepago: ¿casa o sucursal? → medio de pago →
 *     alias. No hay cierre automático hasta verificar el pago.
 *
 * La IA está mockeada (sin LLM): el happy-path usa respuestas scripteadas, así que
 * no necesita el modelo. pricing.ts queda REAL → cotiza los precios de prices.json.
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
const { _getPrice } = require('../src/flows/utils/pricing');
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
    const dump = (title) => {
        const out = transcript.map(t => `${t.who === 'CLIENTE' ? '👤 CLIENTE' : '🤖 BOT    '} | ${t.text.replace(/\n/g, ' ⏎ ')}`).join('\n');
        console.log(`\n========== ${title} ==========\n` + out + '\n======================================\n');
    };
    const all = () => transcript.map(t => t.text).join('\n');
    return { say, userState, deps, transcript, dump, all };
}

describe('SIM — cliente de Funes (zona de reparto): el bot cierra solo, paga al recibir', () => {
    const uid = 'sim_funes@c.us';
    let rig;
    beforeAll(async () => {
        rig = makeRig();
        rig.userState[uid] = { step: 'greeting', history: [], partialAddress: {}, cart: [], lastMessage: null };
        await rig.say(uid, '¡Hola! Quiero más información');
        await rig.say(uid, 'mas de 10 kilos');
        await rig.say(uid, 'capsulas');
        await rig.say(uid, '120');
        await rig.say(uid, 'Funes');
        aiService.parseAddress.mockResolvedValue({ nombre: 'Maria Jose Robledo', calle: 'Mitre 1234' });
        await rig.say(uid, 'Maria Jose Robledo, Mitre 1234');
        rig.dump('DIÁLOGO SIMULADO — FUNES');
    });

    test('todo el flujo produjo respuestas (no se cayó)', () => {
        expect(rig.transcript.filter(t => t.who === 'BOT').length).toBeGreaterThan(4);
    });

    test('tras elegir el plan pregunta la localidad, sin menú de retiro/domicilio', () => {
        const afterPlan = rig.transcript.findIndex(t => t.who === 'CLIENTE' && t.text === '120');
        const botAfterPlan = rig.transcript.slice(afterPlan + 1).find(t => t.who === 'BOT').text;
        expect(botAfterPlan).toMatch(/de qué localidad sos/i);
        expect(botAfterPlan).not.toMatch(/retiro en sucursal|zona de influencia/i);
    });

    test('con la localidad en zona: reparto propio, paga al recibir, pide SOLO nombre + calle', () => {
        const afterLoc = rig.transcript.findIndex(t => t.who === 'CLIENTE' && t.text === 'Funes');
        const bot = rig.transcript.slice(afterLoc + 1).find(t => t.who === 'BOT').text;
        expect(bot).toMatch(/Funes/);
        expect(bot).toMatch(/reparto propio/i);
        expect(bot).toMatch(/al recibirlo/i);
        expect(bot).toMatch(/nombre completo/i);
        expect(bot).toMatch(/calle y número/i);
        expect(bot).not.toMatch(/c[óo]digo postal|dni|tel[ée]fono|Correo|sucursal|link de pago/i);
        expect(rig.deps.sharedState.pausedUsers.size).toBe(0);
    });

    test('cotiza el precio base de prices.json (cápsulas 120)', () => {
        expect(rig.all()).toContain(_getPrice('Cápsulas', '120'));
    });

    test('el bot CIERRA la venta solo: orden Confirmado con calle real y ciudad Funes, step completed', () => {
        expect(rig.userState[uid].pendingOrder).toBeTruthy();
        expect(rig.deps.saveOrderToLocal).toHaveBeenCalledTimes(1);
        const saved = rig.deps.saveOrderToLocal.mock.calls[0][0];
        expect(saved.status).toBe('Confirmado');
        expect(saved.paymentMethod).toBe('contrarembolso');
        expect(saved.calle).toBe('Mitre 1234');
        expect(saved.ciudad).toBe('Funes');
        expect(saved.precio).toContain(_getPrice('Cápsulas', '120'));
        expect(rig.userState[uid].step).toBe('completed');
        expect(rig.userState[uid].shippingChoice).toBe('reparto');
    });

    test('el mensaje de confirmación ES el cierre (en curso, sin pedir "sí") + avisa al admin del reparto', () => {
        const lastBot = rig.transcript.filter(t => t.who === 'BOT').slice(-1)[0].text;
        expect(lastBot).toMatch(/en curso/i);
        expect(lastBot).toMatch(/Reparto propio/);
        expect(lastBot).not.toMatch(/¿.*confirm/i);
        expect(rig.deps.notifyAdmin).toHaveBeenCalled();
        const calls = rig.deps.notifyAdmin.mock.calls.map(c => c.join(' ')).join(' ');
        expect(calls).toMatch(/venta cerrada/i);
        expect(calls).toMatch(/REPARTO PROPIO/);
    });
});

describe('SIM — cliente de Merlo (fuera de zona): Correo prepago, sin cierre automático', () => {
    const uid = 'sim_merlo@c.us';
    let rig;
    beforeAll(async () => {
        rig = makeRig();
        aiService.parseAddress.mockResolvedValue(null);
        rig.userState[uid] = { step: 'greeting', history: [], partialAddress: {}, cart: [], lastMessage: null };
        await rig.say(uid, '¡Hola! Quiero más información');
        await rig.say(uid, 'mas de 10 kilos');
        await rig.say(uid, 'capsulas');
        await rig.say(uid, '120');
        await rig.say(uid, 'Merlo, Buenos Aires');
        await rig.say(uid, 'retiro en sucursal');
        await rig.say(uid, 'transferencia');
        rig.dump('DIÁLOGO SIMULADO — MERLO');
    });

    test('fuera de zona: Correo Argentino sin costo, prepago, 4 días, ¿casa o sucursal?', () => {
        const afterLoc = rig.transcript.findIndex(t => t.who === 'CLIENTE' && t.text.startsWith('Merlo'));
        const bot = rig.transcript.slice(afterLoc + 1).find(t => t.who === 'BOT').text;
        expect(bot).toMatch(/Correo Argentino/);
        expect(bot).toMatch(/4 días hábiles/);
        expect(bot).toMatch(/tarjeta de crédito/i);
        expect(bot).toMatch(/transferencia/i);
        expect(bot).toMatch(/casa o en sucursal/i);
        expect(bot).not.toMatch(/reparto propio|al recibir|paq\.?ar/i);
        expect(rig.userState[uid].deliveryZone).toBe('out');
    });

    test('retiro en sucursal es PREPAGO: ofrece el medio, no pide efectivo ni pausa', () => {
        const afterRetiro = rig.transcript.findIndex(t => t.who === 'CLIENTE' && t.text === 'retiro en sucursal');
        const bot = rig.transcript.slice(afterRetiro + 1).find(t => t.who === 'BOT').text;
        expect(bot).toMatch(/sucursal/i);
        expect(bot).toMatch(/Tarjeta de cr[ée]dito/);
        expect(bot).toMatch(/Transferencia/);
        expect(bot).not.toMatch(/efectivo/i);
        expect(rig.deps.sharedState.pausedUsers.size).toBe(0);
    });

    test('con transferencia manda el alias y espera el "listo"; no hay orden todavía', () => {
        const lastBot = rig.transcript.filter(t => t.who === 'BOT').slice(-1)[0].text;
        expect(lastBot).toMatch(/HERBALIS\.TIENDA/);
        expect(rig.userState[uid].step).toBe('waiting_transfer_confirmation');
        expect(rig.userState[uid].shippingChoice).toBe('retiro');
        expect(rig.userState[uid].partialAddress.calle).toBe('A sucursal');
        expect(rig.deps.saveOrderToLocal).not.toHaveBeenCalled();
    });
});
