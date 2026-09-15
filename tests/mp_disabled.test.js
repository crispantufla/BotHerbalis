/**
 * Modo SIN Mercado Pago — interruptor `config.mpEnabled = false` (jul-2026).
 *
 * Se apaga desde Configuración cuando la cuenta de MP está bloqueada. Fuera de
 * la zona de reparto propio (modelo sep-2026) queda una sola forma prepago:
 *   · Domicilio o sucursal por Correo → transferencia al alias
 * (El reparto propio de Rosario cobra al recibir y no depende de MP.)
 *
 * Lo que se verifica acá:
 *  - Domicilio y sucursal NO abren el submenú de medios: mandan el alias y
 *    pasan a esperar la transferencia.
 *  - Pedir tarjeta (en payment_method o en transfer_confirmation) responde que
 *    no está disponible y NO deriva a waiting_mp_payment.
 *  - waiting_mp_payment (estados viejos) no genera link nuevo.
 *  - Con el interruptor ENCENDIDO todo se comporta como siempre (regresión).
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
            create: jest.fn().mockResolvedValue({ id: 'pl-1', status: 'pending', externalRef: 'ref-1' }),
            findUnique: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({}),
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
const { getFlowTemplate } = require('../src/utils/messageTemplates');
const { isMpEnabled, prepayMeans } = require('../src/flows/utils/paymentOptions');
const { aiService } = require('../src/services/ai');

// ─── Shared mocks ────────────────────────────────────────────────────────────
const mockSend = jest.fn();
const mockSave = jest.fn();
const mockNotify = jest.fn();
const mockPauseUsers = new Set();

// deps con el interruptor APAGADO
function makeDeps(mpEnabled) {
    const config = { alertNumbers: [], ...(mpEnabled === undefined ? {} : { mpEnabled }) };
    return {
        saveState: mockSave,
        sendMessageWithDelay: mockSend,
        notifyAdmin: mockNotify,
        aiService,
        sellerId: 'vendedor_test',
        sharedState: {
            pausedUsers: mockPauseUsers,
            io: null,
            saveState: mockSave,
            config,
        },
        config,
        logAndEmit: jest.fn(),
    };
}

const depsMpOff = makeDeps(false);
const depsMpOn = makeDeps(undefined); // sin la clave → encendido por default

const knowledge = { flow: {} }; // sin overrides: los templates salen de knowledge_v7.json

function makePaymentState(overrides = {}) {
    return {
        step: 'waiting_payment_method',
        deliveryZone: 'out',
        history: [],
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

const USER = '5493411234567@c.us';
const lastMsg = () => mockSend.mock.calls[mockSend.mock.calls.length - 1][1];
const allMsgs = () => mockSend.mock.calls.map(c => c[1]).join('\n---\n');
const CARD_RE = /tarjeta|mercado\s?pago|link de pago/i;

beforeEach(() => {
    jest.clearAllMocks();
    mockPauseUsers.clear();
});

describe('Interruptor de Mercado Pago', () => {
    test('default encendido; solo apagado si se guardó false', () => {
        expect(isMpEnabled(undefined)).toBe(true);
        expect(isMpEnabled({})).toBe(true);
        expect(isMpEnabled({ mpEnabled: true })).toBe(true);
        expect(isMpEnabled({ mpEnabled: false })).toBe(false);
        expect(prepayMeans(false)).not.toMatch(CARD_RE);
    });

    test('getFlowTemplate prefiere la variante responseNoMp del guion', () => {
        const conTarjeta = getFlowTemplate('zone_out', knowledge, false);
        const sinTarjeta = getFlowTemplate('zone_out', knowledge, true);
        expect(conTarjeta).toMatch(CARD_RE);
        expect(sinTarjeta).not.toMatch(CARD_RE);
        expect(sinTarjeta).toMatch(/transferencia/i);
    });
});

describe('waiting_payment_method con MP apagado', () => {
    test('"a domicilio" manda el alias directo, sin submenú de medios', async () => {
        const state = makePaymentState();
        const res = await handleWaitingPaymentMethod(USER, 'a domicilio', 'a domicilio', state, knowledge, depsMpOff);

        expect(res.matched).toBe(true);
        expect(state.paymentSubChoiceAsked).toBeFalsy();
        expect(state.shippingChoice).toBe('domicilio');
        expect(state.paymentMethod).toBe('transferencia');
        expect(state.step).toBe('waiting_transfer_confirmation');
        expect(lastMsg()).toMatch(/HERBALIS\.TIENDA/);
        expect(lastMsg()).not.toMatch(CARD_RE);
    });

    test('opción "1" (domicilio) también va derecho a transferencia', async () => {
        const state = makePaymentState();
        await handleWaitingPaymentMethod(USER, '1', '1', state, knowledge, depsMpOff);

        expect(state.paymentMethod).toBe('transferencia');
        expect(state.step).toBe('waiting_transfer_confirmation');
        expect(lastMsg()).not.toMatch(CARD_RE);
    });

    test('pedir tarjeta avisa que no está disponible y NO pasa a waiting_mp_payment', async () => {
        const state = makePaymentState();
        const res = await handleWaitingPaymentMethod(USER, 'quiero pagar con tarjeta', 'quiero pagar con tarjeta', state, knowledge, depsMpOff);

        expect(res.matched).toBe(true);
        expect(state.step).toBe('waiting_payment_method');
        expect(state.paymentMethod).toBeUndefined();
        expect(mockPreferenceCreate).not.toHaveBeenCalled();
        expect(lastMsg()).toMatch(/fuera de servicio/i);
        expect(lastMsg()).toMatch(/transferencia/i);
        expect(lastMsg()).not.toMatch(/efectivo/i);
    });

    test('pedir "mercado pago" por nombre tiene el mismo tratamiento', async () => {
        const state = makePaymentState();
        await handleWaitingPaymentMethod(USER, 'con mercado pago', 'con mercado pago', state, knowledge, depsMpOff);

        expect(state.paymentMethod).toBeUndefined();
        expect(state.step).toBe('waiting_payment_method');
        expect(lastMsg()).toMatch(/fuera de servicio/i);
    });

    test('el submenú viejo (paymentSubChoiceAsked) no deriva a MP si eligen tarjeta', async () => {
        const state = makePaymentState({ paymentSubChoiceAsked: true, shippingChoice: 'domicilio' });
        await handleWaitingPaymentMethod(USER, 'tarjeta de credito', 'tarjeta de credito', state, knowledge, depsMpOff);

        expect(state.step).toBe('waiting_payment_method');
        expect(state.paymentMethod).toBeUndefined();
        expect(state.paymentSubChoiceAsked).toBe(false);
        expect(lastMsg()).toMatch(/fuera de servicio/i);
    });

    test('retiro en sucursal (prepago) va derecho al alias, sin submenú', async () => {
        const state = makePaymentState();
        await handleWaitingPaymentMethod(USER, 'retiro en sucursal', 'retiro en sucursal', state, knowledge, depsMpOff);

        expect(state.paymentMethod).toBe('transferencia');
        expect(state.shippingChoice).toBe('retiro');
        expect(state.partialAddress.calle).toBe('A sucursal');
        expect(state.step).toBe('waiting_transfer_confirmation');
        expect(allMsgs()).toMatch(/HERBALIS\.TIENDA/);
        expect(allMsgs()).not.toMatch(CARD_RE);
    });

    test('"no tengo efectivo" aclara que todo va prepago por transferencia y pregunta el envío', async () => {
        const state = makePaymentState();
        await handleWaitingPaymentMethod(USER, 'no tengo efectivo', 'no tengo efectivo', state, knowledge, depsMpOff);

        expect(state.shippingChoice).toBeFalsy();
        expect(state.step).toBe('waiting_payment_method');
        expect(lastMsg()).toMatch(/transferencia/i);
        expect(lastMsg()).toMatch(/casa o en sucursal/i);
        expect(lastMsg()).not.toMatch(CARD_RE);
    });

    test('el goal que se le pasa a la IA prohíbe ofrecer tarjeta', async () => {
        const state = makePaymentState();
        await handleWaitingPaymentMethod(USER, 'y eso como es?', 'y eso como es?', state, knowledge, depsMpOff);

        expect(aiService.chat).toHaveBeenCalled();
        const goal = aiService.chat.mock.calls[0][1].goal;
        expect(goal).toMatch(/FUERA DE SERVICIO/);
        expect(goal).toMatch(/HERBALIS\.TIENDA/);
    });
});

describe('waiting_mp_payment con MP apagado', () => {
    function makeMpState(overrides = {}) {
        return {
            step: 'waiting_mp_payment',
            history: [],
            cart: [{ product: 'Cápsulas', plan: '60', price: '46.900' }],
            selectedProduct: 'Cápsulas',
            selectedPlan: '60',
            totalPrice: '46.900',
            partialAddress: {},
            summary: '',
            stepEnteredAt: Date.now(),
            ...overrides,
        };
    }

    test('no genera link nuevo: deriva a transferencia', async () => {
        const state = makeMpState();
        const res = await handleWaitingMpPayment(USER, 'hola', 'hola', state, knowledge, depsMpOff);

        expect(res.matched).toBe(true);
        expect(mockPreferenceCreate).not.toHaveBeenCalled();
        expect(state.mpPaymentLinkUrl).toBeFalsy();
        expect(state.paymentMethod).toBe('transferencia');
        expect(state.step).toBe('waiting_transfer_confirmation');
        expect(state.mpReminderStage).toBe(99);
        expect(lastMsg()).toMatch(/HERBALIS\.TIENDA/);
        expect(lastMsg()).not.toMatch(/retiro en sucursal/i);
    });

    test('con link viejo NO lo reenvía aunque lo pidan', async () => {
        const state = makeMpState({ mpPaymentLinkUrl: 'https://mp.com/checkout/viejo', mpPaymentLinkId: 'pl-1' });
        await handleWaitingMpPayment(USER, 'mandame el link de nuevo', 'mandame el link de nuevo', state, knowledge, depsMpOff);

        expect(allMsgs()).not.toContain('https://mp.com/checkout/viejo');
    });
});

describe('waiting_transfer_confirmation con MP apagado', () => {
    function makeTransferState(overrides = {}) {
        return {
            step: 'waiting_transfer_confirmation',
            history: [],
            cart: [{ product: 'Cápsulas', plan: '60', price: '46.900' }],
            selectedProduct: 'Cápsulas',
            selectedPlan: '60',
            totalPrice: '46.900',
            paymentMethod: 'transferencia',
            shippingChoice: 'domicilio',
            partialAddress: {},
            summary: '',
            stepEnteredAt: Date.now(),
            ...overrides,
        };
    }

    test('"mejor con tarjeta" no reencauza a payment_method: avisa y sigue', async () => {
        const state = makeTransferState();
        const res = await handleWaitingTransferConfirmation(USER, 'mejor con tarjeta', 'mejor con tarjeta', state, knowledge, depsMpOff);

        expect(res.matched).toBe(true);
        expect(state.step).toBe('waiting_transfer_confirmation');
        expect(state.paymentMethod).toBe('transferencia');
        expect(lastMsg()).toMatch(/fuera de servicio/i);
    });
});

describe('Regresión — con el interruptor ENCENDIDO nada cambia', () => {
    test('"a domicilio" vuelve a abrir el submenú con tarjeta', async () => {
        const state = makePaymentState();
        await handleWaitingPaymentMethod(USER, 'a domicilio', 'a domicilio', state, knowledge, depsMpOn);

        expect(state.paymentSubChoiceAsked).toBe(true);
        expect(state.step).toBe('waiting_payment_method');
        expect(lastMsg()).toMatch(CARD_RE);
    });

    test('pedir tarjeta deriva a waiting_mp_payment como siempre', async () => {
        const state = makePaymentState();
        const res = await handleWaitingPaymentMethod(USER, 'quiero pagar con tarjeta', 'quiero pagar con tarjeta', state, knowledge, depsMpOn);

        expect(state.paymentMethod).toBe('mercadopago');
        expect(state.step).toBe('waiting_mp_payment');
        expect(res.staleReprocess).toBe(true);
    });
});
