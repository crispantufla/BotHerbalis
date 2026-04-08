/**
 * End-to-end conversation tests: MP vs contrarembolso
 * 5 clients accept MercadoPago, 5 refuse and buy cash on delivery
 */

const mockSend = jest.fn();
const mockSave = jest.fn();
const mockNotify = jest.fn();

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));

const mockPreferenceCreate = jest.fn().mockResolvedValue({
    id: 'pref_test',
    init_point: 'https://www.mercadopago.com.ar/checkout/pref_test'
});
const mockPaymentSearch = jest.fn().mockResolvedValue({ results: [] });

jest.mock('mercadopago', () => ({
    MercadoPagoConfig: jest.fn().mockImplementation(() => ({})),
    Preference: jest.fn().mockImplementation(() => ({ create: mockPreferenceCreate })),
    Payment: jest.fn().mockImplementation(() => ({ search: mockPaymentSearch }))
}), { virtual: true });

jest.mock('../db', () => ({
    prisma: {
        order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }), findFirst: jest.fn().mockResolvedValue(null) },
        user: { upsert: jest.fn().mockResolvedValue({}) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        paymentLink: {
            create: jest.fn().mockResolvedValue({ id: 'pl-1', status: 'pending', externalRef: 'ref-1' }),
            findUnique: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({ id: 'pl-1', status: 'approved' })
        }
    }
}));

jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: 'AI fallback', goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue({})
    }
}));

const { handleWaitingPaymentMethod } = require('../src/flows/steps/stepWaitingPaymentMethod');
const { handleWaitingMpPayment } = require('../src/flows/steps/stepWaitingMpPayment');

const knowledge = {
    flow: {
        closing: {
            response: '¡Perfecto! 😊 Una última pregunta...',
            nextStep: 'waiting_payment_method'
        }
    },
    faq: []
};

const deps = {
    saveState: mockSave,
    sendMessageWithDelay: mockSend,
    notifyAdmin: mockNotify,
    aiService: require('../src/services/ai').aiService,
    sharedState: { pausedUsers: new Set(), io: null }
};

function makePlan120State(overrides = {}) {
    return {
        step: 'waiting_payment_method',
        history: [],
        cart: [{ product: 'Cápsulas de Nuez de la India', plan: '120', price: '66.900' }],
        selectedProduct: 'Cápsulas de Nuez de la India',
        selectedPlan: '120',
        totalPrice: '66.900',
        isContraReembolsoMAX: false,
        adicionalMAX: 0,
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        ...overrides
    };
}

function makePlan60State(overrides = {}) {
    return {
        step: 'waiting_payment_method',
        history: [],
        cart: [{ product: 'Cápsulas de Nuez de la India', plan: '60', price: '46.900' }],
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

beforeEach(() => {
    jest.clearAllMocks();
    process.env.MP_ACCESS_TOKEN = 'TEST_TOKEN';
});

afterAll(() => { delete process.env.MP_ACCESS_TOKEN; });

// ─── 5 conversaciones que ACEPTAN MercadoPago ────────────────────────────────

describe('Acepta MercadoPago', () => {

    test('[Conv 1] Escribe "mercadopago" → enlace generado y enviado', async () => {
        const state = makePlan120State();
        await handleWaitingPaymentMethod('conv1@c.us', 'mercadopago', 'mercadopago', state, knowledge, deps);
        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.step).toBe('waiting_mp_payment');

        // Entra al paso MP — genera el link
        mockSend.mockClear();
        await handleWaitingMpPayment('conv1@c.us', 'dale', 'dale', state, knowledge, deps);
        expect(mockPreferenceCreate).toHaveBeenCalled();
        expect(state.mpPaymentLinkUrl).toContain('mercadopago');
        const msg = mockSend.mock.calls[0][1];
        expect(msg).toMatch(/mercadopago/i);
        expect(msg).toMatch(/listo/i);
    });

    test('[Conv 2] Escribe "1" (opción 1) → enlace generado', async () => {
        const state = makePlan120State();
        await handleWaitingPaymentMethod('conv2@c.us', '1', '1', state, knowledge, deps);
        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.step).toBe('waiting_mp_payment');

        mockSend.mockClear();
        await handleWaitingMpPayment('conv2@c.us', 'ok', 'ok', state, knowledge, deps);
        expect(state.mpPaymentLinkUrl).toBeTruthy();
        const msg = mockSend.mock.calls[0][1];
        expect(msg).toMatch(/pago online/i);
    });

    test('[Conv 3] Plan 60 + elige MP → adicional $6.000 removido, precio correcto', async () => {
        const state = makePlan60State();
        expect(state.totalPrice).toBe('52.900');
        expect(state.adicionalMAX).toBe(6000);

        await handleWaitingPaymentMethod('conv3@c.us', 'pago online', 'pago online', state, knowledge, deps);
        expect(state.paymentMethod).toBe('mercadopago');
        // 52900 - 6000 = 46900
        expect(state.totalPrice).toBe('46.900');
        expect(state.adicionalMAX).toBe(0);
    });

    test('[Conv 4] Pago confirmado "listo" → avanza a waiting_data', async () => {
        const { prisma } = require('../db');
        prisma.paymentLink.findUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'pending', externalRef: 'ref-1' });
        mockPaymentSearch.mockResolvedValueOnce({
            results: [{ status: 'approved', date_approved: new Date().toISOString() }]
        });

        const state = makePlan120State({
            step: 'waiting_mp_payment',
            paymentMethod: 'mercadopago',
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/link'
        });
        await handleWaitingMpPayment('conv4@c.us', 'listo', 'listo', state, knowledge, deps);
        expect(state.step).toBe('waiting_data');
        const msg = mockSend.mock.calls[0][1];
        expect(msg).toMatch(/confirmado/i);
        expect(msg).toMatch(/datos/i);
    });

    test('[Conv 5] Pago aprobado + ya tiene dirección → salta directo a waiting_final_confirmation sin pedir datos', async () => {
        const { prisma } = require('../db');
        prisma.paymentLink.findUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'pending', externalRef: 'ref-1' });
        mockPaymentSearch.mockResolvedValueOnce({
            results: [{ status: 'approved', date_approved: new Date().toISOString() }]
        });

        const state = makePlan120State({
            step: 'waiting_mp_payment',
            paymentMethod: 'mercadopago',
            mpPaymentLinkId: 'pl-1',
            mpPaymentLinkUrl: 'https://mp.com/link',
            partialAddress: {
                nombre: 'Laura García',
                calle: 'Av. Córdoba 1500',
                ciudad: 'Buenos Aires',
                cp: '1414',
                provincia: 'CABA'
            }
        });
        await handleWaitingMpPayment('conv5@c.us', 'listo', 'listo', state, knowledge, deps);

        // Pago aprobado + dirección existente → confirmation directa
        expect(state.step).toBe('waiting_final_confirmation');
        const msgs = mockSend.mock.calls.map(c => c[1]);
        expect(msgs[0]).toMatch(/confirmado/i);
        expect(msgs[1]).toMatch(/CONFIRMACI[OÓ]N/i); // buildConfirmationMessage
    });
});

// ─── 5 conversaciones que SE NIEGAN y compran por contrarembolso ──────────────

describe('Rechaza MP — compra por contrarembolso', () => {

    test('[Conv 6] Escribe "efectivo" → va a waiting_data', async () => {
        const state = makePlan120State();
        await handleWaitingPaymentMethod('conv6@c.us', 'efectivo', 'efectivo', state, knowledge, deps);
        expect(state.paymentMethod).toBe('efectivo');
        expect(state.step).toBe('waiting_data');
        const msg = mockSend.mock.calls[0][1];
        expect(msg).toMatch(/datos|nombre|calle/i);
    });

    test('[Conv 7] Escribe "2" (opción 2) → va a waiting_data', async () => {
        const state = makePlan120State();
        await handleWaitingPaymentMethod('conv7@c.us', '2', '2', state, knowledge, deps);
        expect(state.paymentMethod).toBe('efectivo');
        expect(state.step).toBe('waiting_data');
    });

    test('[Conv 8] Escribe "al recibir" → va a waiting_data, total conserva adicional', async () => {
        const state = makePlan60State();
        await handleWaitingPaymentMethod('conv8@c.us', 'prefiero pagar al recibir', 'prefiero pagar al recibir', state, knowledge, deps);
        expect(state.paymentMethod).toBe('efectivo');
        expect(state.step).toBe('waiting_data');
        // adicionalMAX NO fue removido (paga en destino)
        expect(state.adicionalMAX).toBe(6000);
        expect(state.totalPrice).toBe('52.900');
    });

    test('[Conv 9] Duda sin keyword clara → AI fallback intenta convencer con argumentos MP', async () => {
        const state = makePlan120State();
        await handleWaitingPaymentMethod('conv9@c.us', '¿hay alguna otra forma?', 'hay alguna otra forma?', state, knowledge, deps);

        const { aiService } = require('../src/services/ai');
        expect(aiService.chat).toHaveBeenCalledWith(
            '¿hay alguna otra forma?',
            expect.objectContaining({ step: 'waiting_payment_method' })
        );
        // Goal in AI should mention MP benefits
        const callArgs = aiService.chat.mock.calls[0][1];
        expect(callArgs.goal).toMatch(/MercadoPago/);
        expect(callArgs.goal).toMatch(/cómodo|efectivo/i);
        // Step stays — user hasn't decided yet
        expect(state.step).toBe('waiting_payment_method');
    });

    test('[Conv 10] Ya tiene dirección + elige efectivo → salta directo a waiting_final_confirmation', async () => {
        const state = makePlan120State({
            partialAddress: {
                nombre: 'Martín López',
                calle: 'San Martín 450',
                ciudad: 'Rosario',
                cp: '2000',
                provincia: 'Santa Fe'
            }
        });
        await handleWaitingPaymentMethod('conv10@c.us', 'prefiero efectivo al recibir', 'prefiero efectivo al recibir', state, knowledge, deps);
        expect(state.paymentMethod).toBe('efectivo');
        // Tiene dirección → salta a confirmación
        expect(state.step).toBe('waiting_final_confirmation');
        const msg = mockSend.mock.calls[0][1];
        expect(msg).toMatch(/CONFIRMACI[OÓ]N/i);
    });
});
