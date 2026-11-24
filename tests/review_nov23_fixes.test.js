/**
 * Fallos que marcaron los reportes diarios del 19 al 23-nov-2026 y la lectura a
 * mano de las charlas de esos días:
 *   1. La lista de precios salía a cualquier cosa ("Gracias por responderme",
 *      "me equivoqué", un link de Temu) y el saludo con IA preguntaba los kilos.
 *   2. La localidad dicha de pasada no se guardaba y la respuesta fija de pago
 *      se repitió tres veces preguntando "¿De qué localidad sos?".
 *   3. Quien avisó que compra más adelante recibía otro pedido de nombre y calle.
 *   4. "Tengo 79 años, ¿consulto a mi médico?" recibía la objeción "lo consulto".
 *   5. "Hoy me llegaron las gotas" se leía como elección de producto.
 *   6. Un texto fijo decía "el bot lo despacha".
 *   7. El reporte listaba como "sin respuesta" charlas que tenían respuesta.
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
// incomingSteps abre la conexión de Redis al cargarse: sin esto jest no termina.
jest.mock('../src/services/queueService', () => ({ redisConnection: { get: jest.fn(), set: jest.fn(), del: jest.fn() } }));
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn(),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue(null),
        anthropic: null,
    },
}));

const fs = require('fs');
const path = require('path');
const knowledge = require('../knowledge_v7.json');
const { processSalesFlow } = require('../src/flows/salesFlow');
const { handleWaitingWeight } = require('../src/flows/steps/stepWaitingWeight');
const { handleWaitingData } = require('../src/flows/steps/stepWaitingData');
const { handleFaq } = require('../src/flows/globals/globalFaq');
const { handleExistingCustomer } = require('../src/flows/globals/globalExistingCustomer');
const { rememberZoneFromMessage } = require('../src/flows/utils/deliveryZone');
const { buildTranscript, runNightlyReview } = require('../src/services/nightlyReview');
const { aiService } = require('../src/services/ai');

const USER = '5493410000023@c.us';
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// El sendMessageWithDelay real anota en el history lo que salió; acá igual.
function harness(initial) {
    const sent = [];
    const pausedUsers = new Set();
    const userState = initial ? { [USER]: initial } : {};
    const deps = {
        client: undefined,
        notifyAdmin: jest.fn().mockResolvedValue(undefined),
        saveState: jest.fn(),
        sendMessageWithDelay: jest.fn(async (id, msg) => {
            sent.push(msg);
            const st = userState[id];
            if (st) { st.history = st.history || []; st.history.push({ role: 'bot', content: msg }); }
            return true;
        }),
        logAndEmit: jest.fn(),
        sharedState: { io: { emit: jest.fn(), to: () => ({ emit: jest.fn() }) }, pausedUsers, sellerId: 'horacio', config: {} },
        config: {},
        sellerId: 'horacio',
        aiService,
    };
    return { sent, pausedUsers, deps, userState };
}
const say = (h, text, extra = {}) => processSalesFlow(USER, text, h.userState, knowledge, { ...h.deps, ...extra });

beforeEach(() => {
    aiService.chat.mockReset().mockResolvedValue({ response: 'RESPUESTA IA. Te paso los precios 👇', goalMet: false, extractedData: null });
});

// ── 1. Lista de precios ──────────────────────────────────────────────────────
describe('la lista de precios solo cuando corresponde', () => {
    async function afterGreeting(text) {
        const sent = [];
        const state = { step: 'waiting_weight', history: [{ role: 'bot', content: '¿Te paso los precios? 😊' }], cart: [] };
        const deps = {
            sendMessageWithDelay: jest.fn(async (_id, m) => { sent.push(m); return true; }),
            saveState: jest.fn(), aiService, config: {}, sharedState: { pausedUsers: new Set(), config: {} },
        };
        const res = await handleWaitingWeight(USER, text, norm(text), state, knowledge, deps);
        return { sent, state, res };
    }

    test.each(['Noooo...gracias.me equivoqué 🙏🏾🙏🏾', 'No gracias', 'no me interesa', 'Perdón, número equivocado'])(
        '"%s" → se despide, sin lista y sin recordatorio', async (text) => {
            const { sent, state, res } = await afterGreeting(text);
            expect(res).toEqual({ matched: true });
            expect(sent).toHaveLength(1);
            expect(sent[0]).not.toMatch(/Estos son los precios/);
            expect(sent[0]).toMatch(/no pasa nada/);
            expect(state.cartRecovered).toBe(true);
            expect(state.step).toBe('waiting_weight');
            expect(aiService.chat).not.toHaveBeenCalled();
        });

    test.each(['Gracias por respondermé.', 'Muchas gracias', 'gracias 🙏'])(
        '"%s" → agradece: se ofrece la lista, no se manda', async (text) => {
            const { sent, state } = await afterGreeting(text);
            expect(sent).toEqual(['¡De nada! 😊 ¿Te paso los precios así los vas mirando?']);
            expect(state.step).toBe('waiting_weight');
        });

    test('un enlace suelto (invitación de Temu) no recibe nada', async () => {
        const { sent, state, res } = await afterGreeting('🎉¡Acepta mi invitación y obtén obsequios!🎉 https://temu.com/s/WpfqWqKVwBKOWlH');
        expect(res).toEqual({ matched: true });
        expect(sent).toEqual([]);
        expect(state.step).toBe('waiting_weight');
    });

    test.each(['Si', 'dale', 'Buen dia', 'gracias, pasame los precios', 'no gracias, solo el precio de las semillas'])(
        '"%s" → sigue recibiendo los precios', async (text) => {
            const { sent } = await afterGreeting(text);
            expect(sent.join('\n')).toMatch(/Estos son los precios|semillas/i);
        });

    test('saludo: "¿Cuánto cuesta la cápsula? yk contiene" → la IA contesta la duda y después va la lista (sin kilos)', async () => {
        const h = harness();
        await say(h, '¿Cuánto cuesta la cápsula? yk contiene');
        expect(aiService.chat).toHaveBeenCalledTimes(1);
        const goal = aiService.chat.mock.calls[0][1].goal;
        expect(goal).toMatch(/NO escribas precios/);
        expect(goal).toMatch(/NO preguntes cuántos kilos/);
        expect(h.sent).toHaveLength(2);
        expect(h.sent[0]).toMatch(/RESPUESTA IA/);
        expect(h.sent[1]).toMatch(/Estos son los precios/);
        expect(h.userState[USER].step).toBe('waiting_preference');
    });

    test('saludo: precio + diabetes → no contesta la FAQ sola: IA + lista de precios', async () => {
        const h = harness();
        await say(h, '¿Cuánto cuestan las gotas de Herbalis? Tengo diabetes tipo II podría tomarlas ? Gracias');
        expect(h.sent).toHaveLength(2);
        expect(h.sent[0]).toMatch(/RESPUESTA IA/);
        expect(h.sent[0]).not.toMatch(/Un montón de gente con esas condiciones/);
        expect(h.sent[1]).toMatch(/Estos son los precios/);
        expect(h.userState[USER].step).toBe('waiting_preference');
    });

    test('saludo: si la IA falla, igual hay respuesta (saludo del guion)', async () => {
        aiService.chat.mockRejectedValue(new Error('sin saldo'));
        const h = harness();
        await say(h, '¿Cuánto cuesta la cápsula? yk contiene');
        expect(h.sent.length).toBeGreaterThanOrEqual(1);
        expect(h.pausedUsers.size).toBe(0);
    });
});

// ── 2. Localidad ─────────────────────────────────────────────────────────────
describe('la localidad dicha de pasada queda anotada', () => {
    const st = (o = {}) => ({ step: 'waiting_preference', history: [], ...o });

    test('"SOY DE Rosario" mientras elige producto', () => {
        const s = st();
        expect(rememberZoneFromMessage('SOY DE Rosario', s, knowledge)).toBe(true);
        expect(s.deliveryZone).toBe('in');
        expect(s.partialAddress.ciudad).toBe('Rosario');
    });

    test('"Rosario zona oeste" a secas vale si el bot venía hablando de la zona', () => {
        const s = st({ history: [{ role: 'bot', content: 'Depende de dónde estés… ¿De qué localidad sos?' }] });
        expect(rememberZoneFromMessage('Rosario zona oeste', s, knowledge)).toBe(true);
        expect(s.deliveryZone).toBe('in');
    });

    test('fuera de zona también se anota', () => {
        const s = st();
        expect(rememberZoneFromMessage('soy de Córdoba capital', s, knowledge)).toBe(true);
        expect(s.deliveryZone).toBe('out');
    });

    test.each([
        ['¿Son de Rosario?', [{ role: 'bot', content: 'Distribuimos desde Rosario' }]],
        ['Rosario', [{ role: 'bot', content: '¿Con cuál querés arrancar?' }]],     // el bot no hablaba de la zona
        ['a 40 km de Rosario', [{ role: 'bot', content: '¿De qué localidad sos?' }]],
        ['Marta Pérez', [{ role: 'bot', content: 'Pasame tu nombre' }]],
    ])('"%s" no se toma como su localidad', (text, history) => {
        const s = st({ history });
        expect(rememberZoneFromMessage(text, s, knowledge)).toBe(false);
        expect(s.deliveryZone).toBeUndefined();
    });

    test('no pisa una zona ya resuelta ni actúa después del paso de localidad', () => {
        expect(rememberZoneFromMessage('soy de Córdoba', st({ deliveryZone: 'in' }), knowledge)).toBe(false);
        expect(rememberZoneFromMessage('soy de Rosario', st({ step: 'waiting_data' }), knowledge)).toBe(false);
    });

    test('la charla real: dice que es de Rosario y pregunta dos veces por las cuotas → la respuesta fija de pago no sale', async () => {
        const h = harness({ step: 'waiting_preference', history: [], cart: [] });
        await say(h, 'La forma de pago es de contado ?');
        expect(h.sent[0]).toMatch(/Depende de la zona/);              // todavía no sabemos de dónde es
        await say(h, 'SOY DE Rosario');
        expect(h.userState[USER].deliveryZone).toBe('in');
        const before = h.sent.length;
        await say(h, 'Me refiero si se puede pagar en dos o tres pagos con tarjeta');
        await say(h, 'Me refiero si se puede pagar en dos o tres pagos con tarjeta');
        const after = h.sent.slice(before);
        expect(after.join('\n')).not.toMatch(/Depende de la zona/);
        expect(after.join('\n')).not.toMatch(/¿De qué localidad sos\?/);
        expect(h.sent.filter((m) => /Depende de la zona/.test(m))).toHaveLength(1);
    });

    test('la respuesta fija no se repite aunque no sepamos la zona', async () => {
        const state = { step: 'waiting_preference', cart: [], history: [
            { role: 'bot', content: knowledge.faq.find((f) => (f.keywords || []).includes('forma de pago')).response },
            { role: 'user', content: 'otra cosa' },
            { role: 'bot', content: 'Otra respuesta' },
        ] };
        const sent = [];
        const deps = { sendMessageWithDelay: jest.fn(async (_i, m) => { sent.push(m); return true; }), saveState: jest.fn(), config: {} };
        const text = '¿Se puede pagar en cuotas?';
        expect(await handleFaq(USER, text, norm(text), state, knowledge, deps)).toBeNull();
        expect(sent).toEqual([]);
    });
});

// ── 3. Compra más adelante ───────────────────────────────────────────────────
describe('quien avisó que compra más adelante', () => {
    const dataState = (o = {}) => ({
        step: 'waiting_data', history: [{ role: 'bot', content: 'Pasame tu *nombre completo* y *calle y número* 🙌' }],
        cart: [{ product: 'Gotas de nuez de la india', plan: '120', price: '49.900' }], selectedProduct: 'Gotas de nuez de la india', selectedPlan: '120',
        deliveryZone: 'in', shippingChoice: 'reparto', paymentMethod: 'contrarembolso', partialAddress: { ciudad: 'Rosario' }, ...o,
    });
    async function inData(text, state) {
        const sent = [];
        const deps = {
            sendMessageWithDelay: jest.fn(async (_i, m) => { sent.push(m); return true; }), saveState: jest.fn(),
            aiService, config: {}, sharedState: { pausedUsers: new Set(), config: {} }, notifyAdmin: jest.fn(),
        };
        const res = await handleWaitingData(USER, text, norm(text), state, knowledge, deps);
        return { sent, res };
    }

    test.each(['Ya te agende', 'Te aviso', 'Cobro y te mando', 'Gracias'])(
        '"%s" después de postergar → no se le vuelve a pedir nombre y calle', async (text) => {
            const state = dataState({ deferredAt: Date.now() - 60_000 });
            const { sent, res } = await inData(text, state);
            expect(res).toEqual({ matched: true });
            expect(sent.join('\n')).not.toMatch(/nombre/i);
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatch(/quedamos así/);
            expect(state.awaitingResume).toBe(true);
        });

    test('si después manda sus datos, se toman (no queda mudo)', async () => {
        const state = dataState({ deferredAt: Date.now() - 60_000 });
        aiService.parseAddress.mockResolvedValueOnce({ nombre: 'Sandra Martinez', calle: 'Carranza 627' });
        const { sent } = await inData('Sandra Martinez, Carranza 627', state);
        expect(sent.join('\n')).not.toMatch(/quedamos así/);
    });

    test('sin aviso previo, "Ya te agende" sigue el camino de siempre', async () => {
        const state = dataState();
        const { sent } = await inData('Ya te agende', state);
        expect(sent.join('\n')).not.toMatch(/quedamos así/);
    });

    test('el router anota el aviso (por la IA o por las palabras) y "no gracias" corta el recordatorio', async () => {
        const h = harness({ step: 'waiting_preference', history: [], cart: [] });
        await say(h, 'cuando cobre te aviso');
        expect(h.userState[USER].deferredAt).toBeGreaterThan(Date.now() - 5000);

        const h2 = harness({ step: 'waiting_preference', history: [], cart: [] });
        await say(h2, 'lo veo con mi hermana', { intent: { chooses: false, asks: false, objects: false, health: false, defers: true } });
        expect(h2.userState[USER].deferredAt).toBeGreaterThan(Date.now() - 5000);

        const h3 = harness({ step: 'waiting_preference', history: [], cart: [] });
        await say(h3, 'Nada más');
        expect(h3.userState[USER].cartRecovered).toBe(true);
        expect(h3.userState[USER].deferredAt).toBeUndefined();
    });

    test('ningún texto al cliente dice "el bot lo despacha"', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'flows', 'utils', 'objectionDetector.ts'), 'utf8');
        expect(src).not.toMatch(/el bot lo despacha/);
    });
});

// ── 4 y 5. Edad, salud y cliente que ya lo tiene ─────────────────────────────
describe('salud, edad y cliente existente', () => {
    test('"Tengo 79 años puedo tomarlas o tengo que consultar a mi médico" → no sale la objeción "lo consulto"', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: '¿Con cuál querés arrancar?' }], cart: [] });
        await say(h, 'Tengo 79 años puedo tomarlas o tengo que consultar a mi médico');
        expect(h.sent.join('\n')).not.toMatch(/reservado/);
        expect(h.userState[USER].clientAge).toBe(79);
        expect(h.userState[USER].objectionsHandled?.consultar).toBeFalsy();
    });

    test('lo mismo cuando la IA lo lee como pregunta (así llegó en prod): contesta el paso, no la objeción', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: '¿Con cuál querés arrancar?' }], cart: [] });
        await say(h, 'Tengo 79 años puedo tomarlas o tengo que consultar a mi médico',
            { intent: { chooses: false, asks: true, objects: false, health: true, defers: false } });
        expect(h.sent.join('\n')).not.toMatch(/reservado/);
        expect(h.sent).toEqual(['RESPUESTA IA. Te paso los precios 👇']);
        expect(h.userState[USER].clientAge).toBe(79);
    });

    test('"tengo que consultar con mi marido" sigue recibiendo la respuesta de siempre', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: '¿Con cuál querés arrancar?' }], cart: [] });
        await say(h, 'tengo que consultar con mi marido');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/reservado|cargado/);
    });

    test.each(['Hoy me llegaron las gotas', 'ya me llegaron', 'ayer me llego'])(
        '"%s" → ya lo tiene: no se le vende', async (text) => {
            const state = { step: 'waiting_weight', history: [], cart: [] };
            const sent = [];
            const deps = { sendMessageWithDelay: jest.fn(async (_i, m) => { sent.push(m); return true; }), saveState: jest.fn(), aiService };
            const res = await handleExistingCustomer(USER, text, norm(text), state, knowledge, deps);
            expect(res).toEqual({ matched: true });
            expect(state.step).toBe('completed');
        });

    test.each(['cuando me llega', 'en cuanto me llegan las gotas?', 'las gotas'])(
        '"%s" → no se confunde con alguien que ya lo recibió', async (text) => {
            const state = { step: 'waiting_weight', history: [], cart: [] };
            const deps = { sendMessageWithDelay: jest.fn(), saveState: jest.fn(), aiService };
            expect(await handleExistingCustomer(USER, text, norm(text), state, knowledge, deps)).toBeNull();
        });
});

// ── 7. Reporte diario ────────────────────────────────────────────────────────
describe('reporte diario: "sin respuesta" solo si el último en hablar fue el cliente', () => {
    const at = (hhmm) => new Date(`2026-11-22T${hhmm}:00Z`);
    const LOGS = [
        { userPhone: '5493410000001', role: 'user', content: '¿Cuánto cuesta la cápsula?', timestamp: at('13:00') },
        { userPhone: '5493410000001', role: 'bot', content: 'Estos son los precios', timestamp: at('13:01') },
        { userPhone: '5493410000002', role: 'user', content: 'Quiero', timestamp: at('14:00') },
        { userPhone: '5493410000002', role: 'admin', content: 'Te enviamos?', timestamp: at('14:05') },
        { userPhone: '5493410000003', role: 'user', content: '¿Hacen envíos a Salta?', timestamp: at('15:00') },
        { userPhone: '5493410000003', role: 'system', content: '⏸️ Bot pausado', timestamp: at('15:01') },
    ];
    const prisma = { chatLog: { findMany: jest.fn().mockResolvedValue(LOGS) } };

    test('buildTranscript dice en qué charlas habló último el cliente', async () => {
        const t = await buildTranscript('horacio', at('00:00'), at('23:59'), prisma);
        expect(t.ultimoEsCliente).toEqual(['5493410000003']);
    });

    test('la lista de la IA se filtra contra eso', async () => {
        const text = 'RESUMEN: Anduvo bien.\n\nSIN RESPUESTA: 5493410000001, 5493410000002, 5493410000003';
        const client = { messages: { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text }], usage: {} }) } };
        const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'review-'));
        const report = await runNightlyReview('horacio', {}, { client, prisma, now: at('23:59'), dataDir });
        expect(report.sinRespuesta).toEqual(['5493410000003']);
        expect(client.messages.create.mock.calls[0][0].system).toMatch(/la charla la tomó una persona/);
    });
});

// ── Mensajes cortos seguidos ─────────────────────────────────────────────────
describe('dos mensajes cortos seguidos en plena elección se juntan', () => {
    const { enqueueDebounced } = require('../src/handlers/incomingSteps');
    const mkRt = (step) => ({
        sellerId: 'horacio', userState: { [USER]: { step, assignedScript: 'v7' } }, config: { alertNumbers: [] },
        pausedUsers: new Set(), pendingMessages: new Map(), botQueue: { add: jest.fn().mockResolvedValue({}) }, saveState: jest.fn(),
    });
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('"Si gotas" y, 13 s después, "120 días" → un solo turno', async () => {
        const rt = mkRt('waiting_plan_choice');
        enqueueDebounced({ timestamp: 1 }, USER, 'Si gotas', rt);
        await jest.advanceTimersByTimeAsync(13000);
        expect(rt.botQueue.add).not.toHaveBeenCalled();
        enqueueDebounced({ timestamp: 14 }, USER, '120 días', rt);
        await jest.advanceTimersByTimeAsync(10000);
        expect(rt.botQueue.add).toHaveBeenCalledTimes(1);
        expect(rt.botQueue.add.mock.calls[0][1].combinedText).toBe('Si gotas 120 días');
    });

    test('una pregunta o un mensaje largo siguen saliendo a los 10 s', async () => {
        const rt = mkRt('waiting_plan_choice');
        enqueueDebounced({ timestamp: 1 }, USER, '¿y cuánto tarda?', rt);
        await jest.advanceTimersByTimeAsync(10000);
        expect(rt.botQueue.add).toHaveBeenCalledTimes(1);
    });

    test('fuera de la elección (primer mensaje) no cambia nada', async () => {
        const rt = mkRt('greeting');
        enqueueDebounced({ timestamp: 1 }, USER, 'hola', rt);
        await jest.advanceTimersByTimeAsync(10000);
        expect(rt.botQueue.add).toHaveBeenCalledTimes(1);
    });
});
