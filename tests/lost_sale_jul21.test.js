/**
 * Venta trabada 5492215731759 (21-jul-2026, Andrea Calderón / Ensenada):
 *
 *  1. "Me conviene ir a la sucursal del correo y abonar ahí" → _isInfoQuestion
 *     lo marcaba como pregunta ("me conviene" es arranque interrogativo), TODOS
 *     los paths determinísticos quedaban gateados y el mensaje caía al AI
 *     fallback: la IA pedía el nombre pero el step NO transicionaba. Los datos
 *     que la clienta mandó después (nombre, CP, teléfono) cayeron en
 *     waiting_payment_method y se perdieron.
 *  2. Cuando el path de retiro por fin matcheó ("Si pago en efectivo en
 *     sucursal"), el bot re-pidió TODO de cero aunque nombre y CP ya estaban
 *     en el historial.
 *  3. En waiting_data, el mensaje multilínea con TODOS los datos + pregunta
 *     pegada ("...1925 Cómo tomo las cápsulas") lo interceptó la FAQ de
 *     posología (matched=true) y el step nunca vio los datos → re-pedido en
 *     loop y venta sin cerrar.
 */

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));

jest.mock('../db', () => ({
    prisma: {
        user: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        order: { create: jest.fn().mockResolvedValue({ id: 'o1' }), findFirst: jest.fn().mockResolvedValue(null) },
    },
}));

jest.mock('../src/services/funnelLogger', () => ({
    logStepTransition: jest.fn(),
    markExit: jest.fn().mockResolvedValue(undefined),
    logMessage: jest.fn().mockResolvedValue(undefined),
}));

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const { handleWaitingPaymentMethod } = require('../src/flows/steps/stepWaitingPaymentMethod');
const { handleWaitingData } = require('../src/flows/steps/stepWaitingData');
const { handleFaq } = require('../src/flows/globals/globalFaq');
const { parseShippingChoice } = require('../src/flows/utils/extractedData');
const { _getPrice } = require('../src/flows/utils/pricing');

// Precio vigente real — el guard _orderPriceCoherent compara contra pricing.ts,
// así que el fixture no puede hardcodear un valor.
const PRICE_120 = _getPrice('Cápsulas de nuez de la india', '120');

const makePaymentState = (over = {}) => ({
    step: 'waiting_payment_method',
    history: [],
    cart: [{ product: 'Cápsulas de nuez de la india', plan: '120', price: PRICE_120 }],
    selectedProduct: 'Cápsulas de nuez de la india',
    selectedPlan: '120',
    totalPrice: PRICE_120,
    partialAddress: {},
    summary: '',
    stepEnteredAt: 1000,
    ...over,
});

const makeDeps = (over = {}) => {
    const sent = [];
    return {
        sent,
        deps: {
            sendMessageWithDelay: async (_id, m) => { sent.push(m); },
            saveState: jest.fn(),
            aiService: { chat: jest.fn().mockResolvedValue({ response: 'AI genérico', goalMet: false }) },
            ...over,
        },
    };
};

// ════════════════════════════════════════════════════════════════════════════
// 1. "Me conviene ir a la sucursal..." es ELECCIÓN, no pregunta
// ════════════════════════════════════════════════════════════════════════════
describe('waiting_payment_method — elección decisiva aunque parezca pregunta', () => {
    test('"Me conviene ir a la sucursal del correo y abonar ahí" → retiro + waiting_data', async () => {
        const { sent, deps } = makeDeps();
        const state = makePaymentState();
        const text = 'Me conviene ir a la sucursal del correo y abonar ahí';
        const res = await handleWaitingPaymentMethod('a1@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        expect(state.shippingChoice).toBe('retiro');
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.step).toBe('waiting_data');
        expect(state.partialAddress.calle).toBe('A sucursal');
        // No debe haber caído al AI fallback
        expect(deps.aiService.chat).not.toHaveBeenCalled();
        expect(sent.join(' ')).toMatch(/retiro en sucursal/i);
    });

    test('"me conviene la sucursal?" (con "?") sigue siendo pregunta → AI fallback, sin transición', async () => {
        const { deps } = makeDeps();
        const state = makePaymentState();
        const text = 'me conviene la sucursal?';
        await handleWaitingPaymentMethod('a2@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(deps.aiService.chat).toHaveBeenCalled();
        expect(state.step).toBe('waiting_payment_method');
        expect(state.shippingChoice).toBeFalsy();
    });

    test('"quiero saber cuanto tarda el retiro" NO se toma como elección', async () => {
        const { deps } = makeDeps();
        const state = makePaymentState();
        const text = 'quiero saber cuanto tarda el retiro';
        await handleWaitingPaymentMethod('a3@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(state.step).toBe('waiting_payment_method');
        expect(state.shippingChoice).toBeFalsy();
    });

    test('"Cuánto tarda si elijo retiro" (arranque interrogativo) sigue siendo pregunta', async () => {
        const { deps } = makeDeps();
        const state = makePaymentState();
        const text = 'Cuánto tarda si elijo retiro';
        await handleWaitingPaymentMethod('a4@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(state.step).toBe('waiting_payment_method');
        expect(state.shippingChoice).toBeFalsy();
        expect(deps.aiService.chat).toHaveBeenCalled();
    });

    test('"Me conviene mas retiro o envio a domicilio" (comparativa con " o ") NO decide', async () => {
        const { deps } = makeDeps();
        const state = makePaymentState();
        const text = 'Me conviene mas retiro o envio a domicilio';
        await handleWaitingPaymentMethod('a5@c.us', text, norm(text), state, { flow: {} }, deps);
        // Ambas opciones nombradas → path de ambigüedad o fallback, nunca asumir una
        expect(state.step).toBe('waiting_payment_method');
    });

    test('"Me conviene la 1" → elección por número de opción → retiro', async () => {
        const { deps } = makeDeps();
        const state = makePaymentState();
        const text = 'Me conviene la 1';
        await handleWaitingPaymentMethod('a6@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(state.step).toBe('waiting_data');
        expect(state.shippingChoice).toBe('retiro');
        expect(deps.aiService.chat).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Tag "ENVIO:" del AI fallback sincroniza la máquina de estados
// ════════════════════════════════════════════════════════════════════════════
describe('waiting_payment_method — sync vía extractedData del AI fallback', () => {
    test('parseShippingChoice parsea los tags (con y sin tilde)', () => {
        expect(parseShippingChoice('ENVIO: retiro')).toBe('retiro');
        expect(parseShippingChoice('ENVIO: domicilio')).toBe('domicilio');
        expect(parseShippingChoice('ENVÍO: retiro')).toBe('retiro'); // el modelo escribe español
        expect(parseShippingChoice('envío: domicilio')).toBe('domicilio');
        expect(parseShippingChoice('POSTDATADO: 1 de julio')).toBeNull();
        expect(parseShippingChoice(null)).toBeNull();
    });

    test('IA responde con "ENVIO: retiro" → step pasa a waiting_data con retiro', async () => {
        const { deps } = makeDeps({
            aiService: {
                chat: jest.fn().mockResolvedValue({
                    response: 'Dale, entonces retiro en sucursal 😊 ¿Me pasás tu nombre completo?',
                    goalMet: false,
                    extractedData: 'ENVIO: retiro',
                }),
            },
        });
        const state = makePaymentState();
        // Texto que no matchea ningún path determinístico → cae al AI fallback
        const text = 'Dale, eso que me dijiste del correo esta bien';
        const res = await handleWaitingPaymentMethod('b1@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        expect(deps.aiService.chat).toHaveBeenCalled();
        expect(state.step).toBe('waiting_data');
        expect(state.shippingChoice).toBe('retiro');
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.partialAddress.calle).toBe('A sucursal');
    });

    test('IA responde con "ENVIO: domicilio" → submenú habilitado', async () => {
        const { deps } = makeDeps({
            aiService: {
                chat: jest.fn().mockResolvedValue({
                    response: 'Perfecto, a tu casa entonces. ¿Tarjeta o transferencia?',
                    goalMet: false,
                    extractedData: 'ENVIO: domicilio',
                }),
            },
        });
        const state = makePaymentState();
        const text = 'Dale, eso que me dijiste esta bien';
        await handleWaitingPaymentMethod('b2@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(state.shippingChoice).toBe('domicilio');
        expect(state.paymentSubChoiceAsked).toBe(true);
        expect(state.step).toBe('waiting_payment_method');
    });

    test('IA responde SIN tag → nada cambia (comportamiento previo)', async () => {
        const { deps } = makeDeps();
        const state = makePaymentState();
        const text = 'Dale, eso que me dijiste esta bien';
        await handleWaitingPaymentMethod('b3@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(state.step).toBe('waiting_payment_method');
        expect(state.shippingChoice).toBeFalsy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Prefill: datos dejados en el historial mientras el step no avanzaba
// ════════════════════════════════════════════════════════════════════════════
describe('waiting_payment_method — retiro rescata datos del historial reciente', () => {
    const historyWithData = [
        { role: 'bot', content: '¿Cuál es tu nombre completo?', timestamp: 1500 },
        { role: 'user', content: 'Calderón Andrea', timestamp: 2000 },
        { role: 'bot', content: '¿Tu código postal?', timestamp: 2500 },
        { role: 'user', content: '1925 2215731759', timestamp: 3000 },
    ];

    test('nombre y CP en historial → pide SOLO la localidad', async () => {
        const { sent, deps } = makeDeps({
            mockAiService: { parseAddress: async () => ({ nombre: 'Calderón Andrea' }) },
        });
        const state = makePaymentState({ history: [...historyWithData] });
        const text = 'Si pago en efectivo en sucursal';
        const res = await handleWaitingPaymentMethod('c1@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        expect(state.step).toBe('waiting_data');
        expect(state.partialAddress.nombre).toBe('Calderón Andrea');
        expect(state.partialAddress.cp).toBe('1925'); // fallback regex de 4 dígitos
        const all = sent.join(' ');
        expect(all).toMatch(/Localidad \/ Ciudad:/);
        expect(all).not.toMatch(/Nombre completo:/);
        expect(all).not.toMatch(/Código postal:/);
    });

    test('historial con TODO (nombre+ciudad+CP) → cierra la venta directo', async () => {
        const { deps } = makeDeps({
            mockAiService: { parseAddress: async () => ({ nombre: 'Calderón Andrea', ciudad: 'Ensenada', cp: '1925' }) },
        });
        const state = makePaymentState({ history: [...historyWithData] });
        const text = 'Si pago en efectivo en sucursal';
        const res = await handleWaitingPaymentMethod('c2@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        expect(state.step).toBe('completed');
        expect(state.pendingOrder).toBeTruthy();
        expect(state.pendingOrder.nombre).toBe('Calderón Andrea');
        expect(state.pendingOrder.ciudad).toBe('Ensenada');
        expect(state.pendingOrder.cp).toBe('1925');
        expect(state.pendingOrder.calle).toBe('A sucursal');
    });

    test('sin historial previo en el step → mensaje idéntico al de siempre (3 campos)', async () => {
        const { sent, deps } = makeDeps();
        const state = makePaymentState();
        const text = 'retiro en sucursal';
        await handleWaitingPaymentMethod('c3@c.us', text, norm(text), state, { flow: {} }, deps);
        const all = sent.join(' ');
        expect(all).toMatch(/Nombre completo:\nLocalidad \/ Ciudad:\nCódigo postal:/);
    });

    test('estado legacy SIN stepEnteredAt → no prefillea (evita falsos positivos)', async () => {
        const { sent, deps } = makeDeps({
            mockAiService: { parseAddress: jest.fn(async () => ({ nombre: 'Calderón Andrea' })) },
        });
        const state = makePaymentState({ history: [...historyWithData], stepEnteredAt: undefined });
        const text = 'retiro en sucursal';
        await handleWaitingPaymentMethod('c4@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(deps.mockAiService.parseAddress).not.toHaveBeenCalled();
        expect(sent.join(' ')).toMatch(/Nombre completo:\nLocalidad \/ Ciudad:\nCódigo postal:/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3b. Variante DOMICILIO: datos + pregunta pegada no se pierden en waiting_data
// ════════════════════════════════════════════════════════════════════════════
describe('waiting_data domicilio — bloque de datos con pregunta pegada se parsea igual', () => {
    test('multilínea con pregunta al final captura nombre y calle (antes iba al AI fallback)', async () => {
        const { sent, deps } = makeDeps({
            mockAiService: { parseAddress: async () => ({ nombre: 'Juan Perez', calle: 'San Martin 1425' }) },
        });
        const state = {
            step: 'waiting_data',
            shippingChoice: 'domicilio',
            paymentMethod: 'transferencia',
            selectedProduct: 'Cápsulas de nuez de la india',
            selectedPlan: '120',
            totalPrice: PRICE_120,
            cart: [{ product: 'Cápsulas de nuez de la india', plan: '120', price: PRICE_120 }],
            partialAddress: {},
            history: [],
            summary: '',
            stepEnteredAt: 1000,
        };
        const text = 'Juan Perez\nSan Martin 1425\ncuanto tarda en llegar?';
        const res = await handleWaitingData('e1@c.us', text, norm(text), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        // Los datos se persistieron aunque el mensaje "parezca pregunta"
        expect(state.partialAddress.nombre).toBe('Juan Perez');
        expect(state.partialAddress.calle).toBe('San Martin 1425');
        expect(sent.join(' ')).toMatch(/Localidad/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. FAQ passthrough: pregunta embebida en bloque de datos en waiting_data
// ════════════════════════════════════════════════════════════════════════════
describe('globalFaq — bloque de datos + pregunta no se traga los datos', () => {
    const faqKnowledge = {
        flow: {},
        faq: [{
            keywords: ['como tomo', 'como se toma', 'como se toman'],
            response: '💊 *Cápsulas:* una al día, 30 min antes del almuerzo o cena.',
        }],
    };
    const mergedText = 'Quintana y bolivia escalera 28 \nCalderón Andrea \nEnsenada\n1925 Cómo tomo las cápsulas';

    const makeDataState = (over = {}) => ({
        step: 'waiting_data',
        shippingChoice: 'retiro',
        paymentMethod: 'contrarembolso',
        selectedProduct: 'Cápsulas de nuez de la india',
        selectedPlan: '120',
        totalPrice: PRICE_120,
        cart: [{ product: 'Cápsulas de nuez de la india', plan: '120', price: PRICE_120 }],
        partialAddress: { calle: 'A sucursal' },
        history: [],
        summary: '',
        stepEnteredAt: 1000,
        ...over,
    });

    test('responde la FAQ pero devuelve null (passthrough) con bloque de datos', async () => {
        const { sent, deps } = makeDeps();
        const state = makeDataState();
        const res = await handleFaq('d1@c.us', mergedText, norm(mergedText), state, faqKnowledge, deps);
        expect(res).toBeNull(); // el step debe seguir procesando el mensaje
        expect(sent.join(' ')).toMatch(/una al día/);
    });

    test('pregunta pura (sin datos) en waiting_data sigue interceptada (matched=true)', async () => {
        const { deps } = makeDeps();
        const state = makeDataState();
        const text = 'Cómo tomo las cápsulas';
        const res = await handleFaq('d2@c.us', text, norm(text), state, faqKnowledge, deps);
        expect(res).toEqual({ matched: true });
    });

    test('E2E del mensaje real: FAQ responde Y el step cierra la venta con los datos', async () => {
        const { sent, deps } = makeDeps({
            mockAiService: { parseAddress: async () => ({ nombre: 'Calderón Andrea', ciudad: 'Ensenada', cp: '1925' }) },
        });
        const state = makeDataState();

        // 1) La FAQ responde la pregunta y deja pasar
        const faqRes = await handleFaq('d3@c.us', mergedText, norm(mergedText), state, faqKnowledge, deps);
        expect(faqRes).toBeNull();

        // 2) El step recibe el MISMO texto y captura los datos → venta cerrada
        const stepRes = await handleWaitingData('d3@c.us', mergedText, norm(mergedText), state, faqKnowledge, deps);
        expect(stepRes.matched).toBe(true);
        expect(state.step).toBe('completed');
        expect(state.pendingOrder).toBeTruthy();
        expect(state.pendingOrder.nombre).toBe('Calderón Andrea');
        expect(state.pendingOrder.ciudad).toBe('Ensenada');
        expect(state.pendingOrder.cp).toBe('1925');
        expect(sent.join(' ')).toMatch(/una al día/); // la pregunta fue respondida
    });
});
