/**
 * Payment method flow tests — modelo vigente (may-2026 rev 2).
 *
 * Cobertura:
 *  - stepWaitingPaymentMethod → menú de envío 2-opciones (retiro vs domicilio)
 *      · "1" / "retiro" / "sucursal" → contrarrembolso, paga total al retirar (pause+alert)
 *      · "2" / "domicilio" / "casa" → submenú MP/Transferencia (paymentSubChoiceAsked=true)
 *      · Atajos: "mp"/"mercadopago" → MP directo; "transferencia" → alias directo
 *  - stepWaitingMpPayment — link normal por el total
 *  - Subflow email + retry/error handling MP
 *  - Compat legacy: state con senaAmount=10000 sigue generando link de seña
 *    (path muerto en el flow nuevo, pero código aún lo soporta para conversaciones
 *    pre-may-2026 que estén abiertas).
 *
 * Sin adicional $6.000, sin anticipo $10.000 en el flow nuevo, sin cuotas.
 */

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));

// ─── Mocks MP ───────────────────────────────────────────────────────────────
const mockPreferenceCreate = jest.fn().mockResolvedValue({
    id: 'pref_test',
    init_point: 'https://mp.com/checkout/pref_test',
});
const mockPaymentSearch = jest.fn().mockResolvedValue({ results: [] });

jest.mock('mercadopago', () => ({
    MercadoPagoConfig: jest.fn(() => ({})),
    Preference: jest.fn(() => ({ create: mockPreferenceCreate })),
    Payment: jest.fn(() => ({ search: mockPaymentSearch })),
}), { virtual: true });

// ─── Mocks DB ────────────────────────────────────────────────────────────────
const mockPaymentLinkCreate = jest.fn().mockResolvedValue({ id: 'pl-1', status: 'pending', externalRef: 'ref-1' });
const mockPaymentLinkFindUnique = jest.fn().mockResolvedValue(null);
const mockPaymentLinkUpdate = jest.fn().mockResolvedValue({ id: 'pl-1', status: 'approved' });

jest.mock('../db', () => ({
    prisma: {
        order: {
            create: jest.fn().mockResolvedValue({ id: 'order-1' }),
            findFirst: jest.fn().mockResolvedValue(null),
        },
        user: { upsert: jest.fn().mockResolvedValue({}) },
        chatLog: {
            create: jest.fn().mockResolvedValue({}),
            findMany: jest.fn().mockResolvedValue([]),
        },
        paymentLink: {
            create: mockPaymentLinkCreate,
            findUnique: mockPaymentLinkFindUnique,
            update: mockPaymentLinkUpdate,
        },
    },
}));

jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: 'AI fallback', goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue({}),
    },
}));

const { handleWaitingPaymentMethod } = require('../src/flows/steps/stepWaitingPaymentMethod');
const { handleWaitingMpPayment } = require('../src/flows/steps/stepWaitingMpPayment');
const { handleWaitingTransferConfirmation } = require('../src/flows/steps/stepWaitingTransferConfirmation');
const { aiService } = require('../src/services/ai');

// ─── Shared mocks ────────────────────────────────────────────────────────────
const mockSend = jest.fn();
const mockSave = jest.fn();
const mockNotify = jest.fn();
const mockPauseUsers = new Set();

const deps = {
    saveState: mockSave,
    sendMessageWithDelay: mockSend,
    notifyAdmin: mockNotify,
    aiService,
    sellerId: 'vendedor_test',
    sharedState: {
        pausedUsers: mockPauseUsers,
        io: null,
        saveState: mockSave,
        config: { alertNumbers: [] },
    },
    config: { alertNumbers: [] },
    logAndEmit: jest.fn(),
};

const knowledge = {
    flow: {
        closing: { response: 'Pasame los datos', nextStep: 'waiting_data' },
        ok: { response: 'Confirmado correo', nextStep: 'waiting_data' },
    },
};

// ─── State factories ─────────────────────────────────────────────────────────
function makeOkState(overrides = {}) {
    return {
        step: 'waiting_ok',
        history: [{ role: 'bot', content: '¿Podés retirar en sucursal?', timestamp: Date.now() }],
        cart: [{ product: 'Cápsulas', plan: '60', price: '46.900' }],
        selectedProduct: 'Cápsulas',
        selectedPlan: '60',
        totalPrice: '46.900',
        adicionalMAX: 0,
        isContraReembolsoMAX: false,
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        ...overrides,
    };
}

function makePaymentState(plan = '60', overrides = {}) {
    return {
        step: 'waiting_payment_method',
        history: [],
        cart: [{ product: 'Cápsulas', plan, price: plan === '60' ? '46.900' : '66.900' }],
        selectedProduct: 'Cápsulas',
        selectedPlan: plan,
        totalPrice: plan === '60' ? '46.900' : '66.900',
        adicionalMAX: 0,
        isContraReembolsoMAX: false,
        partialAddress: { calle: 'Belgrano 123', ciudad: 'Rosario', cp: '2000' },
        summary: '',
        stepEnteredAt: Date.now(),
        ...overrides,
    };
}

function makeMpState(overrides = {}) {
    return {
        step: 'waiting_mp_payment',
        history: [],
        cart: [{ product: 'Cápsulas', plan: '60', price: '46.900' }],
        selectedProduct: 'Cápsulas',
        selectedPlan: '60',
        totalPrice: '46.900',
        paymentMethod: 'mercadopago',
        adicionalMAX: 0,
        isContraReembolsoMAX: false,
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        // Por defecto saltean el subflow de email para probar la generación del
        // link directamente. Tests específicos del subflow setean email=undefined
        // + emailAskedAt=undefined explícitamente.
        email: '',
        emailAskedAt: Date.now(),
        ...overrides,
    };
}

// Legacy: state pre-may-2026 con senaAmount > 0. El flow nuevo NO setea este
// campo, pero el código aún lo soporta para conversaciones que estén abiertas
// desde antes del cambio.
function makeLegacySenaState(overrides = {}) {
    return {
        step: 'waiting_mp_payment',
        history: [],
        cart: [{ product: 'Cápsulas', plan: '60', price: '46.900' }],
        selectedProduct: 'Cápsulas',
        selectedPlan: '60',
        totalPrice: '46.900',
        paymentMethod: 'contrarembolso',
        senaAmount: 10000,
        senaPaid: false,
        adicionalMAX: 0,
        isContraReembolsoMAX: false,
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        email: '',
        emailAskedAt: Date.now(),
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockPauseUsers.clear();
    process.env.MP_ACCESS_TOKEN = 'TEST_TOKEN';
});

afterAll(() => { delete process.env.MP_ACCESS_TOKEN; });

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 1 (stepWaitingOk) ELIMINADO: el step waiting_ok no existe en V7 —
// stepWaitingWeight/Preference van directo a waiting_payment_method. El handler
// fue removido del código; ver migración legacy en src/flows/steps/index.ts.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 1b: malentendido "pago al recibir" con medio prepago (caso 5492954235122)
// ════════════════════════════════════════════════════════════════════════════
describe('Aclaración "pago al recibir" con MP/domicilio', () => {
    const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

    test('"Envío a domicilio pago con mercado pago al recibir" → aclara, NO avanza al link/submenú', async () => {
        const state = makePaymentState('60');
        const txt = 'Envio a domicilio pago con mercado pago al recibir';
        await handleWaitingPaymentMethod('m1', txt, norm(txt), state, knowledge, deps);
        expect(state.step).toBe('waiting_payment_method');
        expect(state.paymentMethod).not.toBe('mercadopago');
        expect(state.paymentSubChoiceAsked).toBeFalsy();
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/antes del env[íi]o|al cartero no se le paga/i);
        expect(sent).toMatch(/retiro en sucursal/i);
    });

    test('"retiro en sucursal y pago al recibir en efectivo" → NO es malentendido, va a retiro', async () => {
        const state = makePaymentState('60');
        const txt = 'retiro en sucursal y pago al recibir en efectivo';
        await handleWaitingPaymentMethod('m2', txt, norm(txt), state, knowledge, deps);
        expect(state.shippingChoice).toBe('retiro');
        expect(state.paymentMethod).toBe('contrarembolso');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 1c: malentendido "lo pago en mi domicilio" / "pago en casa"
// Caso real 5492915126300 (30-jun): respondió "Lo pago en mi domicilio" al menú de
// envío. El bot vio "domicilio" y la mandó al submenú prepago; ella eligió
// transferencia creyendo que pagaba al llegar el paquete → venta fantasma. Quería
// PAGAR AL RECIBIR EN SU CASA (contrareembolso a domicilio, eliminado may-2026).
// El bot debe aclarar que pagar al recibir en efectivo es SOLO retiro en sucursal.
// ════════════════════════════════════════════════════════════════════════════
describe('Aclaración "pago en mi domicilio / en casa" (caso 5492915126300)', () => {
    const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

    test('"Lo pago en mi domicilio" → aclara retiro en sucursal, NO asume domicilio ni muestra submenú', async () => {
        const state = makePaymentState('60');
        mockSend.mockClear();
        const txt = 'Lo pago en mi domicilio';
        await handleWaitingPaymentMethod('ph1', txt, norm(txt), state, knowledge, deps);
        // No debe tomarlo como elección de domicilio ni abrir el submenú prepago.
        expect(state.shippingChoice).toBeFalsy();
        expect(state.paymentSubChoiceAsked).toBeFalsy();
        expect(state.paymentMethod).toBeFalsy();
        expect(state.step).toBe('waiting_payment_method');
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/retiro en sucursal/i);
        expect(sent).toMatch(/al cartero.*no se le paga|en la puerta de tu casa/i);
        // No debe haber mandado el submenú "lo mandamos a tu domicilio".
        expect(sent).not.toMatch(/lo mandamos a tu domicilio/i);
    });

    test('"pago en casa" → misma aclaración', async () => {
        const state = makePaymentState('60');
        mockSend.mockClear();
        const txt = 'pago en casa';
        await handleWaitingPaymentMethod('ph2', txt, norm(txt), state, knowledge, deps);
        expect(state.paymentSubChoiceAsked).toBeFalsy();
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/retiro en sucursal/i);
        expect(sent).toMatch(/efectivo/i);
    });

    test('"lo pago en mi domicilio con tarjeta" → NO dispara la aclaración (nombró prepago, sigue como domicilio)', async () => {
        const state = makePaymentState('60');
        mockSend.mockClear();
        const txt = 'lo pago en mi domicilio con tarjeta';
        await handleWaitingPaymentMethod('ph3', txt, norm(txt), state, knowledge, deps);
        // Nombró tarjeta → entiende el prepago: el guard NO debe interceptar con la
        // aclaración de "pago al recibir". Sigue el camino normal de domicilio.
        expect(state.shippingChoice).toBe('domicilio');
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).not.toMatch(/al cartero.*no se le paga|en la puerta de tu casa/i);
    });

    test('regresión: "domicilio" solo (sin verbo de pago) SIGUE yendo al submenú', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('ph4', 'domicilio', norm('domicilio'), state, knowledge, deps);
        expect(state.shippingChoice).toBe('domicilio');
        expect(state.paymentSubChoiceAsked).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 2: stepWaitingPaymentMethod — Retiro en sucursal (opción 1)
// ════════════════════════════════════════════════════════════════════════════
describe('Ambigüedad de envío — nombra LAS DOS opciones (caso 5493815010702)', () => {
    const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

    test('"Sucursal o abonar envío a domicilio" → NO asume, re-pregunta', async () => {
        const state = makePaymentState('60');
        mockSend.mockClear();
        const txt = 'Sucursal o abonar envío a domicilio';
        await handleWaitingPaymentMethod('amb1', txt, norm(txt), state, knowledge, deps);
        // No debe asumir NINGUNA opción ni avanzar a pago/datos.
        expect(state.shippingChoice).toBeFalsy();
        expect(state.paymentMethod).toBeFalsy();
        expect(state.step).toBe('waiting_payment_method');
        // Debe re-preguntar cuál de las dos.
        const sent = mockSend.mock.calls.map(c => c[1]).join('\n');
        expect(sent).toMatch(/dos opciones|con cu[áa]l/i);
    });

    test('"sucursal" sola → retiro (no ambiguo, sigue funcionando)', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('amb2', 'sucursal', norm('sucursal'), state, knowledge, deps);
        expect(state.shippingChoice).toBe('retiro');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 2b: desconfía del pago anticipado → liderar con RETIRO EN SUCURSAL
// Caso 5492262484928 (26-jun): "Soy de pcia Bs As..no me gustan transferencias
// ..he tenido problema". El bot insistía con tarjeta (otro prepago); la vendedora
// a mano ofreció "pagás cuando retirás / sucursal". El bot debe hacer lo mismo.
// ════════════════════════════════════════════════════════════════════════════
describe('Desconfía del pago anticipado → ofrece retiro en sucursal (caso 5492262484928)', () => {
    const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

    test('"no me gustan transferencias, he tenido problema" → ofrece retiro, NO insiste con prepago', async () => {
        const state = makePaymentState('60');
        mockSend.mockClear();
        const txt = 'Soy de pcia Bs As..no me gustan transferencias..he tenido problema';
        await handleWaitingPaymentMethod('dp1', txt, norm(txt), state, knowledge, deps);
        // No avanza a transferencia ni al submenú prepago.
        expect(state.paymentMethod).toBeFalsy();
        expect(state.paymentSubChoiceAsked).toBeFalsy();
        expect(state.step).toBe('waiting_payment_method');
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/retiro en sucursal/i);
        expect(sent).toMatch(/al retir[áa]s|cuando lo retir[áa]s|efectivo/i);
        expect(sent).toMatch(/no .*por adelantado|sin transferencias/i);
    });

    test('"me da miedo pagar por adelantado" → ofrece retiro en sucursal', async () => {
        const state = makePaymentState('60');
        mockSend.mockClear();
        const txt = 'me da miedo pagar por adelantado';
        await handleWaitingPaymentMethod('dp2', txt, norm(txt), state, knowledge, deps);
        expect(state.paymentMethod).toBeFalsy();
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/retiro en sucursal/i);
    });

    test('"prefiero sucursal, no me gustan las transferencias" → va a RETIRO (no intercepta el guard)', async () => {
        const state = makePaymentState('60');
        const txt = 'prefiero sucursal, no me gustan las transferencias';
        await handleWaitingPaymentMethod('dp3', txt, norm(txt), state, knowledge, deps);
        expect(state.shippingChoice).toBe('retiro');
        expect(state.paymentMethod).toBe('contrarembolso');
    });

    test('"no me gustan las transferencias, pago con tarjeta" → respeta la tarjeta (no fuerza sucursal)', async () => {
        const state = makePaymentState('60');
        const txt = 'no me gustan las transferencias, pago con tarjeta';
        await handleWaitingPaymentMethod('dp4', txt, norm(txt), state, knowledge, deps);
        // Eligió tarjeta → MP, el guard de desconfianza NO debe interceptar.
        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.step).toBe('waiting_mp_payment');
    });
});

describe('Menú envío → Retiro en sucursal (opción 1)', () => {

    test('[2.1] "1" → retiro en sucursal (contrarrembolso, sin anticipo)', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('r1', '1', '1', state, knowledge, deps);
        expect(state.shippingChoice).toBe('retiro');
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.senaAmount).toBe(0);
        expect(state.senaPaid).toBe(false);
    });

    test('[2.2] "retiro en sucursal" → retiro', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('r2', 'retiro en sucursal', 'retiro en sucursal', state, knowledge, deps);
        expect(state.shippingChoice).toBe('retiro');
        expect(state.paymentMethod).toBe('contrarembolso');
    });

    test('[2.3] "contra reembolso" → retiro (mismo branch que sucursal)', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('r3', 'contra reembolso', 'contra reembolso', state, knowledge, deps);
        expect(state.shippingChoice).toBe('retiro');
        expect(state.paymentMethod).toBe('contrarembolso');
    });

    test('[2.4] Mensaje de confirmación incluye total a pagar al retirar', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('r4', '1', '1', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/sucursal/i);
        expect(sent).toMatch(/efectivo/i);
        // El bot NO debe mencionar anticipo en el flow nuevo.
        expect(sent).not.toMatch(/anticipo/i);
        expect(sent).not.toMatch(/10\.000/);
    });

    test('[2.5] Tras elegir retiro, pide SOLO localidad + CP (no calle) y pre-setea calle="A sucursal"', async () => {
        // Rev. 2026-05-31: retiro NO pide calle/número. Con localidad + CP se
        // asigna la sucursal que corresponde. Pre-setea partialAddress.calle="A
        // sucursal" para que waiting_data no pida ni valide la calle.
        const state = makePaymentState('60', { partialAddress: {} });
        await handleWaitingPaymentMethod('r5', '1', '1', state, knowledge, deps);
        expect(state.shippingChoice).toBe('retiro');
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.step).toBe('waiting_data');
        expect(state.partialAddress.calle).toBe('A sucursal');
        expect(deps.sharedState.pausedUsers.has('r5')).toBe(false);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/retiro en sucursal/i);
        expect(sent).toMatch(/localidad/i);
        expect(sent).toMatch(/c[óo]digo postal/i);
        // NO debe pedir calle y número
        expect(sent).not.toMatch(/calle y n[úu]mero/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 3: stepWaitingPaymentMethod — Envío a domicilio (opción 2 + submenú)
// ════════════════════════════════════════════════════════════════════════════
describe('Menú envío → Envío a domicilio (opción 2) + submenú prepago', () => {

    test('[3.1] "2" → setea shippingChoice=domicilio y muestra submenú Tarjeta/Transfer', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('d1', '2', '2', state, knowledge, deps);
        expect(state.shippingChoice).toBe('domicilio');
        expect(state.paymentSubChoiceAsked).toBe(true);
        expect(state.step).toBe('waiting_payment_method'); // sigue esperando submenú
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/Tarjeta de cr[ée]dito/i);
        expect(sent).toMatch(/Transferencia bancaria/i);
        expect(sent).not.toMatch(/mercado\s?pago/i);
    });

    test('[3.2] "domicilio" → submenú', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('d2', 'domicilio', 'domicilio', state, knowledge, deps);
        expect(state.shippingChoice).toBe('domicilio');
        expect(state.paymentSubChoiceAsked).toBe(true);
    });

    test('[3.3] "a mi casa" → domicilio + submenú', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('d3', 'a mi casa', 'a mi casa', state, knowledge, deps);
        expect(state.shippingChoice).toBe('domicilio');
        expect(state.paymentSubChoiceAsked).toBe(true);
    });

    test('[3.4] Submenú "1" / MP → paymentMethod=mercadopago + step waiting_mp_payment', async () => {
        const state = makePaymentState('60', { shippingChoice: 'domicilio', paymentSubChoiceAsked: true });
        const r = await handleWaitingPaymentMethod('d4', '1', '1', state, knowledge, deps);
        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.senaAmount).toBeNull();
        expect(state.step).toBe('waiting_mp_payment');
        // El handler de MP arma el link via staleReprocess.
        expect(r.staleReprocess).toBe(true);
    });

    test('[3.5] Submenú "mercadopago" → MP', async () => {
        const state = makePaymentState('60', { shippingChoice: 'domicilio', paymentSubChoiceAsked: true });
        await handleWaitingPaymentMethod('d5', 'mercadopago', 'mercadopago', state, knowledge, deps);
        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.step).toBe('waiting_mp_payment');
    });

    test('[3.6] Submenú "2" / Transfer → alias + step waiting_transfer_confirmation', async () => {
        const state = makePaymentState('60', { shippingChoice: 'domicilio', paymentSubChoiceAsked: true });
        await handleWaitingPaymentMethod('d6', '2', '2', state, knowledge, deps);
        expect(state.paymentMethod).toBe('transferencia');
        expect(state.senaAmount).toBeNull();
        expect(state.step).toBe('waiting_transfer_confirmation');
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/HERBALIS\.TIENDA/);
        expect(sent).toMatch(/BIO ORIGEN S.A.S./);
    });

    // Combo jun-2026: el cliente puede pedir RETIRO en sucursal pagando por
    // TRANSFERENCIA. No es el flujo estándar (retiro = efectivo) → damos el alias,
    // pedimos datos para la sucursal y derivamos a un asesor (no auto-confirmamos).
    test('[3.7] "retiro en sucursal pero pago por transferencia" → retiro + transferencia + alias + pausa', async () => {
        mockPauseUsers.clear();
        const state = makePaymentState('60');
        const txt = 'quiero retiro en sucursal pero pagar por transferencia';
        await handleWaitingPaymentMethod('combo1', txt, txt, state, knowledge, deps);
        expect(state.shippingChoice).toBe('retiro');
        expect(state.paymentMethod).toBe('transferencia');
        expect(state.partialAddress.calle).toBe('A sucursal');
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/HERBALIS\.TIENDA/);
        expect(sent).toMatch(/sucursal/i);
        expect(sent).toMatch(/transferencia/i);
        // Combo no estándar → derivado a un asesor para coordinar/verificar.
        expect(mockPauseUsers.has('combo1')).toBe(true);
    });

    test('[3.7] Submenú "transferencia" → transfer', async () => {
        const state = makePaymentState('60', { shippingChoice: 'domicilio', paymentSubChoiceAsked: true });
        await handleWaitingPaymentMethod('d7', 'transferencia', 'transferencia', state, knowledge, deps);
        expect(state.paymentMethod).toBe('transferencia');
        expect(state.step).toBe('waiting_transfer_confirmation');
    });

    test('[3.8] Submenú ambiguo → responde vía IA, NO re-pregunta a ciegas', async () => {
        const state = makePaymentState('60', { shippingChoice: 'domicilio', paymentSubChoiceAsked: true });
        aiService.chat.mockClear();
        mockSend.mockClear();
        await handleWaitingPaymentMethod('d8', 'no se', 'no se', state, knowledge, deps);
        expect(state.step).toBe('waiting_payment_method');
        expect(aiService.chat).toHaveBeenCalled();
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/AI fallback/); // respondió la duda, no el menú repetido
    });

    // Regresión bucle 5491156581277: el cliente preguntaba si podía pagar en
    // efectivo en el domicilio y el bot re-mandaba el submenú 5 veces.
    test('[3.8b] Submenú "sería al contado" → aclara retiro en sucursal (no bucle)', async () => {
        const state = makePaymentState('60', { shippingChoice: 'domicilio', paymentSubChoiceAsked: true });
        mockSend.mockClear();
        await handleWaitingPaymentMethod('d8b', 'Sería al contado', 'seria al contado', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/sucursal/i);
        expect(sent).toMatch(/retiro/i);
        expect(state.paymentSubChoiceAsked).toBe(false);
    });

    test('[3.8c] Submenú "no me pasaste el precio" → responde el precio', async () => {
        const state = makePaymentState('60', { shippingChoice: 'domicilio', paymentSubChoiceAsked: true });
        mockSend.mockClear();
        await handleWaitingPaymentMethod('d8c', 'Pero no me pasastes el precio', 'pero no me pasastes el precio', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/46\.900/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 3b: en transferencia, cliente cambia a "retiro en sucursal" (venta fantasma 5493442465660)
// ════════════════════════════════════════════════════════════════════════════
describe('waiting_transfer_confirmation → cliente pide retiro en sucursal', () => {
    const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

    test('"Sisi retiro en sucursal" reencamina a payment_method (no se queda en transfer ni inventa confirmación)', async () => {
        const state = makePaymentState('60', {
            step: 'waiting_transfer_confirmation',
            paymentMethod: 'transferencia',
            shippingChoice: 'domicilio',
        });
        const txt = 'Sisi retiro en sucursal, me dijiste que es envío gratuito';
        const r = await handleWaitingTransferConfirmation('t1', txt, norm(txt), state, knowledge, deps);
        expect(r.staleReprocess).toBe(true);
        expect(state.step).toBe('waiting_payment_method');
        expect(state.paymentMethod).toBeNull();
        expect(state.shippingChoice).toBeNull();
    });

    test('"listo" sí confirma transferencia (no se rompe el caso normal)', async () => {
        const state = makePaymentState('60', {
            step: 'waiting_transfer_confirmation',
            paymentMethod: 'transferencia',
            shippingChoice: 'domicilio',
        });
        await handleWaitingTransferConfirmation('t2', 'listo ya transferí', 'listo ya transferi', state, knowledge, deps);
        expect(deps.sharedState.pausedUsers.has('t2')).toBe(true); // pausa para verificar comprobante
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 4: Atajos — cliente menciona medio de pago directo (sin elegir envío)
// El bot asume DOMICILIO (es el único que admite estos medios).
// ════════════════════════════════════════════════════════════════════════════
describe('Atajos de pago (sin elegir envío explícito → asume domicilio)', () => {

    test('[4.1] "mercadopago" → domicilio + MP', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('a1', 'mercadopago', 'mercadopago', state, knowledge, deps);
        expect(state.shippingChoice).toBe('domicilio');
        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.step).toBe('waiting_mp_payment');
    });

    test('[4.2] "mp" → MP', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('a2', 'mp', 'mp', state, knowledge, deps);
        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.step).toBe('waiting_mp_payment');
    });

    test('[4.3] MP NO setea senaAmount (siempre por el total)', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('a3', 'mercadopago', 'mercadopago', state, knowledge, deps);
        expect(state.senaAmount).toBeFalsy();
    });

    test('[4.4] "transferencia" → domicilio + alias', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('a4', 'transferencia', 'transferencia', state, knowledge, deps);
        expect(state.shippingChoice).toBe('domicilio');
        expect(state.paymentMethod).toBe('transferencia');
        expect(state.step).toBe('waiting_transfer_confirmation');
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/HERBALIS\.TIENDA/);
    });

    test('[4.5] "alias" → transferencia', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('a5', 'alias', 'alias', state, knowledge, deps);
        expect(state.paymentMethod).toBe('transferencia');
    });

    test('[4.6] Plan 60: totalPrice queda como base (sin adicional, política mayo 2026)', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('a6', 'mercadopago', 'mercadopago', state, knowledge, deps);
        expect(state.totalPrice).toBe('46.900');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 5: stepWaitingMpPayment — link MP por el total
// ════════════════════════════════════════════════════════════════════════════
describe('stepWaitingMpPayment — link MP por el total', () => {

    test('[5.1] Entry sin link → genera preferencia MP por totalPrice', async () => {
        const state = makeMpState();
        await handleWaitingMpPayment('mppy1', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(1);
        const call = mockPreferenceCreate.mock.calls[0][0];
        expect(call.body.items[0].unit_price).toBe(46900);
        expect(call.body.items[0].title).toBe('Pago Herbalis');
        expect(state.mpPaymentLinkUrl).toBe('https://mp.com/checkout/pref_test');
    });

    test('[5.2] mensaje al cliente del link normal dice "Total" (no "Seña")', async () => {
        const state = makeMpState();
        await handleWaitingMpPayment('mppy2', 'hola', 'hola', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/tarjeta de cr[ée]dito/i);
        expect(sent).toMatch(/Total/i);
        expect(sent).not.toMatch(/Seña/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 6 (LEGACY compat): state pre-may-2026 con senaAmount=10000
// El flow nuevo NUNCA setea senaAmount > 0, pero conversaciones que estén
// abiertas desde antes del cambio aún tienen ese campo. El código aún las
// procesa correctamente (genera link MP por $10k) hasta que terminan.
// ════════════════════════════════════════════════════════════════════════════
describe('Compat legacy — state pre-may-2026 con senaAmount=10000', () => {

    test('[6.1] Link MP se genera por $10.000 cuando senaAmount=10000', async () => {
        const state = makeLegacySenaState();
        await handleWaitingMpPayment('legacy1', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(1);
        const call = mockPreferenceCreate.mock.calls[0][0];
        expect(call.body.items[0].unit_price).toBe(10000);
        expect(call.body.items[0].title).toMatch(/Seña/i);
    });

    test('[6.2] PaymentLink en DB se persiste con source="bot_flow_sena"', async () => {
        const state = makeLegacySenaState();
        await handleWaitingMpPayment('legacy2', 'hola', 'hola', state, knowledge, deps);
        expect(mockPaymentLinkCreate).toHaveBeenCalledTimes(1);
        const arg = mockPaymentLinkCreate.mock.calls[0][0].data;
        expect(arg.source).toBe('bot_flow_sena');
        expect(arg.amount).toBe(10000);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 6b: Email opcional sin subflow obligatorio (rev 2026-05-27)
// ════════════════════════════════════════════════════════════════════════════
//
// El subflow de email que pedía mail ANTES de generar el link MP fue eliminado
// — era fricción innecesaria. Ahora:
//   - Sin link: se genera directo sin payer.email.
//   - Si state.email ya existe (capturado silenciosamente desde stepWaitingData
//     cuando el cliente lo deja caer junto a los datos de envío), se pre-llena
//     payer.email en la preferencia MP para el comprobante automático.
//
describe('stepWaitingMpPayment — email opcional', () => {

    test('[6b.1] Sin email en state → genera link directo SIN pedir email primero', async () => {
        const state = makeMpState({ email: undefined });
        await handleWaitingMpPayment('em1', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(1);
        const call = mockPreferenceCreate.mock.calls[0][0];
        expect(call.body.payer).toBeUndefined();
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        // Manda el link de pago — no pregunta por el email primero.
        expect(sent).toMatch(/tarjeta de cr[ée]dito|mp\.com\/checkout/i);
    });

    test('[6b.2] Email previamente capturado en waiting_data → genera link CON payer.email', async () => {
        const state = makeMpState({ email: 'juan.perez@gmail.com' });
        await handleWaitingMpPayment('em2', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(1);
        const call = mockPreferenceCreate.mock.calls[0][0];
        expect(call.body.payer).toEqual({ email: 'juan.perez@gmail.com' });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 6c: Retry + error handling al crear el link MP
// ════════════════════════════════════════════════════════════════════════════
describe('stepWaitingMpPayment — retry/error handling', () => {

    test('[6c.1] MP falla 1 vez y luego anda → 2 intentos, link entregado, sin pause', async () => {
        // Sin subflow de email, el link se genera al entrar a waiting_mp_payment.
        const state = makeMpState({ email: undefined });
        mockPreferenceCreate.mockRejectedValueOnce(new Error('Network blip'));
        await handleWaitingMpPayment('retry1', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(2);
        expect(state.mpPaymentLinkUrl).toBe('https://mp.com/checkout/pref_test');
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).not.toMatch(/problema técnico/i);
    }, 15000);

    test('[6c.2] MP falla siempre → pause + alert con e.message + mensaje honesto al cliente', async () => {
        const state = makeMpState({ email: undefined });
        mockPreferenceCreate.mockRejectedValue(new Error('invalid payer email'));
        await handleWaitingMpPayment('retry2', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(2);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/problema técnico/i);
        expect(mockNotify).toHaveBeenCalled();
        const adminArgs = mockNotify.mock.calls.map(args => args.join(' ')).join(' ');
        expect(adminArgs).toMatch(/FALLO AL GENERAR ENLACE DE MP/i);
        expect(adminArgs).toMatch(/invalid payer email/i);
        expect(deps.sharedState.pausedUsers.has('retry2')).toBe(true);
    }, 15000);
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 6d: Cliente en flujo MP cambia a Contra reembolso (retiro en sucursal)
// Modelo nuevo (may-2026): "3" / "contra reembolso" en stepWaitingMpPayment
// limpia el link MP y manda al cliente a retiro en sucursal directamente,
// pausando para coordinación admin. Sin anticipo, sin submenú.
// ════════════════════════════════════════════════════════════════════════════
describe('stepWaitingMpPayment — cliente cambia a Retiro en sucursal', () => {

    test('[6d.1] "3" en MP → retiro en sucursal + pause+alert (sin nuevo link MP)', async () => {
        const state = makeMpState({
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/x',
            partialAddress: { calle: 'Belgrano 123', ciudad: 'Rosario', cp: '2000' },
        });
        mockPreferenceCreate.mockClear();
        await handleWaitingMpPayment('cod_switch', '3', '3', state, knowledge, deps);

        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.shippingChoice).toBe('retiro');
        expect(state.senaAmount).toBe(0);
        expect(state.senaPaid).toBe(false);
        expect(state.mpPaymentLinkUrl).toBeNull();
        expect(state.mpPaymentLinkId).toBeNull();

        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/sucursal/i);
        expect(sent).toMatch(/efectivo/i);
        // NO debe mencionar anticipo o seña.
        expect(sent).not.toMatch(/anticipo/i);
        expect(sent).not.toMatch(/10\.000/);

        // NO regeneró link MP automáticamente.
        expect(mockPreferenceCreate).not.toHaveBeenCalled();

        // Cliente pausado para coordinación admin.
        expect(deps.sharedState.pausedUsers.has('cod_switch')).toBe(true);
        const adminArgs = mockNotify.mock.calls.map(args => args.join(' ')).join(' ');
        expect(adminArgs).toMatch(/RETIRO EN SUCURSAL/i);
        expect(adminArgs).toMatch(/Belgrano 123/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 7: stepWaitingMpPayment — confirmación de pago MP
// ════════════════════════════════════════════════════════════════════════════
describe('Confirmación de pago — MP completo', () => {

    test('[7.1] "listo" + MP approved + sin dirección → pide datos, NO marca senaPaid', async () => {
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'approved' });
        const state = makeMpState({
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/x',
        });
        await handleWaitingMpPayment('done1', 'listo', 'listo', state, knowledge, deps);
        expect(state.senaPaid).toBeFalsy();
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/pago fue confirmado/i);
        expect(sent).not.toMatch(/seña fue confirmada/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 7b (LEGACY): confirmación de pago en estado seña pre-may-2026
// Conversaciones abiertas desde antes del cambio aún pueden completar el flow
// viejo (seña pagada, saldo al cartero). El código sigue procesándolo OK.
// ════════════════════════════════════════════════════════════════════════════
describe('Compat legacy — confirmación de pago en flujo seña pre-may-2026', () => {

    test('[7b.1] "listo" + seña approved + sin dirección → marca senaPaid=true', async () => {
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'approved' });
        const state = makeLegacySenaState({
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/x',
        });
        await handleWaitingMpPayment('legacy_done1', 'listo', 'listo', state, knowledge, deps);
        expect(state.senaPaid).toBe(true);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/seña fue confirmada/i);
    });

    test('[7b.2] "listo" + seña approved + dirección → admin notificado con breakdown', async () => {
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'approved' });
        const state = makeLegacySenaState({
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/x',
            partialAddress: { nombre: 'Juan Pérez', calle: 'Belgrano 123', ciudad: 'Rosario', cp: '2000' },
        });
        await handleWaitingMpPayment('legacy_done2', 'listo', 'listo', state, knowledge, deps);
        expect(state.senaPaid).toBe(true);
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(mockNotify).toHaveBeenCalledTimes(1);
        const adminMsg = mockNotify.mock.calls[0][2];
        expect(adminMsg).toMatch(/SEÑA/i);
        expect(adminMsg).toMatch(/10\.000/);
        expect(adminMsg).toMatch(/cartero/i);
        expect(adminMsg).toMatch(/36\.900/);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 8: fix del fallback directo a MP en _verifyPayment (caso Rosa
// 5492994553847, 20-jul): el SDK serializa options DIRECTO como query params —
// el shape viejo { filters: { external_reference } } mandaba
// filters=[object Object], MP fallaba y el "listo" del cliente caía SIEMPRE a
// "no veo el pago" si el webhook aún no había marcado la fila.
// ════════════════════════════════════════════════════════════════════════════
describe('_verifyPayment — fallback directo a MP (fix caso Rosa 5492994553847)', () => {

    test('[8.1] "listo" con fila pending pero MP ya approved → confirma (search con shape correcto)', async () => {
        // La fila en DB sigue 'pending' (webhook no llegó todavía)…
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'pending', externalRef: 'ref-rosa' });
        // …pero MP ya tiene el pago approved.
        mockPaymentSearch.mockResolvedValueOnce({
            results: [{ status: 'approved', date_approved: '2026-07-20T18:36:04.000Z' }],
        });
        const state = makeMpState({
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/x',
            partialAddress: { nombre: 'Rosa Laura', calle: 'Los Jilgueros mza 6', ciudad: 'Neuquén', cp: '8300' },
        });
        await handleWaitingMpPayment('rosa1', 'Listo', 'listo', state, knowledge, deps);

        // El search debe ir con external_reference PLANO (query param directo),
        // nunca anidado en `filters` (eso mandaba filters=[object Object]).
        expect(mockPaymentSearch).toHaveBeenCalledWith({ options: { external_reference: 'ref-rosa' } });

        // Y la venta se cierra: fila marcada approved + venta confirmada al cliente.
        expect(mockPaymentLinkUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'pl-1' },
            data: expect.objectContaining({ status: 'approved' }),
        }));
        expect(state.step).toBe('completed');
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/pago fue confirmado|pedido quedó cerrado/i);
        expect(sent).not.toMatch(/no veo el pago/i);
    });

    test('[8.2] "listo" con MP aún sin resultados → sigue diciendo que espera (no rompe el caso pending real)', async () => {
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'pending', externalRef: 'ref-x' });
        mockPaymentSearch.mockResolvedValueOnce({ results: [] });
        const state = makeMpState({ mpPaymentLinkId: 'pl-1', mpPaymentLinkUrl: 'https://mp.com/x' });
        await handleWaitingMpPayment('pend1', 'listo', 'listo', state, knowledge, deps);
        expect(state.step).toBe('waiting_mp_payment');
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/no veo el pago/i);
    });

    test('[8.5] "listo" con pago rejected → CONSERVA el mismo link y lo re-manda (no regenera)', async () => {
        // Fix 24-jul: al rechazarse un pago, la preferencia MP sigue vigente y el
        // reintento va por el mismo checkout. Antes se nulleaba el link y se
        // regeneraba otro → el cliente pagaba en la pestaña vieja y el push
        // descartaba el pago por mismatch ("link no vigente").
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'pending', externalRef: 'ref-r' });
        mockPaymentSearch.mockResolvedValueOnce({ results: [{ status: 'rejected' }] });
        mockPreferenceCreate.mockClear();
        const state = makeMpState({ mpPaymentLinkId: 'pl-1', mpPaymentLinkUrl: 'https://mp.com/x' });
        await handleWaitingMpPayment('rej1', 'listo', 'listo', state, knowledge, deps);

        expect(state.step).toBe('waiting_mp_payment');
        expect(state.mpPaymentLinkId).toBe('pl-1');
        expect(state.mpPaymentLinkUrl).toBe('https://mp.com/x');
        expect(mockPreferenceCreate).not.toHaveBeenCalled();
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/https:\/\/mp\.com\/x/);
    });

    test('[8.3] Dirección PARCIAL + pago approved → confirma el pago y pide lo que falta (nunca "avisame cuando completes el pago")', async () => {
        // El cliente pagó y mandó nombre+calle sin ciudad. Antes el guard
        // `&& hasAddress` descartaba el approved: el bot le decía "avisame
        // cuando completes el pago" a alguien que YA pagó, y como _verifyPayment
        // ya había flipeado la fila a approved, ningún detector push volvía a
        // disparar (venta muda).
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'approved' });
        aiService.parseAddress.mockResolvedValueOnce({ nombre: 'Rosa Laura', calle: 'Los Jilgueros mza 6' });
        const state = makeMpState({ mpPaymentLinkId: 'pl-1', mpPaymentLinkUrl: 'https://mp.com/x' });
        await handleWaitingMpPayment('partial1', 'Rosa Laura, Los Jilgueros mza 6', 'rosa laura, los jilgueros mza 6', state, knowledge, deps);

        expect(state.step).toBe('waiting_data');
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/pago fue confirmado/i);
        expect(sent).not.toMatch(/avisame cuando completes el pago/i);
    });

    test('[8.4] Race: el push confirma DURANTE el parseAddress → la dirección completa cierra la venta igual (no se descarta)', async () => {
        // El worker está esperando parseAddress cuando el webhook confirma sin
        // dirección y mueve el step a waiting_data. Antes, al retomar, el guard
        // de step descartaba el mensaje con la dirección completa en silencio y
        // la orden nunca se creaba.
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'approved' });
        const state = makeMpState({ mpPaymentLinkId: 'pl-1', mpPaymentLinkUrl: 'https://mp.com/x' });
        aiService.parseAddress.mockImplementationOnce(async () => {
            // Simula el push ganando la carrera: confirmó sin dirección y movió el step.
            state.step = 'waiting_data';
            return { nombre: 'Rosa Laura', calle: 'Los Jilgueros mza 6', ciudad: 'Neuquén', cp: '8300' };
        });
        await handleWaitingMpPayment('race1', 'Rosa Laura, Los Jilgueros mza 6, Neuquén 8300', 'rosa laura, los jilgueros mza 6, neuquen 8300', state, knowledge, deps);

        // La venta se finaliza con la dirección que llegó durante la carrera.
        expect(state.step).toBe('completed');
        const adminArgs = mockNotify.mock.calls.map(args => args.join(' ')).join(' ');
        expect(adminArgs).toMatch(/VENTA CERRADA/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 9: confirmación PUSH (mpPushConfirm.onPaymentLinkApproved)
// El sistema detecta el approved (webhook / cron / refresh del dashboard) y
// confirma la compra SIN esperar el "listo" del cliente. Antes no existía:
// si el cliente pagaba y no escribía "listo", la venta quedaba muda (Rosa
// estuvo 3 días preguntando "¿es real la compra?").
// ════════════════════════════════════════════════════════════════════════════
describe('mpPushConfirm — confirmación push al acreditarse el pago', () => {
    const { onPaymentLinkApproved } = require('../src/services/mpPushConfirm');
    const mockSaveOrder = jest.fn();

    function makePushDeps(state, { paused = false, phone = '5492994553847' } = {}) {
        const userId = `${phone}@c.us`;
        const pausedUsers = new Set(paused ? [userId] : []);
        return {
            userId,
            deps: {
                sharedState: {
                    sellerId: 'vendedor_test',
                    userState: { [userId]: state },
                    pausedUsers,
                    knowledge,
                    config: { alertNumbers: [] },
                },
                sendMessageWithDelay: mockSend,
                notifyAdmin: mockNotify,
                saveState: mockSave,
                saveOrderToLocal: mockSaveOrder,
            },
        };
    }

    const record = (over = {}) => ({
        id: 'pl-1', userPhone: '5492994553847', amount: 44900, status: 'approved', ...over,
    });

    beforeEach(() => { mockSaveOrder.mockClear(); });

    test('[9.1] Pago acreditado + dirección completa → cierra la venta solo (caso Rosa)', async () => {
        const state = makeMpState({
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/x',
            partialAddress: { nombre: 'Rosa Laura', calle: 'Los Jilgueros mza 6', ciudad: 'Neuquén', cp: '8300' },
        });
        const { deps: pushDeps } = makePushDeps(state);
        await onPaymentLinkApproved(record(), pushDeps);

        expect(state.step).toBe('completed');
        expect(mockSaveOrder).toHaveBeenCalledTimes(1);
        expect(mockSaveOrder.mock.calls[0][0]).toMatchObject({
            paymentMethod: 'mercadopago',
            status: 'Confirmado',
        });
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/pago fue confirmado|pedido quedó cerrado/i);
        const adminArgs = mockNotify.mock.calls.map(args => args.join(' ')).join(' ');
        expect(adminArgs).toMatch(/VENTA CERRADA/i);
    });

    test('[9.2] Pago acreditado SIN dirección → confirma el pago y pide los datos', async () => {
        const state = makeMpState({ mpPaymentLinkId: 'pl-1', mpPaymentLinkUrl: 'https://mp.com/x' });
        const { deps: pushDeps } = makePushDeps(state);
        await onPaymentLinkApproved(record(), pushDeps);

        expect(state.step).toBe('waiting_data');
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/pago fue confirmado/i);
    });

    test('[9.3] Cliente PAUSADO → NO le mensajea, avisa al admin (pausas no se auto-liberan) y apaga nudges', async () => {
        const state = makeMpState({
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/x',
            pauseReason: 'revisión manual',
        });
        const { deps: pushDeps } = makePushDeps(state, { paused: true });
        await onPaymentLinkApproved(record(), pushDeps);

        expect(mockSend).not.toHaveBeenCalled();
        expect(state.step).toBe('waiting_mp_payment');
        const adminArgs = mockNotify.mock.calls.map(args => args.join(' ')).join(' ');
        expect(adminArgs).toMatch(/PAUSADO/i);
        expect(adminArgs).toMatch(/revisión manual/);
        // El pago ya está acreditado → los nudges de "pago pendiente" serían
        // falsos. Sentinel 99 los apaga.
        expect(state.mpReminderStage).toBe(99);
        // Aviso único: el sweep reintenta cada 5 min — no debe spamear al admin.
        mockNotify.mockClear();
        await onPaymentLinkApproved(record(), pushDeps);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('[9.4] Link viejo (id distinto al del state) → NO confirma pero avisa al admin (plata acreditada sin trackear)', async () => {
        const state = makeMpState({ mpPaymentLinkId: 'pl-NUEVO', mpPaymentLinkUrl: 'https://mp.com/x' });
        const { deps: pushDeps } = makePushDeps(state);
        await onPaymentLinkApproved(record({ id: 'pl-VIEJO' }), pushDeps);

        expect(mockSend).not.toHaveBeenCalled();
        expect(state.step).toBe('waiting_mp_payment');
        const adminArgs = mockNotify.mock.calls.map(args => args.join(' ')).join(' ');
        expect(adminArgs).toMatch(/link no vigente/i);
        expect(adminArgs).toMatch(/pl-VIEJO/);
        // Segunda llamada con el mismo record → sin re-aviso.
        mockNotify.mockClear();
        await onPaymentLinkApproved(record({ id: 'pl-VIEJO' }), pushDeps);
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('[9.4b] Pausa GLOBAL → NO mensajea NI muta el step (el sweep confirma al levantarla), avisa al admin', async () => {
        const state = makeMpState({ mpPaymentLinkId: 'pl-1', mpPaymentLinkUrl: 'https://mp.com/x' });
        const { deps: pushDeps } = makePushDeps(state);
        pushDeps.sharedState.config.globalPause = true;
        await onPaymentLinkApproved(record(), pushDeps);

        expect(mockSend).not.toHaveBeenCalled();
        expect(mockSaveOrder).not.toHaveBeenCalled();
        expect(state.step).toBe('waiting_mp_payment');
        const adminArgs = mockNotify.mock.calls.map(args => args.join(' ')).join(' ');
        expect(adminArgs).toMatch(/PAUSA GLOBAL/i);

        // Al levantar la pausa, el mismo push (reintentado por el sweep) confirma.
        pushDeps.sharedState.config.globalPause = false;
        state.partialAddress = { nombre: 'Rosa Laura', calle: 'Los Jilgueros mza 6', ciudad: 'Neuquén', cp: '8300' };
        await onPaymentLinkApproved(record(), pushDeps);
        expect(state.step).toBe('completed');
        expect(mockSaveOrder).toHaveBeenCalledTimes(1);
    });

    test('[9.4c] WhatsApp DESCONECTADO → NO muta el step (el sweep confirma al reconectar), avisa al admin', async () => {
        const state = makeMpState({ mpPaymentLinkId: 'pl-1', mpPaymentLinkUrl: 'https://mp.com/x' });
        const { deps: pushDeps } = makePushDeps(state);
        pushDeps.sharedState.isConnected = false;
        await onPaymentLinkApproved(record(), pushDeps);

        expect(mockSend).not.toHaveBeenCalled();
        expect(state.step).toBe('waiting_mp_payment');
        const adminArgs = mockNotify.mock.calls.map(args => args.join(' ')).join(' ');
        expect(adminArgs).toMatch(/DESCONECTADO/i);

        pushDeps.sharedState.isConnected = true;
        await onPaymentLinkApproved(record(), pushDeps);
        expect(state.step).toBe('waiting_data'); // sin dirección → confirma y pide datos
    });

    test('[9.5] Cliente ya avanzó de step (cambió a transferencia) → no hace nada', async () => {
        const state = makeMpState({ step: 'waiting_transfer_confirmation', mpPaymentLinkId: 'pl-1' });
        const { deps: pushDeps } = makePushDeps(state);
        await onPaymentLinkApproved(record(), pushDeps);

        expect(mockSend).not.toHaveBeenCalled();
        expect(mockNotify).not.toHaveBeenCalled();
    });

    test('[9.6] Link manual del dashboard (sin userPhone) → no hace nada', async () => {
        const state = makeMpState({ mpPaymentLinkId: 'pl-1' });
        const { deps: pushDeps } = makePushDeps(state);
        await onPaymentLinkApproved(record({ userPhone: null }), pushDeps);
        expect(mockSend).not.toHaveBeenCalled();
    });

    test('[9.7] Doble disparo (webhook + cron a la vez) → una sola confirmación', async () => {
        const state = makeMpState({
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/x',
            partialAddress: { nombre: 'Rosa Laura', calle: 'Los Jilgueros mza 6', ciudad: 'Neuquén', cp: '8300' },
        });
        const { deps: pushDeps } = makePushDeps(state);
        await Promise.all([
            onPaymentLinkApproved(record(), pushDeps),
            onPaymentLinkApproved(record(), pushDeps),
        ]);

        // Una sola orden y una sola notificación de venta cerrada.
        expect(mockSaveOrder).toHaveBeenCalledTimes(1);
        const closedCalls = mockNotify.mock.calls.filter(([title]) => /VENTA CERRADA/i.test(title));
        expect(closedCalls.length).toBe(1);
    });
});
