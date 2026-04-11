/**
 * Payment method flow tests — 3 opciones: MercadoPago, Transferencia, Contra reembolso
 *
 * Cobertura:
 *  - stepWaitingOk → transición a waiting_payment_method
 *  - stepWaitingPaymentMethod → detección de keyword y branch correcto
 *  - stepWaitingMpPayment — generación de link, verificación de pago, fallbacks
 *  - adicionalMAX: bonificado en MP y transferencia, conservado en CR
 *  - Notificaciones al admin incluyen método de pago
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
function makeOkState(overrides = {}) {
    return {
        step: 'waiting_ok',
        history: [{ role: 'bot', content: '¿Podés retirar en sucursal?', timestamp: Date.now() }],
        cart: [{ product: 'Cápsulas', plan: '60', price: '46.900' }],
        selectedProduct: 'Cápsulas',
        selectedPlan: '60',
        totalPrice: '52.900',
        isContraReembolsoMAX: true,
        adicionalMAX: 6000,
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        ...overrides,
    };
}

function makePaymentState(plan = '60', overrides = {}) {
    const is60 = plan === '60';
    return {
        step: 'waiting_payment_method',
        history: [],
        cart: [{ product: 'Cápsulas', plan, price: is60 ? '46.900' : '66.900' }],
        selectedProduct: 'Cápsulas',
        selectedPlan: plan,
        totalPrice: is60 ? '52.900' : '66.900',
        isContraReembolsoMAX: is60,
        adicionalMAX: is60 ? 6000 : 0,
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
// BLOQUE 1: stepWaitingOk → transition to waiting_payment_method
// ════════════════════════════════════════════════════════════════════════════
describe('stepWaitingOk → pregunta método de pago', () => {

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

    test('[1.3] "ok" → envía mensaje con las 3 opciones de pago', async () => {
        const state = makeOkState();
        await handleWaitingOk('u3', 'ok', 'ok', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/MercadoPago/i);
        expect(sent).toMatch(/Transferencia/i);
        expect(sent).toMatch(/Contra reembolso/i);
    });

    test('[1.4] Plan 60: mensaje incluye el adicional de $6.000', async () => {
        const state = makeOkState({ selectedPlan: '60', adicionalMAX: 6000 });
        await handleWaitingOk('u4', 'si', 'si', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/6\.000/);
    });

    test('[1.5] Plan 120: mensaje indica que no hay adicional', async () => {
        const state = makeOkState({ selectedPlan: '120', adicionalMAX: 0, isContraReembolsoMAX: false });
        await handleWaitingOk('u5', 'si', 'si', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, msg]) => msg).join(' ');
        expect(sent).toMatch(/sin adicional/i);
    });

    test('[1.6] Negativa → NO va a waiting_payment_method', async () => {
        const state = makeOkState();
        await handleWaitingOk('u6', 'no no puedo', 'no no puedo', state, knowledge, deps);
        expect(state.step).not.toBe('waiting_payment_method');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 2: stepWaitingPaymentMethod — Opción 2: MercadoPago
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

    test('[2.3] "2" → waiting_mp_payment', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('mp3', '2', '2', state, knowledge, deps);
        expect(state.step).toBe('waiting_mp_payment');
    });

    test('[2.4] Plan 60: MP waivea el adicionalMAX ($6000)', async () => {
        const state = makePaymentState('60'); // totalPrice 52.900, adicionalMAX 6000
        await handleWaitingPaymentMethod('mp4', 'mercadopago', 'mercadopago', state, knowledge, deps);
        expect(state.adicionalMAX).toBe(0);
        // 52900 - 6000 = 46900
        expect(state.totalPrice).toBe('46.900');
        expect(state.isContraReembolsoMAX).toBe(false);
    });

    test('[2.5] Plan 120: MP no modifica el total (ya sin adicional)', async () => {
        const state = makePaymentState('120'); // adicionalMAX=0
        const totalAntes = state.totalPrice;
        await handleWaitingPaymentMethod('mp5', 'mercadopago', 'mercadopago', state, knowledge, deps);
        expect(state.totalPrice).toBe(totalAntes);
        expect(state.adicionalMAX).toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 3: stepWaitingMpPayment — link, pago aprobado, pending, fallbacks
// ════════════════════════════════════════════════════════════════════════════
describe('Pago con MercadoPago — flow completo', () => {

    test('[3.1] Entry sin link → genera preferencia MP y envía enlace', async () => {
        const state = makeMpState(); // sin mpPaymentLinkUrl
        await handleWaitingMpPayment('mp_e1', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).toHaveBeenCalledTimes(1);
        expect(state.mpPaymentLinkUrl).toBe('https://mp.com/checkout/pref_test');
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/mercadopago/i);
        expect(sent).toMatch(/listo/i);
    });

    test('[3.2] "listo" + pago aprobado → avanza al flow de datos', async () => {
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'pending', externalRef: 'ref-1' });
        mockPaymentSearch.mockResolvedValueOnce({
            results: [{ status: 'approved', date_approved: new Date().toISOString() }],
        });

        const state = makeMpState({ mpPaymentLinkUrl: 'https://mp.com/link', mpPaymentLinkId: 'pl-1' });
        await handleWaitingMpPayment('mp_e2', 'listo', 'listo', state, knowledge, deps);

        // Debe guardar el pago y avanzar
        expect(mockPaymentLinkUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) }));
        // Paso avanza (a waiting_data o waiting_final_confirmation)
        expect(['waiting_data', 'waiting_final_confirmation']).toContain(state.step);
    });

    test('[3.3] "ya pagué" + pago aprobado con dirección → waiting_final_confirmation', async () => {
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'pending', externalRef: 'ref-1' });
        mockPaymentSearch.mockResolvedValueOnce({
            results: [{ status: 'approved', date_approved: new Date().toISOString() }],
        });

        const state = makeMpState({
            mpPaymentLinkUrl: 'https://mp.com/link',
            mpPaymentLinkId: 'pl-1',
            partialAddress: { nombre: 'Ana Gomez', calle: 'Rivadavia 500', ciudad: 'CABA' },
        });
        await handleWaitingMpPayment('mp_e3', 'ya pagué', 'ya pague', state, knowledge, deps);
        expect(state.step).toBe('waiting_final_confirmation');
    });

    test('[3.4] "listo" + pago PENDING → mensaje de espera, no avanza', async () => {
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'pending', externalRef: 'ref-1' });
        mockPaymentSearch.mockResolvedValueOnce({ results: [] }); // sin resultados = pending

        const state = makeMpState({ mpPaymentLinkUrl: 'https://mp.com/link', mpPaymentLinkId: 'pl-1' });
        await handleWaitingMpPayment('mp_e4', 'listo', 'listo', state, knowledge, deps);

        expect(state.step).toBe('waiting_mp_payment'); // no avanzó
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/todav[ií]a/i);
    });

    test('[3.5] "listo" + pago RECHAZADO → ofrece transferencia/CR y vuelve a waiting_payment_method', async () => {
        mockPaymentLinkFindUnique.mockResolvedValueOnce({ id: 'pl-1', status: 'pending', externalRef: 'ref-1' });
        mockPaymentSearch.mockResolvedValueOnce({
            results: [{ status: 'rejected' }],
        });

        const state = makeMpState({ mpPaymentLinkUrl: 'https://mp.com/link', mpPaymentLinkId: 'pl-1' });
        await handleWaitingMpPayment('mp_e5', 'listo', 'listo', state, knowledge, deps);

        expect(state.step).toBe('waiting_payment_method');
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/transferencia/i);
    });

    test('[3.6] Cliente pide el link de nuevo → lo reenvía', async () => {
        const state = makeMpState({ mpPaymentLinkUrl: 'https://mp.com/el-link', mpPaymentLinkId: 'pl-1' });
        await handleWaitingMpPayment('mp_e6', 'mandame el link de nuevo', 'mandame el link de nuevo', state, knowledge, deps);
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toContain('https://mp.com/el-link');
    });

    test('[3.7] MP_ACCESS_TOKEN no configurado → fallback a contra reembolso', async () => {
        delete process.env.MP_ACCESS_TOKEN;
        const state = makeMpState(); // sin link, entra a generar
        await handleWaitingMpPayment('mp_e7', 'hola', 'hola', state, knowledge, deps);
        expect(mockPreferenceCreate).not.toHaveBeenCalled();
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.step).toBe('waiting_data');
        process.env.MP_ACCESS_TOKEN = 'TEST_TOKEN';
    });

    test('[3.8] Error al generar link → ofrece transferencia o CR', async () => {
        mockPreferenceCreate.mockRejectedValueOnce(new Error('MP API error'));
        const state = makeMpState();
        await handleWaitingMpPayment('mp_e8', 'hola', 'hola', state, knowledge, deps);
        expect(state.step).toBe('waiting_payment_method');
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/transferencia/i);
    });

    test('[3.9] Cliente pide transferencia desde MP → manda alias y pausa', async () => {
        const state = makeMpState({ mpPaymentLinkUrl: 'https://mp.com/link', mpPaymentLinkId: 'pl-1' });
        await handleWaitingMpPayment('mp_e9', 'transferencia', 'transferencia', state, knowledge, deps);
        expect(state.paymentMethod).toBe('transferencia');
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/CHILE\.TEXTO\.CASINO/);
        expect(mockPauseUsers.has('mp_e9')).toBe(true);
    });

    test('[3.10] Cliente pide contra reembolso desde MP → waiting_data', async () => {
        const state = makeMpState({ mpPaymentLinkUrl: 'https://mp.com/link', mpPaymentLinkId: 'pl-1' });
        await handleWaitingMpPayment('mp_e10', 'efectivo', 'efectivo', state, knowledge, deps);
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.step).toBe('waiting_data');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 4: stepWaitingPaymentMethod — Opción 3: Transferencia
// ════════════════════════════════════════════════════════════════════════════
describe('Método de pago → Transferencia', () => {

    test('[4.1] "transferencia" → envía alias y pausa el bot', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('tr1', 'transferencia', 'transferencia', state, knowledge, deps);
        expect(state.paymentMethod).toBe('transferencia');
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/CHILE\.TEXTO\.CASINO/);
        expect(mockPauseUsers.has('tr1')).toBe(true);
    });

    test('[4.2] "3" → detecta transferencia', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('tr2', '3', '3', state, knowledge, deps);
        expect(state.paymentMethod).toBe('transferencia');
    });

    test('[4.3] Plan 60: transferencia waivea el adicionalMAX', async () => {
        const state = makePaymentState('60'); // total 52900, adicional 6000
        await handleWaitingPaymentMethod('tr3', 'transferencia', 'transferencia', state, knowledge, deps);
        expect(state.adicionalMAX).toBe(0);
        expect(state.totalPrice).toBe('46.900');
    });

    test('[4.4] Plan 120: transferencia no modifica total', async () => {
        const state = makePaymentState('120');
        const totalAntes = state.totalPrice;
        await handleWaitingPaymentMethod('tr4', 'transferencia', 'transferencia', state, knowledge, deps);
        expect(state.totalPrice).toBe(totalAntes);
    });

    test('[4.5] notifyAdmin incluye motivo transferencia', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('tr5', 'transferencia', 'transferencia', state, knowledge, deps);
        expect(mockNotify).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            expect.stringContaining('transferencia')
        );
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 5: stepWaitingPaymentMethod — Opción 1: Contra reembolso
// ════════════════════════════════════════════════════════════════════════════
describe('Método de pago → Contra reembolso', () => {

    test('[5.1] "contra reembolso" → waiting_data', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('cr1', 'contra reembolso', 'contra reembolso', state, knowledge, deps);
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.step).toBe('waiting_data');
    });

    test('[5.2] "efectivo" → waiting_data', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('cr2', 'efectivo', 'efectivo', state, knowledge, deps);
        expect(state.paymentMethod).toBe('contrarembolso');
        expect(state.step).toBe('waiting_data');
    });

    test('[5.3] "1" → waiting_data', async () => {
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('cr3', '1', '1', state, knowledge, deps);
        expect(state.step).toBe('waiting_data');
    });

    test('[5.4] CR conserva el adicionalMAX (plan 60 → sigue teniendo adicional)', async () => {
        const state = makePaymentState('60'); // adicionalMAX=6000
        await handleWaitingPaymentMethod('cr4', 'contrarembolso', 'contrarembolso', state, knowledge, deps);
        expect(state.adicionalMAX).toBe(6000); // NO bonificado
        expect(state.totalPrice).toBe('52.900');
    });

    test('[5.5] CR con dirección ya conocida → waiting_final_confirmation (no pide datos)', async () => {
        const state = makePaymentState('60', {
            partialAddress: { nombre: 'Luis Perez', calle: 'Corrientes 800', ciudad: 'Rosario' },
        });
        await handleWaitingPaymentMethod('cr5', 'efectivo', 'efectivo', state, knowledge, deps);
        expect(state.step).toBe('waiting_final_confirmation');
    });

    test('[5.6] CR sin dirección → pide datos (waiting_data)', async () => {
        const state = makePaymentState('60'); // partialAddress vacío
        await handleWaitingPaymentMethod('cr6', 'al recibir', 'al recibir', state, knowledge, deps);
        expect(state.step).toBe('waiting_data');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 6: AI fallback — respuesta ambigua
// ════════════════════════════════════════════════════════════════════════════
describe('Método de pago — AI fallback', () => {

    test('[6.1] Mensaje ambiguo → AI responde y no cambia el step', async () => {
        aiService.chat.mockResolvedValueOnce({ response: 'No entendí bien, ¿MP o efectivo?', goalMet: false });
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('ai1', 'no sé cual me conviene', 'no se cual me conviene', state, knowledge, deps);
        expect(state.step).toBe('waiting_payment_method');
        const sent = mockSend.mock.calls.map(([, m]) => m).join(' ');
        expect(sent).toMatch(/MP|efectivo/i);
    });

    test('[6.2] AI goal empuja MP como prioridad en el prompt', async () => {
        aiService.chat.mockResolvedValueOnce({ response: 'Te recomiendo MercadoPago', goalMet: false });
        const state = makePaymentState('60');
        await handleWaitingPaymentMethod('ai2', 'no sé', 'no se', state, knowledge, deps);
        const call = aiService.chat.mock.calls[0];
        const goal = call[1]?.goal || '';
        expect(goal).toMatch(/MercadoPago/i);
        // El goal lista las opciones numeradas (1=CR, 2=MP, 3=Transfer) pero la sección
        // PRIORIDAD al final indica que se debe empujar MP primero.
        expect(goal).toMatch(/PRIORIDAD.*MercadoPago/is);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// BLOQUE 7: Registro de método en PaymentLink (instanceId del seller)
// ════════════════════════════════════════════════════════════════════════════
describe('PaymentLink — instanceId del seller', () => {

    test('[7.1] Link creado incluye instanceId del seller', async () => {
        const state = makeMpState();
        await handleWaitingMpPayment('pl1', 'hola', 'hola', state, knowledge, { ...deps, sellerId: 'horacio' });
        expect(mockPaymentLinkCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ instanceId: 'horacio' }),
            })
        );
    });
});
