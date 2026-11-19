/**
 * La lectura de la IA (dependencies.intent) en los pasos de producto, plan,
 * localidad y datos. Cada caso es un mensaje real de la revisión de charlas del
 * 13 al 19-nov-2026: el clasificador lo había leído bien (o le faltaba el campo
 * `defers`), pero estos pasos no lo consultaban y decidía la regla por palabras.
 *
 * Sin `intent` cada paso se comporta como antes: eso también queda fijado acá.
 */

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../db', () => ({
    prisma: {
        order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }), findFirst: jest.fn().mockResolvedValue(null) },
        user: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        paymentLink: { create: jest.fn(), findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    },
}));
jest.mock('../src/services/pauseService', () => ({
    pauseUser: jest.fn(async (userId, reason, { sharedState }) => { sharedState.pausedUsers.add(userId); }),
    unpauseUser: jest.fn(),
}));

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

const { handleWaitingPreference } = require('../src/flows/steps/stepWaitingPreference');
const { handleWaitingPlanChoice } = require('../src/flows/steps/stepWaitingPlanChoice');
const { handleWaitingZone } = require('../src/flows/steps/stepWaitingZone');
const { handleWaitingData } = require('../src/flows/steps/stepWaitingData');
const { aiService } = require('../src/services/ai');
const { _getPrice } = require('../src/flows/utils/pricing');

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
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const withIntent = (i) => ({ ...deps, intent: { chooses: false, asks: false, objects: false, health: false, defers: false, ...i } });
const lastGoal = () => aiService.chat.mock.calls[aiService.chat.mock.calls.length - 1][1].goal;

function makeState(overrides = {}) {
    return {
        step: 'waiting_preference',
        history: [],
        cart: [],
        selectedProduct: null,
        selectedPlan: null,
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        ...overrides,
    };
}
const repartoState = (o = {}) => makeState({
    step: 'waiting_data', deliveryZone: 'in', shippingChoice: 'reparto', paymentMethod: 'contrarembolso',
    selectedProduct: 'Cápsulas', selectedPlan: '60',
    cart: [{ product: 'Cápsulas', plan: '60', price: _getPrice('Cápsulas', '60') }],
    totalPrice: _getPrice('Cápsulas', '60'),
    partialAddress: { ciudad: 'Rosario' }, ...o,
});

beforeEach(() => {
    sent.length = 0; orders.length = 0; pausedUsers.clear();
    mockParseAddress.mockReset().mockResolvedValue({});
    aiService.chat.mockReset().mockResolvedValue({ response: 'AI fallback', goalMet: false, extractedData: null });
});

// ─── Producto ────────────────────────────────────────────────────────────────
describe('waiting_preference', () => {
    const HEART = 'Que son naturales porque yo tomo pastillas para el corazón';

    test('nombrar "pastillas" en una pregunta de salud no elige las cápsulas', async () => {
        const st = makeState();
        await handleWaitingPreference(USER, HEART, norm(HEART), st, knowledge, withIntent({ asks: true, health: true }));
        expect(st.selectedProduct).toBeNull();
        expect(st.step).toBe('waiting_preference');
        expect(sent).toEqual(['AI fallback']);
        expect(lastGoal()).toMatch(/NO UNA ELECCIÓN/);
    });

    test('aunque la IA del paso devuelva un producto, una pregunta no avanza ni manda la plantilla', async () => {
        aiService.chat.mockResolvedValue({ response: 'Sí, son 100% naturales 😊', goalMet: true, extractedData: 'Cápsulas de nuez de la india' });
        const st = makeState();
        const text = 'Pero antes de eso contame un poquito sobre las gotas....';
        await handleWaitingPreference(USER, text, norm(text), st, knowledge, withIntent({ asks: true }));
        expect(st.selectedProduct).toBeNull();
        expect(sent).toEqual(['Sí, son 100% naturales 😊']);
    });

    test('sin clasificación el paso se comporta como antes (decide la regla)', async () => {
        const st = makeState();
        await handleWaitingPreference(USER, HEART, norm(HEART), st, knowledge, { ...deps, intent: null });
        expect(st.selectedProduct).toMatch(/Cápsulas/);
        expect(sent.join(' ')).toMatch(/Genial, las \*cápsulas\*/);
    });

    test('una elección leída como elección sigue yendo por la plantilla, sin IA', async () => {
        const st = makeState();
        await handleWaitingPreference(USER, 'con las cápsulas', 'con las capsulas', st, knowledge, withIntent({ chooses: true }));
        expect(st.selectedProduct).toMatch(/Cápsulas/);
        expect(aiService.chat).not.toHaveBeenCalled();
    });

    test('quien avisa que compra más adelante no queda con un pedido armado', async () => {
        const st = makeState();
        const text = 'Las capsulas de 60 días pero déjame que mañana le hablo a mi hna Y seguro te pedimos las cápsulas de 120 días.. gracias';
        await handleWaitingPreference(USER, text, norm(text), st, knowledge, withIntent({ defers: true }));
        expect(st.selectedProduct).toBeNull();
        expect(st.cart).toEqual([]);
        expect(st.step).toBe('waiting_preference');
        expect(lastGoal()).toMatch(/COMPRA MÁS ADELANTE/);
    });
});

// ─── Plan ────────────────────────────────────────────────────────────────────
describe('waiting_plan_choice', () => {
    const planState = () => makeState({ step: 'waiting_plan_choice', selectedProduct: 'Cápsulas' });
    const LATER = 'el de 60 pero dejame que lo hablo con mi marido y te aviso';

    test('"el de 60" dentro de un "te aviso" no arma el carrito', async () => {
        const st = planState();
        await handleWaitingPlanChoice(USER, LATER, norm(LATER), st, knowledge, withIntent({ defers: true }));
        expect(st.cart).toEqual([]);
        expect(st.step).toBe('waiting_plan_choice');
        expect(lastGoal()).toMatch(/COMPRA MÁS ADELANTE/);
    });

    test('una duda que nombra producto y plan no arma el carrito', async () => {
        const st = planState();
        const text = 'las capsulas de 120 me van a caer mal al estomago';
        await handleWaitingPlanChoice(USER, text, norm(text), st, knowledge, withIntent({ asks: true, health: true }));
        expect(st.cart).toEqual([]);
        expect(aiService.chat).toHaveBeenCalledTimes(1);
    });

    test('sin clasificación "el de 60" sigue cerrando el plan', async () => {
        const st = planState();
        await handleWaitingPlanChoice(USER, LATER, norm(LATER), st, knowledge, { ...deps, intent: null });
        expect(st.selectedPlan).toBe('60');
    });
});

// ─── Localidad ───────────────────────────────────────────────────────────────
describe('waiting_zone', () => {
    const zoneState = () => makeState({
        step: 'waiting_zone', zoneQuestion: 'localidad', selectedProduct: 'Cápsulas', selectedPlan: '120',
        cart: [{ product: 'Cápsulas', plan: '120', price: _getPrice('Cápsulas', '120') }],
    });
    const TEXT = 'Vivo en Rosario, pero te digo que las voy a encargar la semana próxima';

    test('da la localidad y avisa que compra después: los datos se piden para dejarlo agendado', async () => {
        const st = zoneState();
        await handleWaitingZone(USER, TEXT, norm(TEXT), st, knowledge, withIntent({ chooses: true, defers: true }));
        expect(st.deliveryZone).toBe('in');
        expect(sent.join(' ')).toMatch(/te lo dejo agendado para el día que me digas/);
        expect(sent.join(' ')).toMatch(/nombre completo/i);
    });

    test('sin clasificación pide nombre y calle como antes, sin hablar de agendar', async () => {
        const st = zoneState();
        await handleWaitingZone(USER, TEXT, norm(TEXT), st, knowledge, { ...deps, intent: null });
        expect(sent.join(' ')).toMatch(/nombre completo/i);
        expect(sent.join(' ')).not.toMatch(/agendado/);
    });
});

// ─── Datos ───────────────────────────────────────────────────────────────────
describe('waiting_data', () => {
    const FORMULA = 'Pero yo quiero saber la fórmula que tiene la pastilla, la cápsula.';

    test('preguntar por la fórmula de la cápsula no cambia el producto elegido', async () => {
        const st = repartoState({ selectedProduct: 'Semillas', cart: [{ product: 'Semillas', plan: '60', price: _getPrice('Semillas', '60') }] });
        await handleWaitingData(USER, FORMULA, norm(FORMULA), st, knowledge, withIntent({ asks: true }));
        expect(st.selectedProduct).toBe('Semillas');
        expect(sent.join(' ')).not.toMatch(/Cambiamos a|entonces 😊/);
        expect(sent).toEqual(['AI fallback']);
    });

    test('una objeción sin palabra clave la contesta la IA: no se vuelven a pedir los datos', async () => {
        const st = repartoState();
        const text = 'Me haces desconfiar ! Con insistencia que Tenes de que lo deje ya aventado y pidiendo datos !! Gracias';
        await handleWaitingData(USER, text, norm(text), st, knowledge, withIntent({ objects: true }));
        expect(sent).toEqual(['AI fallback']);
        expect(orders).toHaveLength(0);
    });

    test('"lo pediré la semana próxima": no se le busca una dirección y va el argumento de pagar al recibir', async () => {
        const st = repartoState();
        const text = 'Te comunico que lo pediré la semana próxima';
        await handleWaitingData(USER, text, norm(text), st, knowledge, withIntent({ defers: true }));
        expect(mockParseAddress).not.toHaveBeenCalled();
        expect(lastGoal()).toMatch(/NO paga nada ahora/);
        expect(sent).toEqual(['AI fallback']);
    });

    describe('datos de entrega que vienen con una pregunta', () => {
        const TEXT = 'Jessy Gomez\nParaguay 2300\nDime las diabeticas pueden tomar?';
        const parsed = { nombre: 'Jessy Gomez', calle: 'Paraguay 2300' };

        test('la pregunta se contesta antes de la confirmación del pedido', async () => {
            mockParseAddress.mockResolvedValue(parsed);
            aiService.chat.mockResolvedValue({ response: 'Sí, la diabetes no es una contraindicación 😊', goalMet: false, extractedData: null });
            const st = repartoState();
            await handleWaitingData(USER, TEXT, norm(TEXT), st, knowledge, withIntent({ chooses: true, asks: true, health: true }));
            expect(sent[0]).toMatch(/diabetes no es una contraindicación/);
            expect(sent[1]).toMatch(/CONFIRMACIÓN DE PEDIDO/);
            expect(orders).toHaveLength(1);
        });

        test('si la IA marca el caso para una persona, el pedido no se cierra', async () => {
            mockParseAddress.mockResolvedValue(parsed);
            aiService.chat.mockResolvedValue({ response: 'Dejame consultarlo con el equipo y te confirmo.', goalMet: false, extractedData: 'NEED_ADMIN' });
            const st = repartoState();
            await handleWaitingData(USER, TEXT, norm(TEXT), st, knowledge, withIntent({ chooses: true, asks: true, health: true }));
            expect(sent).toEqual(['Dejame consultarlo con el equipo y te confirmo.']);
            expect(orders).toHaveLength(0);
        });

        test('datos sin pregunta: se confirma directo, sin llamada extra a la IA', async () => {
            mockParseAddress.mockResolvedValue(parsed);
            const st = repartoState();
            await handleWaitingData(USER, 'Jessy Gomez\nParaguay 2300', norm('Jessy Gomez\nParaguay 2300'), st, knowledge, withIntent({ chooses: true }));
            expect(aiService.chat).not.toHaveBeenCalled();
            expect(sent[0]).toMatch(/CONFIRMACIÓN DE PEDIDO/);
        });
    });
});
