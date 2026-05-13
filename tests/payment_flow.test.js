/**
 * Payment method flow tests — política nueva (mayo 2026).
 *
 * Cobertura:
 *  - stepWaitingOk → transición a waiting_payment_method
 *  - stepWaitingPaymentMethod → MP-first, seña $10k para COD, transferencia opcional
 *  - stepWaitingMpPayment — link normal vs link de seña ($10k), confirmación seña
 *  - _finalizeOrderAndNotifyAdmin distingue MP completo vs seña + alerta breakdown
 *
 * Política nueva:
 *  - Solo MP se ofrece espontáneamente
 *  - Contra reembolso requiere seña $10k vía MP + saldo al cartero
 *  - Sin adicional de $6.000, sin descuento de prepago
 *  - Aplica a TODOS los planes y a TODOS los clientes
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

const { handleWaitingOk } = require('../src/flows/steps/stepWaitingOk');
const { handleWaitingPaymentMethod } = require('../src/flows/steps/stepWaitingPaymentMethod');
const { handleWaitingMpPayment } = require('../src/flows/steps/stepWaitingMpPayment');
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
// Política mayo 2026: el total NO incluye adicional $6k (eliminado).
// totalPrice = base del producto.
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
        partialAddress: {},
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
        // Por defecto los tests "saltean" el subflow de email para probar la
        // generación del link directamente. Tests específicos del subflow setean
        // email=undefined + emailAskedAt=undefined explícitamente.
        email: '',
        emailAskedAt: Date.now(),
        ...overrides,
    };
}

function makeSenaState(overrides = {}) {
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
// BLOQUE 1: stepWaitingOk — transición a waiting_payment_method
// ════════════════════════════════════════════════════════════════════════════
describe('stepWaitingOk → pasa a waiting_payment_method', () => {

    test('[1.1] "si" → pasa a waiting_payment_method', async () => {
        const state = makeOkState();
        await handleWaitingOk('u1', 'si', 'si', state, knowledge, deps);
        expect(state.step).toBe('waiting_payment_method');
    });

    test('[1.2] "dale" → pasa a waiting_payment_method', async () => {
        const state = makeOkState();
        await handleWaitingOk('u2', 'dale', 'dale', state, knowledge, deps);
        expect(state.step).toBe('waiting_payment_method');
    });

    test('[1.3] mensaje del menú pushea Mercado Pago (sin "Contra reembolso" en menú)', async () => {
        const state = makeOkState();
        await handleWaitingOk('u3', 'si', 'si', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/Mercado Pago/i);
        // Política nueva: el menú NO ofrece COD ni Transferencia espontáneamente.
        expect(sent).not.toMatch(/Contra reembolso/i);
        expect(sent).not.toMatch(/Transferencia bancaria/i);
    });

    test('[1.4] mensaje del menú menciona cuotas + débito + saldo MP (sin Pago Fácil/Rapipago)', async () => {
        const state = makeOkState();
        await handleWaitingOk('u4', 'si', 'si', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/cuotas/i);
        expect(sent).toMatch(/débito/i);
        expect(sent).toMatch(/Saldo Mercado Pago/i);
        expect(sent).not.toMatch(/Pago Fácil/i);
        expect(sent).not.toMatch(/Rapipago/i);
    });

    test('[1.5] mensaje del menú NO menciona adicional de $6.000', async () => {
        const state = makeOkState({ selectedPlan: '60' });
        await handleWaitingOk('u5', 'si', 'si', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).not.toMatch(/\$\s*6\.000/);
        expect(sent).not.toMatch(/adicional/i);
    });

    test('[1.6] Negativa → NO va a waiting_payment_method', async () => {
        const state = makeOkState();
        await handleWaitingOk('u6', 'no no puedo', 'no no puedo', state, knowledge, deps);
        expect(state.step).not.toBe('waiting_payment_method');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 2: stepWaitingPaymentMethod — MercadoPago
// ════════════════════════════════════════════════════════════════════════════
describe('Método de pago → MercadoPago', () => {

    test('[2.1] "mercadopago" → paymentMethod=mercadopago, step=waiting_mp_payment', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('mp1', 'mercadopago', 'mercadopago', state, knowledge, deps);
        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.step).toBe('waiting_mp_payment');
    });

    test('[2.2] "mp" → waiting_mp_payment', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('mp2', 'mp', 'mp', state, knowledge, deps);
        expect(state.step).toBe('waiting_mp_payment');
    });

    test('[2.3] "1" → waiting_mp_payment (MP es opción 1 del menú)', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('mp3', '1', '1', state, knowledge, deps);
        expect(state.step).toBe('waiting_mp_payment');
    });

    test('[2.4] MP NO setea senaAmount (es pago completo)', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('mp4', 'mercadopago', 'mercadopago', state, knowledge, deps);
        expect(state.senaAmount).toBeFalsy();
    });

    test('[2.5] Plan 60: totalPrice queda como base (sin adicional, política mayo 2026)', async () => {
        const state = makePaymentState('60'); // totalPrice 46.900 (base)
        await handleWaitingPaymentMethod('mp5', 'mercadopago', 'mercadopago', state, knowledge, deps);
        expect(state.totalPrice).toBe('46.900');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 3: stepWaitingPaymentMethod — Transferencia (solo si la pide)
// ════════════════════════════════════════════════════════════════════════════
describe('Método de pago → Transferencia (solo si la pide)', () => {

    test('[3.1] "transferencia" → paymentMethod=transferencia, step=waiting_transfer_confirmation', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('tr1', 'transferencia', 'transferencia', state, knowledge, deps);
        expect(state.paymentMethod).toBe('transferencia');
        expect(state.step).toBe('waiting_transfer_confirmation');
    });

    test('[3.2] "alias" → waiting_transfer_confirmation', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('tr2', 'alias', 'alias', state, knowledge, deps);
        expect(state.step).toBe('waiting_transfer_confirmation');
    });

    test('[3.3] "2" (opción 2 del menú) → transferencia', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('tr3', '2', '2', state, knowledge, deps);
        expect(state.paymentMethod).toBe('transferencia');
    });

    test('[3.4] mensaje de transferencia envía el alias CHILE.TEXTO.CASINO', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('tr4', 'transferencia', 'transferencia', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/CHILE\.TEXTO\.CASINO/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 4: stepWaitingPaymentMethod — Contra reembolso (flujo seña $10k)
// ════════════════════════════════════════════════════════════════════════════
describe('Método de pago → Contra reembolso (flujo seña $10k)', () => {

    test('[4.1] Primera vez "contra reembolso" → explica seña, NO avanza todavía', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('cr1', 'contra reembolso', 'contra reembolso', state, knowledge, deps);
        // Primer paso: mostrar mensaje explicando seña.
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/seña/i);
        expect(sent).toMatch(/10\.000/);
        expect(state.cashRetryShown).toBe(true);
        // Todavía no se setea paymentMethod ni se transita.
        expect(state.step).toBe('waiting_payment_method');
        expect(state.senaAmount).toBeFalsy();
    });

    test('[4.2] Segunda vez (post-retry) "si" → setea senaAmount=10000 y transita a WAITING_MP_PAYMENT', async () => {
        const state = makePaymentState('60', { cashRetryShown: true });
        const r = await handleWaitingPaymentMethod('cr2', 'si', 'si', state, knowledge, deps);
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.senaAmount).toBe(10000);
        expect(state.senaPaid).toBe(false);
        expect(state.step).toBe('waiting_mp_payment');
        // staleReprocess hace que salesFlow reentre — el handler devuelve {matched:false, staleReprocess:true}.
        expect(r.matched).toBe(false);
        expect(r.staleReprocess).toBe(true);
    });

    test('[4.3] "efectivo" + cashRetryShown=true → flujo seña', async () => {
        const state = makePaymentState('60', { cashRetryShown: true });
        await handleWaitingPaymentMethod('cr3', 'efectivo', 'efectivo', state, knowledge, deps);
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.senaAmount).toBe(10000);
        expect(state.step).toBe('waiting_mp_payment');
    });

    test('[4.4] COD aplica seña a plan 120 también (política mayo 2026: aplica a TODOS los planes)', async () => {
        const state = makePaymentState('120', { cashRetryShown: true });
        await handleWaitingPaymentMethod('cr4', 'contra reembolso', 'contra reembolso', state, knowledge, deps);
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.senaAmount).toBe(10000);
    });

    test('[4.5] mensaje de retry menciona efectivo al cartero', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('cr5', 'contra reembolso', 'contra reembolso', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/efectivo al cartero/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 5: stepWaitingMpPayment — link normal (MP por el total)
// ════════════════════════════════════════════════════════════════════════════
describe('stepWaitingMpPayment — link MP por el total', () => {

    test('[5.1] Entry sin link → genera preferencia MP por totalPrice', async () => {
        const state = makeMpState(); // sin mpPaymentLinkUrl, totalPrice=46.900
        await handleWaitingMpPayment('mppy1', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(1);
        // unit_price debe ser el total, no la seña.
        const call = mockPreferenceCreate.mock.calls[0][0];
        expect(call.body.items[0].unit_price).toBe(46900);
        expect(call.body.items[0].title).toBe('Pago Herbalis');
        expect(state.mpPaymentLinkUrl).toBe('https://mp.com/checkout/pref_test');
    });

    test('[5.2] mensaje al cliente del link normal dice "Total" (no "Seña")', async () => {
        const state = makeMpState();
        await handleWaitingMpPayment('mppy2', 'hola', 'hola', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/Pago online via MercadoPago/i);
        expect(sent).toMatch(/Total/);
        expect(sent).not.toMatch(/Seña por Mercado Pago/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 6: stepWaitingMpPayment — link de SEÑA ($10k para COD)
// ════════════════════════════════════════════════════════════════════════════
describe('stepWaitingMpPayment — link de SEÑA $10.000', () => {

    test('[6.1] Entry con senaAmount=10000 → genera preferencia MP por $10.000', async () => {
        const state = makeSenaState();
        await handleWaitingMpPayment('sena1', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(1);
        const call = mockPreferenceCreate.mock.calls[0][0];
        expect(call.body.items[0].unit_price).toBe(10000);
        expect(call.body.items[0].title).toMatch(/Seña/i);
    });

    test('[6.2] mensaje al cliente explica seña + saldo al cartero', async () => {
        const state = makeSenaState();
        await handleWaitingMpPayment('sena2', 'hola', 'hola', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/Seña por Mercado Pago/i);
        expect(sent).toMatch(/10\.000/);
        expect(sent).toMatch(/Saldo al cartero/i);
        // 46.900 - 10.000 = 36.900
        expect(sent).toMatch(/36\.900/);
    });

    test('[6.3] PaymentLink en DB se persiste con source="bot_flow_sena"', async () => {
        const state = makeSenaState();
        await handleWaitingMpPayment('sena3', 'hola', 'hola', state, knowledge, deps);
        expect(mockPaymentLinkCreate).toHaveBeenCalledTimes(1);
        const arg = mockPaymentLinkCreate.mock.calls[0][0].data;
        expect(arg.source).toBe('bot_flow_sena');
        expect(arg.amount).toBe(10000);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 6b: Subflow de email antes de generar el link MP
// ════════════════════════════════════════════════════════════════════════════
describe('stepWaitingMpPayment — subflow email', () => {

    test('[6b.1] Entry sin email → pregunta y NO genera link todavía', async () => {
        const state = makeMpState({ email: undefined, emailAskedAt: undefined });
        await handleWaitingMpPayment('em1', 'hola', 'hola', state, knowledge, deps);
        // No se llamó a MP — todavía estamos en el ask del email
        expect(mockPreferenceCreate).not.toHaveBeenCalled();
        expect(state.emailAskedAt).toBeTruthy();
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/email/i);
        expect(sent).toMatch(/sin email/i);
    });

    test('[6b.2] Cliente responde con email válido → se guarda y genera link con payer.email', async () => {
        const state = makeMpState({ email: undefined, emailAskedAt: Date.now() });
        await handleWaitingMpPayment('em2', 'mi mail es Juan.Perez@gmail.com', 'mi mail es juan.perez@gmail.com', state, knowledge, deps);
        expect(state.email).toBe('juan.perez@gmail.com');
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(1);
        const call = mockPreferenceCreate.mock.calls[0][0];
        expect(call.body.payer).toEqual({ email: 'juan.perez@gmail.com' });
    });

    test('[6b.3] Cliente dice "sin email" → genera link sin payer.email', async () => {
        const state = makeMpState({ email: undefined, emailAskedAt: Date.now() });
        await handleWaitingMpPayment('em3', 'sin email', 'sin email', state, knowledge, deps);
        expect(state.email).toBe('');  // marcado como skipped
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(1);
        const call = mockPreferenceCreate.mock.calls[0][0];
        expect(call.body.payer).toBeUndefined();
    });

    test('[6b.4] Cliente responde con texto random → omite email y genera link', async () => {
        const state = makeMpState({ email: undefined, emailAskedAt: Date.now() });
        await handleWaitingMpPayment('em4', 'ok dale', 'ok dale', state, knowledge, deps);
        expect(state.email).toBe('');
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(1);
    });

    test('[6b.5] Flujo seña también pregunta email', async () => {
        const state = makeSenaState({ email: undefined, emailAskedAt: undefined });
        await handleWaitingMpPayment('em5', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).not.toHaveBeenCalled();
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/seña/i);
        expect(sent).toMatch(/email/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 7: stepWaitingMpPayment — confirmación de pago (MP completo vs seña)
// ════════════════════════════════════════════════════════════════════════════
describe('Confirmación de pago — MP completo', () => {

    test('[7.1] "listo" + MP approved + sin dirección → pide datos sin marcar senaPaid', async () => {
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

describe('Confirmación de pago — flujo SEÑA', () => {

    test('[7.2] "listo" + seña approved + sin dirección → marca senaPaid=true + mensaje específico', async () => {
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'approved' });
        const state = makeSenaState({
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/x',
        });
        await handleWaitingMpPayment('done2', 'listo', 'listo', state, knowledge, deps);
        expect(state.senaPaid).toBe(true);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/seña fue confirmada/i);
    });

    test('[7.3] "listo" + seña approved + dirección presente → admin notificado con breakdown', async () => {
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'approved' });
        const state = makeSenaState({
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/x',
            partialAddress: { nombre: 'Juan Pérez', calle: 'Belgrano 123', ciudad: 'Rosario', cp: '2000' },
        });
        await handleWaitingMpPayment('done3', 'listo', 'listo', state, knowledge, deps);
        expect(state.senaPaid).toBe(true);
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(mockNotify).toHaveBeenCalledTimes(1);
        const adminMsg = mockNotify.mock.calls[0][2]; // detalles del notify
        expect(adminMsg).toMatch(/SEÑA/i);
        expect(adminMsg).toMatch(/10\.000/);
        expect(adminMsg).toMatch(/cartero/i);
        // Saldo cartero = 46.900 - 10.000 = 36.900
        expect(adminMsg).toMatch(/36\.900/);
    });
});
