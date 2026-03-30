/**
 * MercadoPago Payment Flow Tests
 * Tests the new waiting_payment_method and waiting_mp_payment steps.
 */

const mockSendMessage = jest.fn();
const mockSaveState = jest.fn();
const mockNotifyAdmin = jest.fn();

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));

// MP preference mock
const mockPreferenceCreate = jest.fn().mockResolvedValue({
    id: 'pref_123',
    init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref_123'
});
const mockPaymentSearch = jest.fn().mockResolvedValue({ results: [] });

jest.mock('mercadopago', () => ({
    MercadoPagoConfig: jest.fn().mockImplementation(() => ({})),
    Preference: jest.fn().mockImplementation(() => ({ create: mockPreferenceCreate })),
    Payment: jest.fn().mockImplementation(() => ({ search: mockPaymentSearch }))
}), { virtual: true });

// DB mock
const mockPaymentLinkCreate = jest.fn().mockResolvedValue({ id: 'pl_abc', status: 'pending', externalRef: 'uuid-xxx' });
const mockPaymentLinkFindUnique = jest.fn().mockResolvedValue(null);
const mockPaymentLinkUpdate = jest.fn().mockResolvedValue({ id: 'pl_abc', status: 'approved' });

jest.mock('../db', () => ({
    prisma: {
        order: { create: jest.fn().mockResolvedValue({ id: 'mock-order' }), findFirst: jest.fn().mockResolvedValue(null) },
        user: { upsert: jest.fn().mockResolvedValue({}) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        paymentLink: {
            create: mockPaymentLinkCreate,
            findUnique: mockPaymentLinkFindUnique,
            update: mockPaymentLinkUpdate
        }
    }
}));

jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: 'AI fallback response', goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue({})
    }
}));

const { handleWaitingPaymentMethod } = require('../src/flows/steps/stepWaitingPaymentMethod');
const { handleWaitingMpPayment } = require('../src/flows/steps/stepWaitingMpPayment');
const { handleWaitingOk } = require('../src/flows/steps/stepWaitingOk');

const knowledge = {
    flow: {
        closing: { response: 'Pasame los datos de envío 👇\n\nNombre:\nCalle:', nextStep: 'waiting_data' }
    },
    faq: []
};

const deps = {
    saveState: mockSaveState,
    sendMessageWithDelay: mockSendMessage,
    notifyAdmin: mockNotifyAdmin,
    aiService: require('../src/services/ai').aiService,
    sharedState: { pausedUsers: new Set(), io: null }
};

function makeState(overrides = {}) {
    return {
        step: 'waiting_ok',
        history: [],
        cart: [{ product: 'Cápsulas de Nuez', plan: '60', price: '46.900' }],
        selectedProduct: 'Cápsulas de Nuez de la India',
        selectedPlan: '60',
        totalPrice: '52.900',
        isContraReembolsoMAX: true,
        adicionalMAX: 6000,
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        ...overrides
    };
}

// ─── waiting_ok → waiting_payment_method ────────────────────────────────────

describe('stepWaitingOk — with MP enabled', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.MP_ACCESS_TOKEN = 'TEST_TOKEN';
    });

    afterAll(() => { delete process.env.MP_ACCESS_TOKEN; });

    test('affirmative response redirects to waiting_payment_method', async () => {
        const state = makeState({ step: 'waiting_ok' });
        await handleWaitingOk('user1@c.us', 'sí', 'si', state, knowledge, deps);

        expect(state.step).toBe('waiting_payment_method');
        const msg = mockSendMessage.mock.calls[0][1];
        expect(msg).toMatch(/MercadoPago/i);
        expect(msg).toMatch(/Efectivo/i);
    });

    test('negative response pauses user (unchanged)', async () => {
        const state = makeState({ step: 'waiting_ok' });
        await handleWaitingOk('user1@c.us', 'no', 'no', state, knowledge, deps);
        expect(mockNotifyAdmin).toHaveBeenCalled();
    });
});

describe('stepWaitingOk — with MP disabled', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.MP_ACCESS_TOKEN;
    });

    test('affirmative response goes straight to waiting_data when MP not configured', async () => {
        const state = makeState({ step: 'waiting_ok' });
        await handleWaitingOk('user1@c.us', 'sí', 'si', state, knowledge, deps);

        expect(state.step).toBe('waiting_data');
        const msg = mockSendMessage.mock.calls[0][1];
        expect(msg).toMatch(/datos/i);
    });
});

// ─── waiting_payment_method ──────────────────────────────────────────────────

describe('stepWaitingPaymentMethod', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.MP_ACCESS_TOKEN = 'TEST_TOKEN';
    });

    afterAll(() => { delete process.env.MP_ACCESS_TOKEN; });

    test('choosing "1" (MercadoPago) sets paymentMethod and advances to waiting_mp_payment', async () => {
        const state = makeState({ step: 'waiting_payment_method' });
        const result = await handleWaitingPaymentMethod('user1@c.us', '1', '1', state, knowledge, deps);

        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.step).toBe('waiting_mp_payment');
        // staleReprocess triggers re-processing
        expect(result.staleReprocess).toBe(true);
    });

    test('choosing "mercadopago" keyword sets paymentMethod and advances to waiting_mp_payment', async () => {
        const state = makeState({ step: 'waiting_payment_method' });
        await handleWaitingPaymentMethod('user1@c.us', 'mercadopago', 'mercadopago', state, knowledge, deps);

        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.step).toBe('waiting_mp_payment');
    });

    test('choosing "2" (efectivo) sets paymentMethod and goes to waiting_data', async () => {
        const state = makeState({ step: 'waiting_payment_method' });
        await handleWaitingPaymentMethod('user1@c.us', '2', '2', state, knowledge, deps);

        expect(state.paymentMethod).toBe('efectivo');
        expect(state.step).toBe('waiting_data');
        expect(mockSendMessage).toHaveBeenCalled();
    });

    test('choosing "efectivo" keyword goes to waiting_data', async () => {
        const state = makeState({ step: 'waiting_payment_method' });
        await handleWaitingPaymentMethod('user1@c.us', 'prefiero efectivo', 'prefiero efectivo', state, knowledge, deps);

        expect(state.paymentMethod).toBe('efectivo');
        expect(state.step).toBe('waiting_data');
    });

    test('unclear message triggers AI fallback', async () => {
        const state = makeState({ step: 'waiting_payment_method' });
        await handleWaitingPaymentMethod('user1@c.us', 'no sé cuál elegir', 'no se cual elegir', state, knowledge, deps);

        const { aiService } = require('../src/services/ai');
        expect(aiService.chat).toHaveBeenCalledWith(
            'no sé cuál elegir',
            expect.objectContaining({ step: 'waiting_payment_method' })
        );
        expect(mockSendMessage).toHaveBeenCalledWith('user1@c.us', 'AI fallback response');
    });

    test('silently falls back to efectivo when MP_ACCESS_TOKEN missing', async () => {
        delete process.env.MP_ACCESS_TOKEN;
        const state = makeState({ step: 'waiting_payment_method' });
        const result = await handleWaitingPaymentMethod('user1@c.us', '1', '1', state, knowledge, deps);

        expect(state.paymentMethod).toBe('efectivo');
        expect(state.step).toBe('waiting_data');
        expect(result.staleReprocess).toBe(true);
    });
});

// ─── waiting_mp_payment ──────────────────────────────────────────────────────

describe('stepWaitingMpPayment — entry (no link yet)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.MP_ACCESS_TOKEN = 'TEST_TOKEN';
        mockPreferenceCreate.mockResolvedValue({
            id: 'pref_123',
            init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref_123'
        });
        mockPaymentLinkCreate.mockResolvedValue({ id: 'pl_abc', status: 'pending', externalRef: 'uuid-xxx' });
    });

    afterAll(() => { delete process.env.MP_ACCESS_TOKEN; });

    test('generates MP link and sends it to client on entry', async () => {
        const state = makeState({ step: 'waiting_mp_payment', paymentMethod: 'mercadopago' });
        await handleWaitingMpPayment('user1@c.us', 'dale', 'dale', state, knowledge, deps);

        expect(mockPreferenceCreate).toHaveBeenCalled();
        expect(mockPaymentLinkCreate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ source: 'bot_flow', status: 'pending' }) })
        );
        expect(state.mpPaymentLinkUrl).toContain('mercadopago');
        const msg = mockSendMessage.mock.calls[0][1];
        expect(msg).toMatch(/mercadopago/i);
        expect(msg).toMatch(/listo/i);
    });

    test('falls back to efectivo if MP preference creation fails', async () => {
        mockPreferenceCreate.mockRejectedValueOnce(new Error('MP API error'));
        const state = makeState({ step: 'waiting_mp_payment', paymentMethod: 'mercadopago' });
        await handleWaitingMpPayment('user1@c.us', 'dale', 'dale', state, knowledge, deps);

        expect(state.paymentMethod).toBe('efectivo');
        expect(state.step).toBe('waiting_data');
        const msg = mockSendMessage.mock.calls[0][1];
        expect(msg).toMatch(/efectivo/i);
    });
});

describe('stepWaitingMpPayment — client confirms payment', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.MP_ACCESS_TOKEN = 'TEST_TOKEN';
        // Set stable defaults for each test — avoids stale once-queues between tests
        mockPaymentLinkFindUnique.mockResolvedValue({ id: 'pl_abc', status: 'pending', externalRef: 'uuid-xxx' });
        mockPaymentSearch.mockResolvedValue({ results: [] });
    });

    afterEach(() => {
        mockPaymentLinkFindUnique.mockResolvedValue(null); // reset to safe default after each test
    });

    afterAll(() => { delete process.env.MP_ACCESS_TOKEN; });

    test('"listo" with approved payment advances to waiting_data', async () => {
        mockPaymentSearch.mockResolvedValueOnce({
            results: [{ status: 'approved', date_approved: new Date().toISOString() }]
        });

        const state = makeState({
            step: 'waiting_mp_payment',
            paymentMethod: 'mercadopago',
            mpPaymentLinkId: 'pl_abc',
            mpPaymentLinkUrl: 'https://mp.com/link'
        });
        await handleWaitingMpPayment('user1@c.us', 'listo', 'listo', state, knowledge, deps);

        expect(state.step).toBe('waiting_data');
        const msg = mockSendMessage.mock.calls[0][1];
        expect(msg).toMatch(/confirmado/i);
    });

    test('"ya pagué" with still-pending payment sends wait message', async () => {
        // mockPaymentSearch already returns { results: [] } by default (set in beforeEach)

        const state = makeState({
            step: 'waiting_mp_payment',
            paymentMethod: 'mercadopago',
            mpPaymentLinkId: 'pl_abc',
            mpPaymentLinkUrl: 'https://mp.com/link'
        });
        await handleWaitingMpPayment('user1@c.us', 'ya pagué', 'ya pague', state, knowledge, deps);

        expect(state.step).toBe('waiting_mp_payment'); // stays
        const msg = mockSendMessage.mock.calls[0][1];
        expect(msg).toMatch(/todavía|Todavía/i);
    });

    test('"listo" with rejected payment falls back to efectivo', async () => {
        mockPaymentSearch.mockResolvedValueOnce({
            results: [{ status: 'rejected' }]
        });

        const state = makeState({
            step: 'waiting_mp_payment',
            paymentMethod: 'mercadopago',
            mpPaymentLinkId: 'pl_abc',
            mpPaymentLinkUrl: 'https://mp.com/link'
        });
        await handleWaitingMpPayment('user1@c.us', 'listo', 'listo', state, knowledge, deps);

        expect(state.paymentMethod).toBe('efectivo');
        expect(state.step).toBe('waiting_data');
        const msg = mockSendMessage.mock.calls[0][1];
        expect(msg).toMatch(/efectivo/i);
    });

    test('"no puedo" switches to efectivo fallback', async () => {
        const state = makeState({
            step: 'waiting_mp_payment',
            paymentMethod: 'mercadopago',
            mpPaymentLinkId: 'pl_abc',
            mpPaymentLinkUrl: 'https://mp.com/link'
        });
        await handleWaitingMpPayment('user1@c.us', 'no puedo pagar', 'no puedo pagar', state, knowledge, deps);

        expect(state.paymentMethod).toBe('efectivo');
        expect(state.step).toBe('waiting_data');
    });

    test('"reenvía el link" resends existing link', async () => {
        const state = makeState({
            step: 'waiting_mp_payment',
            paymentMethod: 'mercadopago',
            mpPaymentLinkId: 'pl_abc',
            mpPaymentLinkUrl: 'https://mp.com/test-link'
        });
        await handleWaitingMpPayment('user1@c.us', 'reenvía el link', 'reenvia el link', state, knowledge, deps);

        const msg = mockSendMessage.mock.calls[0][1];
        expect(msg).toContain('https://mp.com/test-link');
    });
});
