/**
 * Modelo por zona (sep-2026): la publicidad apunta a Rosario y 60 km, así que el
 * "menú de pago" pasó a ser una pregunta de LOCALIDAD.
 *   - Dentro de zona → reparto propio, sin costo, paga al recibir (efectivo,
 *     tarjeta o transferencia). El bot pide nombre + calle y cierra solo.
 *   - Fuera de zona → Correo Argentino, SIEMPRE prepago (tarjeta o
 *     transferencia), a domicilio o a sucursal, 4 días hábiles. Quien pide
 *     contrarreembolso recibe el argumento del dueño y, si insiste, el cierre.
 *   - "Soy de Rosario" ya NO pausa al cliente (hasta sep-2026 lo hacía).
 *
 * Cubre: el clasificador (flows/utils/deliveryZone), el step waiting_zone, la
 * entrada desde la elección de plan, el paso de pago fuera de zona, la toma de
 * datos del reparto y los placeholders de las confirmaciones.
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

const zone = require('../src/flows/utils/deliveryZone');
const { handleWaitingZone, _startZoneStep } = require('../src/flows/steps/stepWaitingZone');
const { handleWaitingPlanChoice } = require('../src/flows/steps/stepWaitingPlanChoice');
const { handleWaitingPaymentMethod } = require('../src/flows/steps/stepWaitingPaymentMethod');
const { handleWaitingData } = require('../src/flows/steps/stepWaitingData');
const { _formatMessage } = require('../src/flows/utils/messages');
const { buildConfirmationMessage } = require('../src/utils/messageTemplates');
const { aiService } = require('../src/services/ai');
const { _getPrice } = require('../src/flows/utils/pricing');
const PRICE_120 = _getPrice('Cápsulas', '120');

// ─── Arnés ───────────────────────────────────────────────────────────────────
const sent = [];
const orders = [];
const alerts = [];
const pausedUsers = new Set();
const deps = {
    saveState: jest.fn(),
    sendMessageWithDelay: jest.fn(async (userId, msg) => { sent.push(msg); return true; }),
    notifyAdmin: jest.fn(async (title, userId, body) => { alerts.push({ title, body }); }),
    saveOrderToLocal: jest.fn((o) => { orders.push(o); }),
    aiService,
    sellerId: 'vendedor_test',
    sharedState: { pausedUsers, io: null, saveState: jest.fn(), config: { alertNumbers: [] } },
    config: { alertNumbers: [] },
    logAndEmit: jest.fn(),
};
const USER = '5493410000001@c.us';
const lastSent = () => sent[sent.length - 1] || '';

function makeState(overrides = {}) {
    return {
        step: 'waiting_zone',
        history: [],
        cart: [{ product: 'Cápsulas', plan: '120', price: PRICE_120 }],
        selectedProduct: 'Cápsulas',
        selectedPlan: '120',
        totalPrice: PRICE_120,
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        zoneQuestion: 'localidad',
        ...overrides,
    };
}
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

beforeEach(() => {
    sent.length = 0; orders.length = 0; alerts.length = 0; pausedUsers.clear();
    mockParseAddress.mockReset().mockResolvedValue({});
    aiService.chat.mockReset().mockResolvedValue({ response: 'AI fallback', goalMet: false, extractedData: null });
});

// ─── Clasificador ─────────────────────────────────────────────────────────────
describe('deliveryZone.classifyZoneText', () => {
    test.each([
        ['Funes', 'in', 'Funes'],
        ['soy de rosario', 'in', 'Rosario'],
        ['Villa Gobernador Gálvez', 'in', 'Villa Gobernador Gálvez'],
        ['vivo en san lorenzo', 'in', 'San Lorenzo'],
        ['Rosario, barrio Fisherton', 'in', 'Rosario'],
        ['CP 2000', 'in', 'Rosario'],
        ['Córdoba capital', 'out', 'Cordoba'],
        ['Buenos Aires', 'out', 'Buenos Aires'],
        ['Mendoza', 'out', 'Mendoza'],
        ['ciudad de Santa Fe', 'out', 'Ciudad De Santa Fe'],
    ])('"%s" → %s', (text, expectedZone, expectedLoc) => {
        const c = zone.classifyZoneText(text, knowledge);
        expect(c.zone).toBe(expectedZone);
        expect(c.localidad).toBe(expectedLoc);
    });

    test('las localidades de borde (San Nicolás, Cañada de Gómez, Victoria) quedan FUERA: el radio es de 60 km', () => {
        for (const t of ['San Nicolás', 'cañada de gomez', 'Victoria']) {
            const c = zone.classifyZoneText(t, knowledge);
            expect(c.zone).toBe('out');
            expect(c.borde).toBe(true);
        }
    });

    test('"Santa Fe" y "Entre Ríos" a secas no se asumen (son provincias que contienen la zona)', () => {
        expect(zone.classifyZoneText('santa fe', knowledge).zone).toBe('unknown');
        expect(zone.classifyZoneText('entre rios', knowledge).zone).toBe('unknown');
        expect(zone.isFarPlace('Santa Fe')).toBe(false);
        expect(zone.isFarPlace('Córdoba')).toBe(true);
    });

    test('un pueblo que no está en ninguna lista es unknown', () => {
        expect(zone.classifyZoneText('Las Parejas', knowledge).zone).toBe('unknown');
    });

    test('la lista del guion manda sobre la de respaldo', () => {
        const k = { rules: { repartoPropio: { localidades: ['Pueblo Inventado'], localidadesBorde: [] } } };
        expect(zone.classifyZoneText('pueblo inventado', k).zone).toBe('in');
        expect(zone.classifyZoneText('Funes', k).zone).toBe('unknown');
    });
});

describe('deliveryZone.parseDistanceAnswer', () => {
    test.each([
        ['a 30 km', 'in'], ['unos 45', 'in'], ['cerquita', 'in'], ['al lado', 'in'],
        ['80 km', 'out'], ['más de 100', 'out'], ['lejos', 'out'], ['no, para nada', 'out'],
        ['no sé', 'unknown'],
    ])('"%s" → %s', (t, v) => {
        expect(zone.parseDistanceAnswer(t, 60)).toBe(v);
    });
});

describe('deliveryZone.findZoneInHistory — solo con contexto de lugar', () => {
    test('"soy de Funes" dicho en el saludo resuelve la zona', () => {
        const h = [{ role: 'user', content: 'Hola, soy de Funes y quiero info' }, { role: 'bot', content: '...' }];
        expect(zone.findZoneInHistory(h, knowledge)).toEqual({ zone: 'in', localidad: 'Funes' });
    });
    test('un apellido que coincide con una localidad (Pérez, Álvarez) NO cuenta', () => {
        const h = [{ role: 'user', content: 'Soy Marta Pérez' }, { role: 'user', content: 'Juan Álvarez, 45 años' }];
        expect(zone.findZoneInHistory(h, knowledge)).toBeNull();
    });
    test('"vivo en Córdoba" resuelve fuera de zona', () => {
        const h = [{ role: 'user', content: 'vivo en cordoba, llegan?' }];
        expect(zone.findZoneInHistory(h, knowledge)).toEqual({ zone: 'out', localidad: 'Cordoba' });
    });
});

// ─── waiting_zone ─────────────────────────────────────────────────────────────
describe('handleWaitingZone', () => {
    test('localidad dentro de zona → reparto propio, pide nombre + calle, pasa a waiting_data', async () => {
        const st = makeState();
        await handleWaitingZone(USER, 'Funes', norm('Funes'), st, knowledge, deps);
        expect(st.step).toBe('waiting_data');
        expect(st.deliveryZone).toBe('in');
        expect(st.shippingChoice).toBe('reparto');
        expect(st.paymentMethod).toBe('contrarembolso');
        expect(st.partialAddress.ciudad).toBe('Funes');
        expect(lastSent()).toMatch(/Funes/);
        expect(lastSent()).toMatch(/reparto propio/i);
        expect(lastSent()).toMatch(/al recibirlo/i);
        expect(lastSent()).toMatch(/nombre completo/i);
        expect(lastSent()).toMatch(/calle y número/i);
        expect(lastSent()).not.toMatch(/Correo|sucursal|zona de influencia/i);
        expect(pausedUsers.size).toBe(0);
    });

    test('"soy de Rosario" NO pausa: es el camino feliz', async () => {
        const st = makeState();
        await handleWaitingZone(USER, 'Soy de Rosario', norm('Soy de Rosario'), st, knowledge, deps);
        expect(pausedUsers.size).toBe(0);
        expect(alerts).toHaveLength(0);
        expect(st.deliveryZone).toBe('in');
        expect(lastSent()).not.toMatch(/no tenemos local|un asesor/i);
    });

    test('localidad fuera de zona → Correo prepago, pregunta casa o sucursal, pasa a waiting_payment_method', async () => {
        const st = makeState();
        await handleWaitingZone(USER, 'Córdoba', norm('Córdoba'), st, knowledge, deps);
        expect(st.step).toBe('waiting_payment_method');
        expect(st.deliveryZone).toBe('out');
        expect(st.shippingChoice).toBeNull();
        expect(st.paymentMethod).toBeFalsy();
        expect(lastSent()).toMatch(/Correo Argentino/);
        expect(lastSent()).toMatch(/4 días hábiles/);
        expect(lastSent()).toMatch(/tarjeta de crédito/i);
        expect(lastSent()).toMatch(/transferencia/i);
        expect(lastSent()).toMatch(/casa o en sucursal/i);
        // El servicio del Correo no se nombra: al cliente no le aporta.
        expect(lastSent()).not.toMatch(/paq\.?ar|e-?pak|pac-?ar/i);
    });

    test('fuera de zona con pista de envío ("a domicilio" dicho antes) → directo al submenú de medio', async () => {
        const st = makeState({ shippingHint: 'domicilio' });
        await handleWaitingZone(USER, 'Mendoza', norm('Mendoza'), st, knowledge, deps);
        expect(st.step).toBe('waiting_payment_method');
        expect(st.shippingChoice).toBe('domicilio');
        expect(st.paymentSubChoiceAsked).toBe(true);
        expect(lastSent()).toMatch(/Tarjeta de crédito/);
        expect(lastSent()).toMatch(/Transferencia/);
    });

    test('fuera de zona con pista "retiro" → submenú de sucursal (prepago) y calle = A sucursal', async () => {
        const st = makeState({ shippingHint: 'retiro' });
        await handleWaitingZone(USER, 'Tucumán', norm('Tucumán'), st, knowledge, deps);
        expect(st.shippingChoice).toBe('retiro');
        expect(st.partialAddress.calle).toBe('A sucursal');
        expect(lastSent()).toMatch(/retiro en sucursal/i);
        expect(lastSent()).toMatch(/Tarjeta de crédito/);
        expect(lastSent()).not.toMatch(/efectivo/i);
    });

    test('localidad desconocida → el parser saca la ciudad y el bot pregunta los km', async () => {
        mockParseAddress.mockResolvedValue({ ciudad: 'Las Parejas', provincia: 'Santa Fe' });
        const st = makeState();
        await handleWaitingZone(USER, 'Soy de Las Parejas', norm('Soy de Las Parejas'), st, knowledge, deps);
        expect(st.step).toBe('waiting_zone');
        expect(st.zoneQuestion).toBe('km');
        expect(st.partialAddress.ciudad).toBe('Las Parejas');
        expect(lastSent()).toMatch(/cuántos km/i);
    });

    test('respuesta de km ≤ 60 → dentro de zona; > 60 → fuera', async () => {
        const stIn = makeState({ zoneQuestion: 'km', partialAddress: { ciudad: 'Pueblo X' } });
        await handleWaitingZone(USER, 'unos 40 km', norm('unos 40 km'), stIn, knowledge, deps);
        expect(stIn.deliveryZone).toBe('in');
        expect(stIn.step).toBe('waiting_data');
        expect(lastSent()).toMatch(/Pueblo X/);

        const stOut = makeState({ zoneQuestion: 'km', partialAddress: { ciudad: 'Pueblo Y' } });
        await handleWaitingZone(USER, 'como 90 km', norm('como 90 km'), stOut, knowledge, deps);
        expect(stOut.deliveryZone).toBe('out');
        expect(stOut.step).toBe('waiting_payment_method');
    });

    test('provincia lejana según el parser → fuera de zona sin preguntar km', async () => {
        mockParseAddress.mockResolvedValue({ ciudad: 'Villa Dolores', provincia: 'Córdoba' });
        const st = makeState();
        await handleWaitingZone(USER, 'villa dolores', 'villa dolores', st, knowledge, deps);
        expect(st.deliveryZone).toBe('out');
        expect(st.partialAddress.ciudad).toBe('Villa Dolores');
    });

    test('quiere venir a buscarlo → no hay local, se lo llevamos si es de la zona; NO pausa', async () => {
        const st = makeState();
        await handleWaitingZone(USER, 'voy yo a buscarlo', norm('voy yo a buscarlo'), st, knowledge, deps);
        expect(pausedUsers.size).toBe(0);
        expect(lastSent()).toMatch(/no tenemos local/i);
        expect(lastSent()).toMatch(/de qué localidad sos/i);
        expect(st.step).toBe('waiting_zone');
    });

    test('pregunta en vez de contestar → la IA responde; si trae LOCALIDAD en el tag, se resuelve', async () => {
        aiService.chat.mockResolvedValue({ response: 'Llega en 4 días. ¿De qué localidad sos?', goalMet: false, extractedData: 'LOCALIDAD: Casilda' });
        const st = makeState();
        await handleWaitingZone(USER, '¿cuánto tarda en llegar? soy de casilda', norm('¿cuánto tarda en llegar? soy de casilda'), st, knowledge, deps);
        // "casilda" está en el texto, así que resuelve sin pasar por la IA.
        expect(st.deliveryZone).toBe('in');
        expect(st.partialAddress.ciudad).toBe('Casilda');
    });

    test('pregunta sin localidad → la IA responde y sigue en el step', async () => {
        aiService.chat.mockResolvedValue({ response: 'Depende de la zona 😊 ¿De qué localidad sos?', goalMet: false, extractedData: null });
        const st = makeState();
        await handleWaitingZone(USER, '¿cuánto tarda?', norm('¿cuánto tarda?'), st, knowledge, deps);
        expect(st.step).toBe('waiting_zone');
        expect(aiService.chat).toHaveBeenCalledTimes(1);
        expect(aiService.chat.mock.calls[0][1].step).toBe('waiting_zone');
        expect(lastSent()).toMatch(/localidad/i);
    });
});

// ─── Entrada desde la elección de plan ────────────────────────────────────────
describe('_startZoneStep', () => {
    test('sin localidad conocida → manda el TEXTO 4 con producto, plan y total, y pregunta la localidad', async () => {
        const st = makeState({ step: 'waiting_plan_choice', zoneQuestion: null });
        await _startZoneStep(USER, '120', st, knowledge, deps);
        expect(st.step).toBe('waiting_zone');
        expect(st.zoneQuestion).toBe('localidad');
        expect(lastSent()).toMatch(/Cápsulas × 120 días/);
        expect(lastSent()).toContain(PRICE_120);
        expect(lastSent()).toMatch(/de qué localidad sos/i);
        expect(lastSent()).not.toMatch(/zona de influencia|OPCION/i);
    });

    test('el cliente ya dijo "soy de Rosario" en el saludo → se saltea la pregunta y va al reparto', async () => {
        const st = makeState({
            step: 'waiting_plan_choice', zoneQuestion: null,
            history: [{ role: 'user', content: 'Hola! Soy de Rosario, quiero info', timestamp: 1 }, { role: 'bot', content: 'Hola!', timestamp: 2 }],
        });
        await _startZoneStep(USER, '120', st, knowledge, deps);
        expect(st.step).toBe('waiting_data');
        expect(st.deliveryZone).toBe('in');
        expect(sent).toHaveLength(1);
        expect(lastSent()).toMatch(/Rosario/);
    });

    test('"120, a domicilio" guarda la pista de envío para usarla si resulta fuera de zona', async () => {
        const st = makeState({ step: 'waiting_plan_choice', zoneQuestion: null });
        await _startZoneStep(USER, '120 a domicilio', st, knowledge, deps);
        expect(st.shippingHint).toBe('domicilio');
        expect(st.step).toBe('waiting_zone');
    });
});

describe('handleWaitingPlanChoice — la mención de Rosario ya no pausa', () => {
    test('"el de 120, soy de Rosario" → arma el carrito y resuelve la zona sin pausar', async () => {
        const st = makeState({ step: 'waiting_plan_choice', zoneQuestion: null, cart: [], selectedPlan: null, totalPrice: null,
            history: [{ role: 'user', content: 'el de 120, soy de rosario', timestamp: Date.now() }] });
        await handleWaitingPlanChoice(USER, 'el de 120, soy de rosario', norm('el de 120, soy de rosario'), st, knowledge, deps);
        expect(pausedUsers.size).toBe(0);
        expect(alerts).toHaveLength(0);
        expect(st.selectedPlan).toBe('120');
        expect(st.deliveryZone).toBe('in');
        expect(st.step).toBe('waiting_data');
    });
});

// ─── Pago fuera de zona ───────────────────────────────────────────────────────
describe('handleWaitingPaymentMethod — fuera de zona, todo prepago', () => {
    const outState = (o = {}) => makeState({ step: 'waiting_payment_method', deliveryZone: 'out', zoneQuestion: null, partialAddress: { ciudad: 'Córdoba' }, ...o });

    test('"casa" → domicilio + submenú tarjeta/transferencia', async () => {
        const st = outState();
        await handleWaitingPaymentMethod(USER, 'en mi casa', 'en mi casa', st, knowledge, deps);
        expect(st.shippingChoice).toBe('domicilio');
        expect(st.paymentSubChoiceAsked).toBe(true);
        expect(lastSent()).toMatch(/Tarjeta de crédito/);
        expect(lastSent()).toMatch(/Transferencia/);
    });

    test('"sucursal" → retiro PREPAGO: mismo submenú, calle = A sucursal, sin efectivo ni pausa', async () => {
        const st = outState();
        await handleWaitingPaymentMethod(USER, 'sucursal', 'sucursal', st, knowledge, deps);
        expect(st.shippingChoice).toBe('retiro');
        expect(st.partialAddress.calle).toBe('A sucursal');
        expect(st.paymentSubChoiceAsked).toBe(true);
        expect(st.paymentMethod).toBeFalsy();
        expect(st.step).toBe('waiting_payment_method');
        expect(lastSent()).toMatch(/retiro en sucursal/i);
        expect(lastSent()).toMatch(/Tarjeta de crédito/);
        expect(lastSent()).not.toMatch(/efectivo/i);
        expect(pausedUsers.size).toBe(0);
    });

    test('"retiro y pago por transferencia" → alias directo, sin pausa', async () => {
        const st = outState();
        await handleWaitingPaymentMethod(USER, 'retiro en sucursal y pago por transferencia', norm('retiro en sucursal y pago por transferencia'), st, knowledge, deps);
        expect(st.shippingChoice).toBe('retiro');
        expect(st.paymentMethod).toBe('transferencia');
        expect(st.step).toBe('waiting_transfer_confirmation');
        expect(lastSent()).toMatch(/HERBALIS\.TIENDA/);
        expect(pausedUsers.size).toBe(0);
    });

    test('en el submenú de domicilio dice "mejor sucursal" → cambia el envío y re-ofrece el medio', async () => {
        const st = outState({ shippingChoice: 'domicilio', paymentSubChoiceAsked: true });
        await handleWaitingPaymentMethod(USER, 'mejor en sucursal', 'mejor en sucursal', st, knowledge, deps);
        expect(st.shippingChoice).toBe('retiro');
        expect(st.partialAddress.calle).toBe('A sucursal');
        expect(st.paymentSubChoiceAsked).toBe(true);
        expect(lastSent()).toMatch(/Tarjeta de crédito/);
    });

    test('pide contrarreembolso → 1ª vez el argumento del dueño (Correo lento y caro, prepago 4 días)', async () => {
        const st = outState();
        await handleWaitingPaymentMethod(USER, 'quiero contrarreembolso', 'quiero contrarreembolso', st, knowledge, deps);
        expect(st.prepayObjections).toBe(1);
        expect(lastSent()).toMatch(/13 años/);
        expect(lastSent()).toMatch(/Correo Argentino/);
        expect(lastSent()).toMatch(/4 días hábiles/);
        expect(lastSent()).toMatch(/tarjeta de crédito|transferencia/i);
        expect(pausedUsers.size).toBe(0);
    });

    test('insiste con pagar al recibir → 2ª vez el mensaje de cierre del dueño y deriva a un asesor', async () => {
        const st = outState({ prepayObjections: 1 });
        await handleWaitingPaymentMethod(USER, 'no, yo pago cuando me llegue', norm('no, yo pago cuando me llegue'), st, knowledge, deps);
        expect(st.prepayObjections).toBe(2);
        expect(lastSent()).toMatch(/Desde hace 13 años realizamos envíos por contrarreembolso/);
        expect(lastSent()).toMatch(/Atentamente/);
        expect(pausedUsers.has(USER)).toBe(true);
        expect(alerts[alerts.length - 1].body || alerts[alerts.length - 1].title).toBeTruthy();
    });

    test('"no me gustan las transferencias" → mismo argumento (tarjeta protegida), no ofrece efectivo', async () => {
        const st = outState();
        await handleWaitingPaymentMethod(USER, 'no me gustan las transferencias, he tenido problemas', norm('no me gustan las transferencias, he tenido problemas'), st, knowledge, deps);
        expect(st.prepayObjections).toBe(1);
        expect(lastSent()).not.toMatch(/efectivo al retirar|pagás al retirar/i);
    });

    test('estado viejo sin zona resuelta → primero pregunta la localidad', async () => {
        const st = outState({ deliveryZone: null, partialAddress: {} });
        await handleWaitingPaymentMethod(USER, 'domicilio', 'domicilio', st, knowledge, deps);
        expect(st.step).toBe('waiting_zone');
        expect(st.shippingHint).toBe('domicilio');
        expect(lastSent()).toMatch(/localidad/i);
    });

    test('"voy a buscarlo" fuera de zona → no hay local, ofrece casa o sucursal, NO pausa', async () => {
        const st = outState();
        await handleWaitingPaymentMethod(USER, 'voy yo a buscarlo', norm('voy yo a buscarlo'), st, knowledge, deps);
        expect(pausedUsers.size).toBe(0);
        expect(lastSent()).toMatch(/no tenemos local/i);
        expect(lastSent()).toMatch(/casa o en sucursal/i);
    });
});

// ─── Datos del reparto propio ─────────────────────────────────────────────────
describe('handleWaitingData — reparto propio cierra con nombre + calle', () => {
    const inState = (o = {}) => makeState({
        step: 'waiting_data', deliveryZone: 'in', zoneQuestion: null,
        shippingChoice: 'reparto', paymentMethod: 'contrarembolso', senaAmount: 0,
        partialAddress: { ciudad: 'Funes' }, addressAttempts: 0, fieldReaskCount: {}, ...o,
    });

    test('nombre + calle → orden Confirmado con calle real, ciudad de la zona y aviso al admin', async () => {
        mockParseAddress.mockResolvedValue({ nombre: 'Marta López', calle: 'Mitre 1234' });
        const st = inState();
        await handleWaitingData(USER, 'Marta López, Mitre 1234', norm('Marta López, Mitre 1234'), st, knowledge, deps);
        expect(orders).toHaveLength(1);
        expect(orders[0]).toMatchObject({ nombre: 'Marta López', calle: 'Mitre 1234', ciudad: 'Funes', paymentMethod: 'contrarembolso', status: 'Confirmado' });
        expect(st.step).toBe('completed');
        expect(alerts[0].title).toMatch(/VENTA CERRADA/);
        expect(alerts[0].body).toMatch(/REPARTO PROPIO/);
        expect(lastSent()).toMatch(/Reparto propio a tu domicilio en Funes/);
        expect(lastSent()).toMatch(/al recibir/i);
        expect(lastSent()).not.toMatch(/Correo|sucursal|días hábiles/);
    });

    test('solo el nombre → pide únicamente la calle, no vuelve a pedir la localidad ni CP', async () => {
        mockParseAddress.mockResolvedValue({ nombre: 'Marta López' });
        const st = inState();
        await handleWaitingData(USER, 'Marta López', norm('Marta López'), st, knowledge, deps);
        expect(orders).toHaveLength(0);
        expect(st.partialAddress.nombre).toBe('Marta López');
        expect(lastSent()).toMatch(/Calle y número/);
        expect(lastSent()).not.toMatch(/Localidad|Código postal/i);
    });

    test('"lo paso a buscar" en zona → no hay sucursal, se lo llevamos; sigue pidiendo datos', async () => {
        const st = inState();
        await handleWaitingData(USER, 'lo paso a buscar yo', norm('lo paso a buscar yo'), st, knowledge, deps);
        expect(lastSent()).toMatch(/Te lo llevamos nosotros/i);
        expect(st.partialAddress.calle).toBeUndefined();
        expect(st.step).toBe('waiting_data');
    });
});

// ─── FAQ global con la zona resuelta ──────────────────────────────────────────
describe('globalFaq — las FAQ de envío/pago ceden al paso cuando la zona ya se sabe', () => {
    const { handleFaq } = require('../src/flows/globals/globalFaq');

    test('"quiero contrarreembolso, pago cuando me llega" fuera de zona → NO contesta la FAQ (ni la de garantías)', async () => {
        const st = makeState({ step: 'waiting_payment_method', deliveryZone: 'out', zoneQuestion: null, partialAddress: { ciudad: 'Córdoba' } });
        const txt = 'quiero contrarreembolso, pago cuando me llega';
        const res = await handleFaq(USER, txt, norm(txt), st, knowledge, deps);
        expect(res).toBeNull();
        expect(sent).toHaveLength(0);
        // …y el paso lo toma como objeción de prepago.
        await handleWaitingPaymentMethod(USER, txt, norm(txt), st, knowledge, deps);
        expect(st.prepayObjections).toBe(1);
        expect(lastSent()).toMatch(/13 años/);
    });

    test('la misma pregunta SIN zona resuelta la responde la FAQ de pago al recibir (que pide la localidad)', async () => {
        const st = makeState({ step: 'waiting_plan_choice', zoneQuestion: null });
        const txt = '¿hacen contrarreembolso?';
        const res = await handleFaq(USER, txt, norm(txt), st, knowledge, deps);
        expect(res).toEqual({ matched: true });
        expect(lastSent()).toMatch(/Rosario y hasta 60 km/);
        expect(lastSent()).toMatch(/de qué localidad sos/i);
        expect(lastSent()).not.toMatch(/dañado|devolución/i);
    });
});

// ─── Confirmaciones y placeholders ────────────────────────────────────────────
describe('placeholders de zona en las confirmaciones', () => {
    test('reparto → plantilla propia, sin plazo de Correo', () => {
        const st = makeState({ shippingChoice: 'reparto', paymentMethod: 'contrarembolso', pendingOrder: { ciudad: 'Roldán', calle: 'San Martín 50', cart: [] }, partialAddress: {} });
        const msg = buildConfirmationMessage(st, knowledge);
        expect(msg).toMatch(/Total a pagar al recibir/);
        expect(msg).toMatch(/Roldán/);
        expect(msg).not.toMatch(/Entrega estimada|Correo/);
    });
    test('retiro prepago con tarjeta → línea de sucursal con las 72 hs', () => {
        const st = makeState({ shippingChoice: 'retiro', paymentMethod: 'mercadopago', pendingOrder: { ciudad: 'Córdoba', calle: 'A sucursal', cart: [] }, partialAddress: {} });
        const msg = buildConfirmationMessage(st, knowledge);
        expect(msg).toMatch(/retiro en la sucursal más cercana a tu código postal/);
        expect(msg).toMatch(/72 hs/);
        expect(msg).toMatch(/4 días hábiles/);
        expect(msg).not.toMatch(/envío a domicilio/);
    });
    test('domicilio prepago con transferencia → línea de domicilio', () => {
        const st = makeState({ shippingChoice: 'domicilio', paymentMethod: 'transferencia', pendingOrder: { ciudad: 'Córdoba', calle: 'Colón 100', cart: [] }, partialAddress: {} });
        const msg = buildConfirmationMessage(st, knowledge);
        expect(msg).toMatch(/envío a domicilio/);
        expect(msg).toMatch(/cartero/);
    });
    test('retiro contrarreembolso viejo (pre sep-2026) conserva su plantilla y sus 7 a 10 días', () => {
        const st = makeState({ shippingChoice: 'retiro', paymentMethod: 'contrarembolso', senaAmount: 0, pendingOrder: { ciudad: 'Salta', calle: 'A sucursal', cart: [] }, partialAddress: {} });
        const msg = buildConfirmationMessage(st, knowledge);
        expect(msg).toMatch(/Total a pagar al retirar/);
        expect(msg).toMatch(/7 a 10 días hábiles/);
    });
    test('{{LOCALIDAD}} cae a "tu zona" si no se conoce', () => {
        expect(_formatMessage('a {{LOCALIDAD}} llegamos', makeState({ partialAddress: {} }))).toBe('a tu zona llegamos');
    });
});

// ─── El guion ─────────────────────────────────────────────────────────────────
describe('knowledge_v7.json — guion por zona', () => {
    test('trae las entradas nuevas y la lista de localidades', () => {
        for (const k of ['payment_menu', 'zone_km', 'zone_reask', 'zone_no_local', 'zone_in', 'zone_out', 'payment_sucursal_choice', 'prepay_objection', 'prepay_refusal_close', 'payment_mp_link_sucursal', 'closing_sucursal', 'order_confirmation_reparto']) {
            expect(knowledge.flow[k]?.response).toBeTruthy();
        }
        expect(knowledge.rules.repartoPropio.localidades).toContain('Rosario');
        expect(knowledge.rules.repartoPropio.localidades).toContain('Funes');
        expect(knowledge.rules.repartoPropio.radioKm).toBe(60);
    });
    test('ninguna FAQ ni texto del flujo ofrece retiro en efectivo ni promete 7 a 10 días (salvo la confirmación legacy)', () => {
        const texts = [];
        for (const [k, v] of Object.entries(knowledge.flow)) {
            if (k === 'order_confirmation_cod') continue;
            for (const f of ['response', 'responseNoMp']) if (v[f]) texts.push([k, v[f]]);
        }
        knowledge.faq.forEach((f, i) => { for (const x of ['response', 'responseNoMp']) if (f[x]) texts.push([`faq[${i}]`, f[x]]); });
        for (const [k, t] of texts) {
            expect({ k, ok: !/7 a 10|7 y 10|efectivo al retirar|efectivo cuando lo retir|zona de influencia/i.test(t) }).toEqual({ k, ok: true });
        }
    });
});
