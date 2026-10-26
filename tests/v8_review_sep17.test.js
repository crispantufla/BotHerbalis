/**
 * Revisión de las 74 conversaciones de las primeras 48 h del guion por zona
 * (15 → 17-sep-2026): 0 ventas, y el embudo se cortaba DESPUÉS de elegir el plan.
 * Cada test reproduce un caso real (el teléfono está en el nombre) contra el
 * arreglo correspondiente:
 *
 *   1. Sin recordatorio en waiting_zone / waiting_payment_method.
 *   2. "Ah bueno gracias" o "¿Ese será dos meses?" tomados como compra, y el paso
 *      de zona insistiendo ("no me quedó claro") ante "todavía no".
 *   3. Pausas indebidas: "provincia de Entre Ríos", "yo quería saber el precio".
 *   4. En la zona: sin el argumento de pagar al recibir, la fecha ("después del
 *      5") ignorada y la calle dada junto con la localidad vuelta a pedir.
 *   5. Doble mensaje (IA + plantilla) en las transiciones.
 *   6. Textos: FAQ "funciona y posta" por la palabra "sirve", recordatorio con el
 *      emoji partido, falso positivo del guard anti venta-fantasma.
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

const { handleWaitingZone } = require('../src/flows/steps/stepWaitingZone');
const { handleWaitingPlanChoice } = require('../src/flows/steps/stepWaitingPlanChoice');
const { handleWaitingPreference } = require('../src/flows/steps/stepWaitingPreference');
const { handleWaitingWeight } = require('../src/flows/steps/stepWaitingWeight');
const { handleWaitingData } = require('../src/flows/steps/stepWaitingData');
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
        step: 'waiting_zone',
        history: [],
        cart: [{ product: 'Cápsulas', plan: '120', price }],
        selectedProduct: 'Cápsulas de nuez de la india',
        selectedPlan: '120',
        totalPrice: price,
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        zoneQuestion: 'localidad',
        ...overrides,
    };
}

beforeEach(() => {
    sent.length = 0; orders.length = 0; pausedUsers.clear();
    mockParseAddress.mockReset().mockResolvedValue({});
    aiService.chat.mockReset().mockResolvedValue({ response: 'AI fallback', goalMet: false, extractedData: null });
});

// ─── 1. Recordatorios ─────────────────────────────────────────────────────────
describe('scheduler — recordatorio después de elegir el plan', () => {
    const H = 3600 * 1000;
    const followUpState = (step, extra = {}) => ({
        step, cartRecovered: false, reengagementSent: false,
        lastActivityAt: Date.now() - 10 * H,
        history: [{ role: 'user', content: 'hola', timestamp: Date.now() - 10 * H }],
        ...extra,
    });
    const run = async (state) => {
        const d = { sendMessageWithDelay: jest.fn().mockResolvedValue(true), saveState: jest.fn() };
        await checkAbandonedCarts({ userState: { [USER]: state }, pausedUsers: new Set() }, d);
        return d.sendMessageWithDelay.mock.calls.map((c) => c[1]);
    };

    test('waiting_zone recibe recordatorio (5493412690283: eligió semillas y no dijo la localidad)', async () => {
        const msgs = await run(followUpState('waiting_zone'));
        expect(msgs).toHaveLength(1);
        expect(msgs[0]).toMatch(/localidad|ciudad o pueblo/i);
    });

    test('waiting_payment_method también (5493442677398, fuera de zona)', async () => {
        const msgs = await run(followUpState('waiting_payment_method', { deliveryZone: 'out' }));
        expect(msgs).toHaveLength(1);
    });

    test('datos del reparto: nombra solo lo que falta, sin ciudad ni CP, y el emoji queda entero (5493417504028)', async () => {
        const msgs = await run(followUpState('waiting_data', {
            shippingChoice: 'reparto', deliveryZone: 'in', userName: 'Acosta veronica',
            partialAddress: { nombre: 'Acosta veronica', ciudad: 'Rosario' },
        }));
        expect(msgs).toHaveLength(1);
        const m = msgs[0];
        expect(m).toMatch(/^¡?Hola, Acosta/);
        expect(m).toMatch(/calle y número/);
        expect(m).not.toMatch(/nombre completo|CP|código postal|ciudad/i);
        expect(m).not.toMatch(/�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    });
});

// ─── 2. "Sí" que no es compra ─────────────────────────────────────────────────
describe('waiting_plan_choice — acuse y preguntas no son elegir el plan', () => {
    const planState = (history) => makeState({ step: 'waiting_plan_choice', zoneQuestion: null, cart: [], totalPrice: null, selectedPlan: null, history });

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
        expect(st.step).toBe('waiting_zone');
    });

    test('"Ese será dos meses ?" es una pregunta, no la elección del de 60 (5493400497043)', async () => {
        const st = planState([{ role: 'bot', content: '¡Perfecto, el de 60 días es ideal para probar! ¿Lo armamos?', timestamp: 1 }]);
        await handleWaitingPlanChoice(USER, 'Ese será dos meses ?', norm('Ese será dos meses ?'), st, knowledge, deps);
        expect(st.step).toBe('waiting_plan_choice');
        expect(st.selectedPlan).toBeNull();
        expect(aiService.chat).toHaveBeenCalledTimes(1);
    });

    test('"60ndias" pegado → elige el 60 sin IA y con un solo mensaje (5493417504028)', async () => {
        const st = planState([]);
        await handleWaitingPlanChoice(USER, '60ndias', norm('60ndias'), st, knowledge, deps);
        expect(st.selectedPlan).toBe('60');
        expect(st.step).toBe('waiting_zone');
        expect(aiService.chat).not.toHaveBeenCalled();
        expect(sent).toHaveLength(1);
    });
});

describe('waiting_zone — frena, provincia sola, sí sin localidad', () => {
    test('"No no todavía no . gracias." → afloja sin pausar ni re-preguntar (5493400497043)', async () => {
        const st = makeState();
        await handleWaitingZone(USER, 'No no todavía no . gracias.', norm('No no todavía no . gracias.'), st, knowledge, deps);
        expect(pausedUsers.size).toBe(0);
        expect(st.step).toBe('waiting_zone');
        expect(lastSent()).not.toMatch(/no me quedó claro/i);
        expect(lastSent()).toMatch(/sin apuro/i);
    });

    test('"Estoy viajando apenas llegue te escribo me interesa" → afloja (5493436431292)', async () => {
        const st = makeState();
        const t = 'Estoy viajando apenas llegue te escribo me interesa';
        await handleWaitingZone(USER, t, norm(t), st, knowledge, deps);
        expect(pausedUsers.size).toBe(0);
        expect(lastSent()).not.toMatch(/no me quedó claro/i);
    });

    test('"Soy de la provincia de Entre ríos" → pregunta la ciudad, NO pausa (5493436431292)', async () => {
        const st = makeState();
        const t = 'Soy de la provincia de Entre ríos';
        await handleWaitingZone(USER, t, norm(t), st, knowledge, deps);
        expect(pausedUsers.size).toBe(0);
        expect(lastSent()).toMatch(/ciudad o pueblo de Entre Ríos/);
        expect(st.step).toBe('waiting_zone');
    });

    test('"Si, soy de Las Parejas" no es un sí vacío: toma el pueblo y pregunta los km', async () => {
        mockParseAddress.mockResolvedValue({ ciudad: 'Las Parejas', provincia: 'Santa Fe' });
        const st = makeState();
        await handleWaitingZone(USER, 'Si, soy de Las Parejas', norm('Si, soy de Las Parejas'), st, knowledge, deps);
        expect(st.zoneQuestion).toBe('km');
        expect(st.partialAddress.ciudad).toBe('Las Parejas');
        expect(lastSent()).toMatch(/cuántos km/i);
    });

    test('"cuando pueda te paso, vivo en Bigand" no es un freno', async () => {
        mockParseAddress.mockResolvedValue({ ciudad: 'Bigand', provincia: 'Santa Fe' });
        const st = makeState();
        const t = 'cuando pueda te paso los datos, vivo en Bigand';
        await handleWaitingZone(USER, t, norm(t), st, knowledge, deps);
        expect(st.deliveryZone).toBe('in');
        expect(lastSent()).not.toMatch(/sin apuro/i);
    });

    test('"Si si esa me interesa" → vuelve a preguntar sin el "no me quedó claro" (5493416188233)', async () => {
        const st = makeState();
        await handleWaitingZone(USER, 'Si si esa me interesa', norm('Si si esa me interesa'), st, knowledge, deps);
        expect(lastSent()).not.toMatch(/no me quedó claro/i);
        expect(lastSent()).toMatch(/ciudad o pueblo/i);
    });
});

// ─── 3. Pausas indebidas en el saludo ─────────────────────────────────────────
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

// ─── 4. En la zona ────────────────────────────────────────────────────────────
describe('reparto propio — pagar al recibir, fecha y calle', () => {
    const inState = (o = {}) => makeState({
        step: 'waiting_data', deliveryZone: 'in', zoneQuestion: null,
        shippingChoice: 'reparto', paymentMethod: 'contrarembolso', senaAmount: 0,
        partialAddress: { ciudad: 'Rosario' }, addressAttempts: 0, fieldReaskCount: {}, ...o,
    });

    test('"Cuando tenga el dinero le mando dire" → la IA dice que no paga nada ahora (5493417504028)', async () => {
        const st = inState();
        const t = 'Cuando tenga el dinero le mando dire';
        await handleWaitingData(USER, t, norm(t), st, knowledge, deps);
        expect(aiService.chat).toHaveBeenCalled();
        const goal = aiService.chat.mock.calls[aiService.chat.mock.calls.length - 1][1].goal;
        expect(goal).toMatch(/NO tiene que pagar nada ahora/);
        expect(pausedUsers.size).toBe(0);
    });

    test('"después del 5" contestando la oferta de agendar → anota la fecha y pide los datos (5493364634777)', async () => {
        const offer = '¡Obvio que sí! 😊 No hay apuro. Si querés, te lo dejamos agendado para la fecha que vos prefieras y lo despachamos recién ese día. ¿A partir de cuándo te queda cómodo recibirlo?';
        const st = inState({ partialAddress: { ciudad: 'Villa Constitución' }, history: [{ role: 'bot', content: offer, timestamp: 1 }] });
        const t = 'después del 5';
        expect(detectObjection('waiting_data', norm(t), st)).toBeNull();
        await handleWaitingData(USER, t, norm(t), st, knowledge, deps);
        expect(st.postdatado).toBe('despues del 5');
        expect(lastSent()).toMatch(/agendado para \*después del 5\*/);
        expect(lastSent()).toMatch(/nombre completo/);
        expect(lastSent()).toMatch(/calle y número/);
    });

    test('sin oferta previa, "después del 5" sigue siendo una postergación para el detector', () => {
        const st = inState({ history: [{ role: 'bot', content: 'Pasame tu nombre completo y calle y número 🙌', timestamp: 1 }] });
        expect(detectObjection('waiting_data', norm('después del 5'), st)).not.toBeNull();
    });

    test('calle junto con la localidad → la guarda y pide solo el nombre (5493415788327)', async () => {
        mockParseAddress.mockResolvedValue({ calle: 'Provincia de Misiones 2240', ciudad: 'Rosario' });
        const st = makeState();
        const t = 'Sona oseste rosario provincia de misiones 2240';
        await handleWaitingZone(USER, t, norm(t), st, knowledge, deps);
        expect(st.deliveryZone).toBe('in');
        expect(st.partialAddress.calle).toBe('Provincia de Misiones 2240');
        expect(lastSent()).toMatch(/Anoté \*Provincia de Misiones 2240\*/);
        expect(lastSent()).toMatch(/nombre completo/);
        expect(lastSent()).not.toMatch(/calle y número/);
    });

    test('nombre, calle y localidad en un mensaje → cierra la venta sin volver a pedir nada', async () => {
        mockParseAddress.mockResolvedValue({ nombre: 'Marta López', calle: 'Mitre 1234', ciudad: 'Funes' });
        const st = makeState();
        const t = 'Marta López, Mitre 1234, Funes';
        await handleWaitingZone(USER, t, norm(t), st, knowledge, deps);
        expect(orders).toHaveLength(1);
        expect(orders[0]).toMatchObject({ nombre: 'Marta López', calle: 'Mitre 1234', status: 'Confirmado' });
        expect(st.step).toBe('completed');
    });
});

// ─── 5. Doble mensaje ─────────────────────────────────────────────────────────
describe('transiciones con un solo mensaje', () => {
    const planState = () => makeState({ step: 'waiting_plan_choice', zoneQuestion: null, cart: [], totalPrice: null, selectedPlan: null, history: [] });

    test('la IA cierra el plan y ya preguntó la localidad → no se repite la plantilla (5493436431292)', async () => {
        aiService.chat.mockResolvedValue({ response: '¡Genial, 120 días! 💪 Llega en 4 días hábiles. ¿De qué localidad sos?', goalMet: true, extractedData: '120' });
        const st = planState();
        const t = '120 dia, en cuanto dia llega?';
        await handleWaitingPlanChoice(USER, t, norm(t), st, knowledge, deps);
        expect(sent).toHaveLength(1);
        expect(st.step).toBe('waiting_zone');
        expect(st.zoneQuestion).toBe('localidad');
    });

    test('la IA cierra el plan sin que el cliente pregunte nada → va solo la plantilla con el resumen', async () => {
        aiService.chat.mockResolvedValue({ response: '¡Dale, 60 días! 💧 ¿De qué localidad sos?', goalMet: true, extractedData: '60' });
        const st = planState();
        await handleWaitingPlanChoice(USER, 'voy con sesenta', norm('voy con sesenta'), st, knowledge, deps);
        expect(sent).toHaveLength(1);
        expect(lastSent()).toMatch(/× 60 días/);
        expect(st.step).toBe('waiting_zone');
    });

    test('"Elegiría la opción 3" → semillas sin IA (5493424784464)', async () => {
        const st = makeState({ step: 'waiting_preference', selectedProduct: null, selectedPlan: null, cart: [], totalPrice: null, weightGoal: 17, zoneQuestion: null });
        const t = 'Elegiría la opción 3';
        await handleWaitingPreference(USER, t, norm(t), st, knowledge, deps);
        expect(aiService.chat).not.toHaveBeenCalled();
        expect(st.selectedProduct).toMatch(/Semillas/);
        // Plantilla de semillas (+ la recomendación del 120 que sale siempre con
        // más de 10 kg). Lo que no puede haber es la IA preguntando la localidad.
        expect(sent[0]).toMatch(/las \*semillas\*/);
        expect(sent.join('\n')).not.toMatch(/localidad|de qué ciudad|sos de rosario/i);
    });
});

// ─── 6. Textos ────────────────────────────────────────────────────────────────
describe('textos', () => {
    test('"ver si realmente nos sirve" ya no dispara "Sí, funciona y posta" (5493413552069)', async () => {
        const st = makeState({ step: 'waiting_preference', zoneQuestion: null });
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
