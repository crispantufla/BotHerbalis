/**
 * Fallas que encontró el simulador de clientes (tests/customer_sim.live.test.js)
 * en su primera tanda, el 24-nov-2026:
 *   1. "70 mas o menos de rosario" se leyó como Rosario → pedido con pago al
 *      recibir a Chabás, que no tiene reparto. Y la respuesta fija de envíos
 *      tapaba el mensaje que decía la localidad.
 *   2. Después de la respuesta de la IA salía igual "¡Genial, las gotas! …
 *      ¿60 o 120 días?" a quien ya había dicho el plan.
 *   3. El pedido completo en el primer mensaje recibía el saludo genérico y
 *      después se volvían a pedir nombre y calle.
 *   4. "¿Esto es una estafa?" bloqueaba el chat como insulto.
 *   5. "Estoy tomando las cápsulas y tengo diarrea" recibía el saludo de ventas.
 *   6. El rechazo por edad o embarazo se repetía igual en cada mensaje.
 *   7. "Soy de Lomas" no se reconocía.
 *   8. "me equivoqué" después de la lista pausaba el chat.
 *   9. Una pregunta por descuento recibía el argumento de "es caro".
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
jest.mock('../src/services/queueService', () => ({ redisConnection: { get: jest.fn(), set: jest.fn(), del: jest.fn() } }));
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn(),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue(null),
        anthropic: null,
    },
}));
jest.mock('../src/services/timeUtils', () => ({ ...jest.requireActual('../src/services/timeUtils'), isBusinessHours: () => true }));

const knowledge = require('../knowledge_v7.json');
const { processSalesFlow } = require('../src/flows/salesFlow');
const { classifyZoneText, centerReference, statesOwnLocality, rememberZoneFromMessage } = require('../src/flows/utils/deliveryZone');
const { looksLikeStreet } = require('../src/flows/steps/stepWaitingZone');
const { _isGhostClose } = require('../src/flows/utils/flowHelpers');
const { pauseUser } = require('../src/services/pauseService');
const { aiService } = require('../src/services/ai');

const USER = '5493410000024@c.us';

function harness(initial) {
    const sent = [];
    const orders = [];
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
        saveOrderToLocal: jest.fn(async (o) => { orders.push(o); }),
        logAndEmit: jest.fn(),
        sharedState: { io: { emit: jest.fn(), to: () => ({ emit: jest.fn() }) }, pausedUsers, sellerId: 'horacio', config: {} },
        config: {},
        sellerId: 'horacio',
        aiService,
    };
    return { sent, orders, pausedUsers, deps, userState };
}
const say = (h, text, extra = {}) => processSalesFlow(USER, text, h.userState, knowledge, { ...h.deps, ...extra });
const cart = (product = 'Semillas de nuez de la india', plan = '120', price = '49.900') => ({
    selectedProduct: product, selectedPlan: plan, cart: [{ product, plan, price }], totalPrice: price,
});
const inZone = () => ({ step: 'waiting_zone', zoneQuestion: 'localidad', history: [{ role: 'bot', content: 'Contame de qué localidad sos, así te digo cómo te llega 📦' }], ...cart() });

beforeEach(() => {
    aiService.chat.mockReset().mockResolvedValue({ response: 'RESPUESTA IA.', goalMet: false, extractedData: null });
    aiService.parseAddress.mockReset().mockResolvedValue(null);
    pauseUser.mockClear();
});

// ── 1. Rosario como referencia ───────────────────────────────────────────────
describe('la distancia a Rosario no es la localidad', () => {
    test.each([
        '70 mas o menos de rosario, me conviene mas que me lo lleven a casa',
        'estoy a 70 km aprox de Rosario',
        'a una hora de rosario',
        'lejos de rosario',
        'no soy de rosario',
        'unos 45 y pico de rosario',
    ])('"%s" no clasifica como Rosario', (text) => {
        expect(classifyZoneText(text, knowledge).zone).toBe('unknown');
        expect(centerReference(text, knowledge)).not.toBeNull();
    });

    test('saca los km de la referencia', () => {
        expect(centerReference('70 mas o menos de rosario', knowledge)).toEqual({ km: 70, far: false });
        expect(centerReference('a 40 km de Rosario', knowledge)).toEqual({ km: 40, far: false });
        expect(centerReference('cerca de rosario', knowledge)).toEqual({ km: null, far: false });
        expect(centerReference('a una hora de rosario', knowledge)).toEqual({ km: null, far: false });
        expect(centerReference('lejos de rosario', knowledge).far).toBe(true);
    });

    test.each(['Soy de Rosario', 'rosario zona sur', 'Rosario, Mitre 1234', 'vivo en rosario centro'])(
        '"%s" sigue siendo Rosario', (text) => {
            expect(classifyZoneText(text, knowledge)).toMatchObject({ zone: 'in', localidad: 'Rosario' });
            expect(centerReference(text, knowledge)).toBeNull();
        });

    test('la charla de Chabás: la localidad con pregunta va al paso, sale por Correo y no hay pago al recibir', async () => {
        const h = harness(inZone());
        await say(h, 'soy de chabás, santa fe. cuánto tarda en llegar?');
        expect(h.userState[USER].deliveryZone).toBe('out');
        expect(h.userState[USER].partialAddress.ciudad).toBe('Chabás');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/Correo Argentino/);
        expect(h.sent[0]).toMatch(/4 días hábiles/);
        expect(h.sent[0]).not.toMatch(/De qué localidad sos/);
        expect(h.userState[USER].paymentMethod).not.toBe('contrarembolso');
    });

    test('"70 mas o menos de rosario" sin haber nombrado el pueblo → fuera de zona, nunca reparto', async () => {
        const h = harness(inZone());
        await say(h, '70 mas o menos de rosario, me conviene mas que me lo lleven a casa');
        const st = h.userState[USER];
        expect(st.deliveryZone).toBe('out');
        expect(st.shippingChoice).not.toBe('reparto');
        expect(st.paymentMethod).not.toBe('contrarembolso');
        expect(h.sent.join('\n')).not.toMatch(/reparto propio 🚚/);
        expect(h.sent.join('\n')).toMatch(/Correo Argentino/);
        expect(aiService.chat).not.toHaveBeenCalled();
        expect(aiService.parseAddress).not.toHaveBeenCalled();
    });

    test('"estoy a 30 km de rosario" sin nombre de localidad → se pregunta el nombre, no se promete reparto', async () => {
        const h = harness(inZone());
        await say(h, 'estoy a 30 km de rosario');
        const st = h.userState[USER];
        expect(st.deliveryZone == null).toBe(true);
        expect(st.step).toBe('waiting_zone');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/Cómo se llama tu localidad/);
        // Insiste sin nombrarla: lo resuelve una persona.
        await say(h, 'cerca de rosario te dije');
        expect(pauseUser).toHaveBeenCalledTimes(1);
        expect(h.userState[USER].deliveryZone == null).toBe(true);
    });

    test('con el pueblo ya anotado y cerca → confirma una persona', async () => {
        const st = inZone();
        st.partialAddress = { ciudad: 'Pueblo Muñoz' };
        const h = harness(st);
        await say(h, 'queda a 25 km de rosario');
        expect(pauseUser).toHaveBeenCalledTimes(1);
        expect(h.sent[0]).toMatch(/confirmo con el equipo de envíos/);
        expect(h.userState[USER].deliveryZone == null).toBe(true);
    });

    test('"Soy de Uranga, 40 km de Rosario" sigue saliendo por Correo', async () => {
        const h = harness(inZone());
        await say(h, 'Soy de Uranga, 40 km de Rosario');
        expect(h.userState[USER].deliveryZone).toBe('out');
        expect(h.userState[USER].partialAddress.ciudad).toBe('Uranga');
    });

    test('la IA dice de dónde es y no está en ninguna lista → se preguntan los km, no la localidad otra vez', async () => {
        aiService.chat.mockResolvedValue({ response: 'Llega en unos días. ¿De qué localidad sos?', goalMet: false, extractedData: 'LOCALIDAD: Las Parejas' });
        const h = harness(inZone());
        await say(h, 'cuanto tarda? yo soy de las parejas');
        expect(h.userState[USER].zoneQuestion).toBe('km');
        expect(h.userState[USER].partialAddress.ciudad).toBe('Las Parejas');
        expect(h.sent.join('\n')).not.toMatch(/De qué localidad sos/);
    });
});

// ── 7. Lomas y el paso de localidad ──────────────────────────────────────────
describe('localidades del Gran Buenos Aires y mensajes que dicen la localidad', () => {
    test.each(['Soy de Lomas, laburo en la zona', 'soy de lomas de zamora, zona sur', 'vivo en Banfield', 'soy de monte grande'])(
        '"%s" → fuera de zona', (text) => {
            expect(classifyZoneText(text, knowledge).zone).toBe('out');
        });

    test('"soy de lomas de zamora… es 1832 creo" en el paso de localidad no recibe una objeción ni una FAQ', async () => {
        const h = harness(inZone());
        await say(h, 'soy de lomas de zamora, zona sur. tenes el codigo postal? es 1832 creo');
        expect(h.userState[USER].deliveryZone).toBe('out');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/Correo Argentino/);
        expect(h.sent[0]).not.toMatch(/funciona y posta/);
    });

    test('"envío a Córdoba" dicho al elegir producto queda anotado', () => {
        const st = { step: 'waiting_preference', history: [] };
        expect(rememberZoneFromMessage('quiero las gotas de 120 dias, cuanto me saldria el envio a cordoba?', st, knowledge)).toBe(true);
        expect(st.deliveryZone).toBe('out');
    });

    test('statesOwnLocality: con contexto sí, preguntando por nosotros no', () => {
        expect(statesOwnLocality('soy de funes, cuanto tarda?', knowledge)).toMatchObject({ zone: 'in', localidad: 'Funes' });
        expect(statesOwnLocality('¿Son de Rosario?', knowledge)).toBeNull();
        expect(statesOwnLocality('cuanto tarda en llegar?', knowledge)).toBeNull();
    });
});

// ── Segunda tanda del simulador ──────────────────────────────────────────────
describe('lo que mostró la segunda tanda', () => {
    test('"soy de córdoba capital, barrio alberdi" no es Rosario', () => {
        expect(classifyZoneText('soy de córdoba capital, barrio alberdi', knowledge).zone).toBe('out');
        expect(classifyZoneText('barrio alberdi', knowledge)).toMatchObject({ zone: 'in', localidad: 'Rosario' });
        expect(classifyZoneText('vivo en San Juan 1234, Fisherton', knowledge).zone).toBe('in');
    });

    test('"soy de capital" dicho de pasada queda anotado como fuera de zona', () => {
        const st = { step: 'waiting_preference', history: [] };
        expect(rememberZoneFromMessage('jajaja bueno dale, cuanto tarda en llegar? soy de capital', st, knowledge)).toBe(true);
        expect(st.deliveryZone).toBe('out');
        const st2 = { step: 'waiting_preference', history: [] };
        rememberZoneFromMessage('soy de rosario capital', st2, knowledge);
        expect(st2.deliveryZone).toBe('in');
    });

    test('dos productos en un mensaje: la IA dice el total y el pedido lo arma una persona', async () => {
        aiService.chat.mockResolvedValue({ response: 'Las dos cosas te salen $X en total 📦', goalMet: true, extractedData: 'Cápsulas de nuez de la india' });
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'quiero las cápsulas de 60 para mí y las gotas de 60 para mi mamá. Cuánto me sale todo junto?');
        expect(h.sent).toHaveLength(2);
        expect(h.sent[0]).toBe('Las dos cosas te salen $X en total 📦');
        expect(h.sent[1]).toMatch(/dos productos/);
        expect(h.sent.join('\n')).not.toMatch(/Vamos con \*Cápsulas|60 o 120/);
        expect(pauseUser).toHaveBeenCalledTimes(1);
        expect(pauseUser.mock.calls[0][1]).toMatch(/DOS productos/);
    });

    test('"tengo 17 años, esta bien igual?" en la toma de datos corta la venta, no dice "Anotado"', async () => {
        const h = harness({ step: 'waiting_data', deliveryZone: 'in', shippingChoice: 'reparto', paymentMethod: 'contrarembolso', partialAddress: { ciudad: 'Rosario' }, history: [{ role: 'bot', content: 'Pasame tu *nombre completo* y *calle y número* 🙌' }], ...cart('Cápsulas de nuez de la india', '60', '54.900') });
        await say(h, 'tengo 17 años, esta bien igual?');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/menores de 18/);
        expect(h.userState[USER].step).toBe('rejected_medical');
    });

    test('comparar dos productos no es pedir los dos', async () => {
        aiService.chat.mockResolvedValue({ response: 'Funcionan igual 😊 ¿Con cuál vas?', goalMet: false, extractedData: null });
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'cual es mejor, las capsulas o las gotas?');
        expect(pauseUser).not.toHaveBeenCalled();
        expect(h.sent).toEqual(['Funcionan igual 😊 ¿Con cuál vas?']);
    });

    test('el plan dicho en un mensaje que contestó una respuesta fija queda anotado', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'quiero las gotas de 120 dias, cuanto me saldria el envio?');
        expect(h.sent[0]).toMatch(/Depende de dónde estés/);
        expect(h.userState[USER]._planChoice).toBe('120');
        aiService.chat.mockResolvedValue({ response: 'Dale 😊', goalMet: true, extractedData: 'Gotas de nuez de la india' });
        await say(h, 'Soy de Córdoba capital, así que por correo estaría bien');
        expect(h.sent.join('\n')).not.toMatch(/Con cuál vas, 60 o 120/);
        expect(h.userState[USER].selectedPlan).toBe('120');
        expect(h.userState[USER].deliveryZone).toBe('out');
    });

    test('"quiero bajar 60 kilos" no es elegir el plan de 60', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'cuanto sale el envio? tengo que bajar como 60 kilos');
        expect(h.userState[USER]._planChoice).toBeUndefined();
    });

    test('"el 5 del mes que viene te aviso, gracias" en la toma de datos no vuelve a pedir nombre y calle', async () => {
        const h = harness({ step: 'waiting_data', deliveryZone: 'in', shippingChoice: 'reparto', paymentMethod: 'contrarembolso', deferredAt: Date.now() - 60000, partialAddress: { ciudad: 'Rosario' }, history: [{ role: 'bot', content: '¿Te parece que me los pases cuando puedas?' }], ...cart('Gotas de nuez de la india', '120', '68.900') });
        await say(h, 'mira, el 5 del mes que viene te aviso, gracias');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/quedamos así/);
        expect(h.sent[0]).not.toMatch(/Nombre completo/i);
    });

    test('esperando el pago, "seguro que se acreditó, revisá bien" no recibe "es 100% natural"', async () => {
        const h = harness({ step: 'waiting_mp_payment', deliveryZone: 'out', paymentMethod: 'mercadopago', mpPaymentLinkUrl: 'https://mpago.la/x', mpPaymentLinkId: 'x', history: [{ role: 'bot', content: '⏳ Todavía no veo el pago confirmado en el sistema.' }], ...cart('Cápsulas de nuez de la india', '60', '54.900') });
        await say(h, 'che, ya pasaron 10 min. seguro que se acreditó. revisá bien');
        expect(h.sent.join('\n')).not.toMatch(/100% natural/);
    });

    test('el plan dicho en un mensaje anterior se recuerda: no se pregunta "60 o 120"', async () => {
        aiService.chat.mockResolvedValue({ response: 'Dale 😊', goalMet: true, extractedData: 'Gotas de nuez de la india' });
        const h = harness({ step: 'waiting_preference', _planChoice: '120', history: [{ role: 'bot', content: '¿Para qué día te conviene?' }], cart: [] });
        await say(h, 'el 5 de mayo me va bien');
        expect(h.sent.join('\n')).not.toMatch(/Con cuál vas, 60 o 120/);
        expect(h.userState[USER].selectedPlan).toBe('120');
        expect(h.userState[USER].step).toBe('waiting_zone');
    });

    test('73 años que insiste con las cápsulas: la regla no se repite igual', async () => {
        const h = harness({ step: 'waiting_plan_choice', history: [{ role: 'bot', content: '¿Con cuál vas, 60 o 120 días?' }], ...cart('Cápsulas de nuez de la india', '120', '68.900') });
        await say(h, 'tengo 73 años, me das las cápsulas de 60 dias?');
        await say(h, 'no, mirá, mi vecina toma las cápsulas y tiene 76. me das las de 60 días nomas');
        expect(h.sent).toHaveLength(2);
        expect(h.sent[0]).toMatch(/Después de los 70 no indicamos/);
        expect(h.sent[1]).not.toMatch(/Después de los 70 no indicamos/);
        expect(h.sent[1]).toMatch(/gotas/);
        expect(h.userState[USER].selectedProduct).toMatch(/Gotas/);
    });

    test('"¿no está prohibida por ANMAT?" la contesta la IA, no la respuesta fija de desconfianza', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'ey espera, no es verdad q la nuez de india esta prohibida por anmat? lei q es toxica');
        expect(aiService.chat).toHaveBeenCalled();
        expect(h.sent).toEqual(['RESPUESTA IA.']);
    });

    test('desconfiar del link de pago no es pedir que lo reenvíen', async () => {
        const h = harness({ step: 'waiting_mp_payment', deliveryZone: 'out', paymentMethod: 'mercadopago', mpPaymentLinkUrl: 'https://mpago.la/x', mpPaymentLinkId: 'x', history: [{ role: 'bot', content: 'Te dejo el link' }], ...cart('Cápsulas de nuez de la india', '60', '54.900') });
        await say(h, 'espera, no voy a clickear un link sin saber bien quien sos. tenes numero de empresa? me da cosa');
        expect(h.sent.join('\n')).not.toMatch(/Acá está tu enlace de pago/);
        const h2 = harness({ step: 'waiting_mp_payment', deliveryZone: 'out', paymentMethod: 'mercadopago', mpPaymentLinkUrl: 'https://mpago.la/x', mpPaymentLinkId: 'x', history: [{ role: 'bot', content: 'Te dejo el link' }], ...cart('Cápsulas de nuez de la india', '60', '54.900') });
        await say(h2, 'me mandas el link de nuevo?');
        expect(h2.sent.join('\n')).toMatch(/Acá está tu enlace de pago/);
    });
});

// ── 2. Doble mensaje tras la respuesta de la IA ──────────────────────────────
describe('después de la respuesta de la IA no sale la plantilla de planes de más', () => {
    const afterList = () => ({ step: 'waiting_preference', history: [{ role: 'bot', content: '¡Claro! Estos son los precios 👇 … ¿Con cuál querés arrancar?' }], cart: [] });

    test('ya dijo el plan → no se le pregunta "60 o 120": pasa a la localidad', async () => {
        aiService.chat.mockResolvedValue({ response: 'El envío es gratis a todo el país 📦', goalMet: true, extractedData: 'Gotas de nuez de la india' });
        const h = harness(afterList());
        await say(h, 'quiero las gotas de 120 dias, tienen cafeina?');
        const st = h.userState[USER];
        expect(st.selectedPlan).toBe('120');
        expect(st.selectedProduct).toMatch(/Gotas/);
        expect(h.sent.join('\n')).not.toMatch(/Con cuál vas, 60 o 120/);
        expect(h.sent[0]).toBe('El envío es gratis a todo el país 📦');
        expect(st.step).toBe('waiting_zone');
        expect(h.sent[1]).toMatch(/Gotas.*120 días/);
    });

    test('la charla de Córdoba: plan dicho y "envío a córdoba" → la IA contesta y sigue el mensaje de Correo', async () => {
        aiService.chat.mockResolvedValue({ response: 'El envío a Córdoba es gratis 📦', goalMet: true, extractedData: 'Gotas de nuez de la india' });
        const h = harness(afterList());
        await say(h, 'quiero las gotas de 120 dias, cuanto me saldria el envio a cordoba?');
        const st = h.userState[USER];
        expect(st.deliveryZone).toBe('out');
        expect(st.selectedPlan).toBe('120');
        expect(h.sent).toHaveLength(2);
        expect(h.sent[0]).toBe('El envío a Córdoba es gratis 📦');
        expect(h.sent[1]).toMatch(/Correo Argentino/);
        expect(h.sent.join('\n')).not.toMatch(/De qué localidad sos|60 o 120/);
    });

    test('ya dijo el plan y la IA ya preguntó la localidad → no se pregunta dos veces', async () => {
        aiService.chat.mockResolvedValue({ response: 'Sale $X. ¿De qué localidad sos?', goalMet: true, extractedData: 'Gotas de nuez de la india' });
        const h = harness(afterList());
        await say(h, 'las gotas de 120, tienen cafeina?');
        expect(h.sent).toEqual(['Sale $X. ¿De qué localidad sos?']);
        expect(h.userState[USER].step).toBe('waiting_zone');
    });

    test('sin plan y la IA cerró con una pregunta → no se suma la plantilla; queda en la elección de plan', async () => {
        aiService.chat.mockResolvedValue({ response: 'Las cápsulas no tienen cafeína 😊 ¿Avanzamos con esas?', goalMet: true, extractedData: 'Cápsulas de nuez de la india' });
        const h = harness(afterList());
        await say(h, 'las capsulas tienen cafeina?');
        expect(h.sent).toEqual(['Las cápsulas no tienen cafeína 😊 ¿Avanzamos con esas?']);
        expect(h.userState[USER].step).toBe('waiting_plan_choice');
        expect(h.userState[USER].selectedProduct).toMatch(/Cápsulas/);
    });

    test('sin plan y la IA no preguntó nada → la plantilla de planes sale como antes', async () => {
        aiService.chat.mockResolvedValue({ response: 'Las cápsulas no tienen cafeína 😊', goalMet: true, extractedData: 'Cápsulas de nuez de la india' });
        const h = harness(afterList());
        await say(h, 'las capsulas tienen cafeina?');
        expect(h.sent).toHaveLength(2);
        expect(h.sent[1]).toMatch(/60 o 120 días/);
    });

    test('elige sin preguntar nada → plantilla de planes, sin IA', async () => {
        const h = harness(afterList());
        await say(h, 'las gotas');
        expect(aiService.chat).not.toHaveBeenCalled();
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/60 o 120 días/);
    });
});

// ── 3. Pedido completo en el primer mensaje ──────────────────────────────────
describe('el pedido armado en el primer mensaje', () => {
    test('producto, plan, localidad, nombre y calle → se cierra sin volver a pedir nada', async () => {
        aiService.parseAddress.mockResolvedValue({ nombre: 'Laura Sosa', calle: 'Galindo 1820', ciudad: 'Funes' });
        const h = harness();
        await say(h, 'Hola quiero las gotas de 120 dias soy de Funes, Laura Sosa, Galindo 1820');
        const st = h.userState[USER];
        expect(h.sent).toHaveLength(2);
        expect(h.sent[0]).toBe('¡Hola! 😊 Soy Elena de Herbalis.');
        expect(h.sent[1]).toMatch(/CONFIRMACIÓN DE PEDIDO/);
        expect(h.sent[1]).toMatch(/Gotas de nuez de la india/);
        expect(h.sent[1]).toMatch(/Plan: 120 días/);
        expect(h.sent[1]).toMatch(/domicilio en Funes/);
        expect(st.step).toBe('completed');
        expect(st.deliveryZone).toBe('in');
        expect(h.deps.notifyAdmin.mock.calls.some((c) => /Laura Sosa/.test(JSON.stringify(c)) && /Galindo 1820/.test(JSON.stringify(c)))).toBe(true);
    });

    test('producto y plan sin datos → pregunta la localidad, no "¿Te paso los precios?"', async () => {
        const h = harness();
        await say(h, 'Hola quiero las capsulas de 60 dias');
        expect(h.sent[0]).toBe('¡Hola! 😊 Soy Elena de Herbalis.');
        expect(h.sent[1]).toMatch(/Cápsulas.*60 días/);
        expect(h.sent[1]).toMatch(/de qué localidad sos/);
        expect(h.userState[USER].step).toBe('waiting_zone');
    });

    test('un "hola" común sigue con la presentación completa', async () => {
        const h = harness();
        await say(h, 'Hola buenas tardes');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/Te paso los precios/);
    });

    test('los datos junto con la elección de producto se guardan (ciudad sin "soy de")', async () => {
        aiService.parseAddress.mockResolvedValue({ nombre: 'Beatriz Luna', calle: 'Belgrano 880', ciudad: 'Pérez' });
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'voy con las semillas de 60 días. beatriz luna, belgrano 880, pérez');
        const st = h.userState[USER];
        expect(st.deliveryZone).toBe('in');
        expect(st.step).toBe('completed');
        expect(h.sent.join('\n')).not.toMatch(/Pasame tu \*nombre completo\* y \*calle y número\*/);
        expect(h.sent.join('\n')).toMatch(/CONFIRMACIÓN DE PEDIDO/);
        expect(h.sent.join('\n')).toMatch(/domicilio en Pérez/);
    });

    test('la calle "Mendoza 4521" con ciudad Rosario no manda el pedido a Mendoza', async () => {
        aiService.parseAddress.mockResolvedValue({ nombre: 'Nelida Ferreyra', calle: 'Mendoza 4521', ciudad: 'Rosario' });
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'me traes las gotas de 60 días entonces. paso mi dato: Nelida Ferreyra, Mendoza 4521, Rosario');
        expect(h.userState[USER].deliveryZone).toBe('in');
        expect(h.sent.join('\n')).toMatch(/domicilio en Rosario/);
        expect(h.sent.join('\n')).not.toMatch(/de qué localidad sos|Correo Argentino/);
    });

    test.each([
        ['Laura Sosa, Galindo 1820', true],
        ['av. pellegrini 1245', true],
        ['quiero las gotas de 120 dias', false],
        ['el plan de 60', false],
        ['tengo 73 años y peso 90 kilos', false],
        ['quiero bajar 15 kilos con capsulas', false],
        ['estoy a 70 km de rosario', false],
    ])('looksLikeStreet("%s") = %s', (text, expected) => {
        expect(looksLikeStreet(text)).toBe(expected);
    });
});

// ── 4. Desconfianza ──────────────────────────────────────────────────────────
describe('desconfiar no es insultar', () => {
    const mid = () => ({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });

    test.each(['¿esto es una estafa?', 'no sera una estafa no?', 'tengo miedo de que sea mentira', 'me dijeron que es un robo'])(
        '"%s" → se contesta, sin bloqueo ni pausa', async (text) => {
            const h = harness(mid());
            await say(h, text);
            expect(h.userState[USER].step).not.toBe('rejected_abusive');
            expect(pauseUser).not.toHaveBeenCalled();
            // La contesta la IA o la respuesta fija de desconfianza (13 años, 70 mil clientes).
            expect(h.sent).toHaveLength(1);
            expect(h.sent[0]).not.toMatch(/suspender la interacción/);
        });

    test.each(['son unos estafadores', 'esto es una estafa', 'andate a la mierda', 'los voy a denunciar, es una estafa?'])(
        '"%s" → sigue bloqueando', async (text) => {
            const h = harness(mid());
            await say(h, text);
            expect(h.userState[USER].step).toBe('rejected_abusive');
            expect(pauseUser).toHaveBeenCalledTimes(1);
        });
});

// ── 5. Efecto adverso ────────────────────────────────────────────────────────
describe('lo está tomando y le cayó mal', () => {
    test('en el PRIMER mensaje → sin saludo de ventas, pausa y aviso', async () => {
        const h = harness();
        await say(h, 'Hola, estoy tomando las capsulas hace una semana y tengo diarrea y dolor de panza todos los dias');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/Lamento muchísimo/);
        expect(h.sent[0]).not.toMatch(/precios/);
        expect(pauseUser).toHaveBeenCalledTimes(1);
        expect(pauseUser.mock.calls[0][1]).toMatch(/REACCIÓN ADVERSA/);
        expect(aiService.chat).not.toHaveBeenCalled();
    });

    test('"desde que empecé con las cápsulas me duele la panza" a mitad de charla', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: '¿Te paso los precios?' }], cart: [] });
        await say(h, 'desde que empece con las capsulas me duele la panza');
        expect(pauseUser).toHaveBeenCalledTimes(1);
    });

    test('un lead que PREGUNTA si da diarrea no se pausa', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'las capsulas dan diarrea?');
        expect(pauseUser).not.toHaveBeenCalled();
    });
});

// ── 6. Rechazo médico ────────────────────────────────────────────────────────
describe('el rechazo por salud o edad no se repite', () => {
    const REJECT = /por estricta precaución/;

    test('82 años: rechazo una vez; "para mi hija de 50" lo ve una asesora', async () => {
        const h = harness({ step: 'waiting_weight', history: [{ role: 'bot', content: '¿Te paso los precios? 😊' }], cart: [] });
        await say(h, 'tengo 82 años, puedo tomar esto?');
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(REJECT);
        expect(h.userState[USER].step).toBe('rejected_medical');

        await say(h, 'pero mira, lo quiero para mi hija de 50. ella sí puede tomar no?');
        expect(h.sent).toHaveLength(2);
        expect(h.sent[1]).not.toMatch(REJECT);
        expect(h.sent[1]).toMatch(/otra persona/);
        expect(pauseUser).toHaveBeenCalledTimes(1);
    });

    test('embarazada que insiste: una respuesta corta y después silencio', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'estoy embarazada de 4 meses, puedo tomar las gotas igual?');
        await say(h, 'pero es natural, no debería pasar nada :/');
        await say(h, 'dale no seas mala');
        await say(h, 'hola?');
        expect(h.sent).toHaveLength(3);
        expect(h.sent[0]).toMatch(REJECT);
        expect(h.sent[1]).toMatch(/preferimos no indicarla/);
        // Tercera vez: lo ve una persona, y después ya no se contesta.
        expect(h.sent[2]).toMatch(/lo vea una asesora/);
        expect(pauseUser).toHaveBeenCalledTimes(1);
        expect(h.userState[USER].step).toBe('rejected_medical');
    });
});

// ── 8. "me equivoqué" ────────────────────────────────────────────────────────
describe('"me equivoqué" después de la lista de precios', () => {
    test.each(['nooo gracias me equivoqué 😅', 'no gracias', 'no me interesa'])('"%s" → se despide sin IA, sin pausa, sin recordatorio', async (text) => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇 ¿Con cuál querés arrancar?' }], cart: [] });
        await say(h, text);
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatch(/no pasa nada/);
        expect(aiService.chat).not.toHaveBeenCalled();
        expect(pauseUser).not.toHaveBeenCalled();
        expect(h.userState[USER].cartRecovered).toBe(true);
    });

    test('"no gracias, prefiero las gotas" no es un rechazo', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'capsulas no gracias, prefiero las gotas');
        expect(h.sent.join('\n')).not.toMatch(/no pasa nada/);
    });
});

// ── 9. Preguntas que no se contestaban ───────────────────────────────────────
describe('preguntas que tapaba otra respuesta', () => {
    test('"si llevo 2 de las semillas hay descuento?" la contesta el paso, no la objeción de precio', async () => {
        const h = harness({ step: 'waiting_preference', history: [{ role: 'bot', content: 'Estos son los precios 👇' }], cart: [] });
        await say(h, 'che pero 36 lucas igual es mucha plata... si llevo 2 de las semillas hay descuento?');
        expect(aiService.chat).toHaveBeenCalled();
        expect(h.sent.join('\n')).not.toMatch(/La plata cuesta ganarla/);
    });

    test('un audio con cinco preguntas en el primer mensaje no recibe la tabla con los kilos', async () => {
        aiService.chat.mockResolvedValue({ response: 'Soy Elena. Te contesto todo… Te paso los precios 👇', goalMet: false, extractedData: null });
        const h = harness();
        await say(h, 'hola buenas tardes mirá yo quería saber qué efectos laterales puede tener, si tiene rebote, cómo se toma, cuánto sale y si el envío es contrareembolso porque yo soy de Pérez');
        expect(h.sent).toHaveLength(2);
        expect(h.sent[0]).toMatch(/Te contesto todo/);
        expect(h.sent.join('\n')).not.toMatch(/cuánto querés bajar|Hasta 10 kg/);
        expect(h.userState[USER].step).toBe('waiting_preference');
    });

    test('"así lo dejamos todo listo" no es una venta fantasma; "ya quedó todo listo" sí', () => {
        expect(_isGhostClose('Pasame los datos cuando quieras. Así lo dejamos todo listo y, apenas se acredite, sale.', 'waiting_transfer_confirmation', false)).toBe(false);
        expect(_isGhostClose('¡Ya quedó todo listo! Tu pedido sale mañana.', 'waiting_data', false)).toBe(true);
    });
});
