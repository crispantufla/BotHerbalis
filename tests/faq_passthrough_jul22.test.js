/**
 * Passthroughs de FAQ POR STEP (22-jul-2026) — misma clase de bug que el caso
 * 5492215731759 pero en steps que NO estaban cubiertos:
 *
 *  1. waiting_maps_confirmation: el bot pide "respondé *sí*" y el cliente
 *     contesta "Si, es correcta ¿cuánto tarda en llegar?" → la FAQ de envíos
 *     matcheaba "cuanto tarda", devolvía matched=true y el "sí" nunca llegaba
 *     al step → la orden no se armaba. Ojo: "y si tarda mucho?" es un "si"
 *     CONDICIONAL y NO debe confirmar la dirección.
 *
 *  2. waiting_mp_payment / waiting_transfer_confirmation: "Ya hice la
 *     transferencia ¿me confirmás?" → la keyword "transferencia" matcheaba la
 *     FAQ del alias, el bot RE-MANDABA las instrucciones de transferir (ya
 *     transfirió) y el step nunca veía el aviso de pago. Acá la canned response
 *     queda desactualizada frente al claim: se skipea EN SILENCIO y responde
 *     el paid-branch del step.
 */

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));

jest.mock('../db', () => ({
    prisma: {
        user: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        order: { create: jest.fn().mockResolvedValue({ id: 'o1' }), findFirst: jest.fn().mockResolvedValue(null) },
        paymentLink: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
    },
}));

jest.mock('../src/services/funnelLogger', () => ({
    logStepTransition: jest.fn(),
    markExit: jest.fn().mockResolvedValue(undefined),
    logMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/addressValidator', () => ({
    validateWithGoogleMaps: jest.fn().mockResolvedValue({ valid: false }),
}));

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const { handleFaq } = require('../src/flows/globals/globalFaq');
const { handleWaitingMapsConfirmation } = require('../src/flows/steps/stepWaitingMapsConfirmation');
const { handleWaitingTransferConfirmation } = require('../src/flows/steps/stepWaitingTransferConfirmation');
const { handleWaitingMpPayment } = require('../src/flows/steps/stepWaitingMpPayment');
const { _startsAffirmative } = require('../src/flows/utils/flowHelpers');
const { _getPrice } = require('../src/flows/utils/pricing');

const PRICE_120 = _getPrice('Cápsulas de nuez de la india', '120');

const KNOWLEDGE = {
    flow: {},
    faq: [
        { keywords: ['cuanto tarda', 'tarda', 'demora el envio'], response: '📦 El envío tarda de 7 a 10 días hábiles por Correo Argentino.' },
        { keywords: ['transferencia', 'alias'], response: '🏦 Para transferir usá el alias HERBALIS.TIENDA a nombre de BIO ORIGEN S.A.S.' },
        { keywords: ['como pago', 'comprobante', 'pago'], response: '💳 Podés pagar con tarjeta de crédito o transferencia.' },
    ],
};

const makeDeps = (over = {}) => {
    const sent = [];
    return {
        sent,
        deps: {
            sendMessageWithDelay: async (_id, m) => { sent.push(m); },
            saveState: jest.fn(),
            notifyAdmin: jest.fn().mockResolvedValue(undefined),
            aiService: { chat: jest.fn().mockResolvedValue({ response: 'AI genérico', goalMet: false }) },
            ...over,
        },
    };
};

const makeMapsState = (over = {}) => ({
    step: 'waiting_maps_confirmation',
    history: [],
    cart: [{ product: 'Cápsulas de nuez de la india', plan: '120', price: PRICE_120 }],
    selectedProduct: 'Cápsulas de nuez de la india',
    selectedPlan: '120',
    price: PRICE_120,
    totalPrice: PRICE_120,
    partialAddress: { calle: 'Quintana y Bolivia', ciudad: 'Ensenada', cp: '1925', nombre: 'Andrea Calderón' },
    summary: '',
    stepEnteredAt: 1000,
    ...over,
});

// ════════════════════════════════════════════════════════════════════════════
// 1. waiting_maps_confirmation — passthrough con señal operativa
// ════════════════════════════════════════════════════════════════════════════
describe('globalFaq — waiting_maps_confirmation', () => {
    test('"Si, es correcta ¿cuánto tarda en llegar?" → responde FAQ y devuelve null', async () => {
        const { sent, deps } = makeDeps();
        const state = makeMapsState();
        const text = 'Si, es correcta ¿cuánto tarda en llegar?';
        const res = await handleFaq('m1@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(res).toBeNull(); // el step debe ver el "sí"
        expect(sent.join(' ')).toMatch(/7 a 10 días/);
    });

    test('"y si tarda mucho?" (condicional) → la FAQ intercepta entera (matched)', async () => {
        const { deps } = makeDeps();
        const state = makeMapsState();
        const text = 'y si tarda mucho?';
        const res = await handleFaq('m2@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(res).toEqual({ matched: true }); // sin señal operativa, no pasa al step
    });

    test('pregunta pura "cuánto tarda en llegar?" → matched (comportamiento previo)', async () => {
        const { deps } = makeDeps();
        const state = makeMapsState();
        const text = 'cuánto tarda en llegar?';
        const res = await handleFaq('m3@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(res).toEqual({ matched: true });
    });

    test('corrección con CP + pregunta: "El cp es 1930, cuánto tarda?" → passthrough', async () => {
        const { sent, deps } = makeDeps();
        const state = makeMapsState();
        const text = 'El cp es 1930, cuánto tarda?';
        const res = await handleFaq('m4@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(res).toBeNull(); // el step re-parsea la corrección
        expect(sent.join(' ')).toMatch(/7 a 10 días/);
    });
});

describe('stepWaitingMapsConfirmation — "sí" afirmativo con cola de pregunta', () => {
    test('E2E: FAQ responde, el step confirma la dirección y arma la orden', async () => {
        const { sent, deps } = makeDeps();
        const state = makeMapsState();
        const text = 'Si, es correcta ¿cuánto tarda en llegar?';

        const faqRes = await handleFaq('m5@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(faqRes).toBeNull();

        const stepRes = await handleWaitingMapsConfirmation('m5@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(stepRes.matched).toBe(true);
        expect(state.pendingOrder).toBeTruthy(); // la orden se armó
        expect(state.pendingOrder.ciudad).toBe('Ensenada');
        expect(deps.notifyAdmin).toHaveBeenCalledWith(
            expect.stringMatching(/BOT PAUSADO/), 'm5@c.us', expect.anything()
        );
        expect(sent.join(' ')).toMatch(/7 a 10 días/); // la pregunta fue respondida
    });

    test('"y si tarda mucho?" directo al step NO confirma la dirección', async () => {
        const { sent, deps } = makeDeps();
        const state = makeMapsState();
        const text = 'y si tarda mucho?';
        const res = await handleWaitingMapsConfirmation('m6@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(res.matched).toBe(true);
        expect(state.pendingOrder).toBeFalsy();
        expect(deps.notifyAdmin).not.toHaveBeenCalled();
        expect(sent.join(' ')).toMatch(/es correcta/i); // re-pregunta el fallback
    });

    test('"Si" solo (anclado) sigue confirmando como siempre', async () => {
        const { deps } = makeDeps();
        const state = makeMapsState();
        const res = await handleWaitingMapsConfirmation('m7@c.us', 'Si', norm('Si'), state, KNOWLEDGE, deps);
        expect(res.matched).toBe(true);
        expect(state.pendingOrder).toBeTruthy();
    });

    test('"Si, pero la calle está mal escrita" NO confirma (va al re-parseo)', async () => {
        const { deps } = makeDeps({
            mockAiService: { parseAddress: async () => ({}) },
        });
        const state = makeMapsState();
        const text = 'Si, pero la calle está mal escrita';
        const res = await handleWaitingMapsConfirmation('m8@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(res.matched).toBe(true);
        expect(state.pendingOrder).toBeFalsy();
        expect(deps.notifyAdmin).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Claims de pago — la FAQ no se traga el aviso (y no re-manda instrucciones)
// ════════════════════════════════════════════════════════════════════════════
describe('globalFaq — claim de pago en waiting_transfer_confirmation / waiting_mp_payment', () => {
    test('"Ya hice la transferencia ¿me confirmás?" → null y SIN respuesta FAQ', async () => {
        const { sent, deps } = makeDeps();
        const state = makeMapsState({ step: 'waiting_transfer_confirmation', paymentMethod: 'transferencia' });
        const text = 'Ya hice la transferencia ¿me confirmás?';
        const res = await handleFaq('p1@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(res).toBeNull();
        expect(sent).toHaveLength(0); // NO re-mandó las instrucciones del alias
    });

    test('pregunta pura "¿me pasás el alias?" sigue respondida por la FAQ', async () => {
        const { sent, deps } = makeDeps();
        const state = makeMapsState({ step: 'waiting_transfer_confirmation', paymentMethod: 'transferencia' });
        const text = '¿me pasás el alias?';
        const res = await handleFaq('p2@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(res).toEqual({ matched: true });
        expect(sent.join(' ')).toMatch(/HERBALIS\.TIENDA/);
    });

    test('"Ya hice el pago ¿me confirmás?" en waiting_mp_payment → null silencioso', async () => {
        const { sent, deps } = makeDeps();
        const state = makeMapsState({ step: 'waiting_mp_payment', mpPaymentLinkUrl: 'https://mp.test/x' });
        const text = 'Ya hice el pago ¿me confirmás?';
        const res = await handleFaq('p3@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(res).toBeNull();
        expect(sent).toHaveLength(0);
    });

    test('"Te mando el comprobante ¿va?" (claim extra) → null silencioso', async () => {
        const { sent, deps } = makeDeps();
        const state = makeMapsState({ step: 'waiting_transfer_confirmation', paymentMethod: 'transferencia' });
        const text = 'Te mando el comprobante ¿va?';
        const res = await handleFaq('p4@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(res).toBeNull();
        expect(sent).toHaveLength(0);
    });
});

describe('steps de pago — el aviso llega al paid-branch tras el skip', () => {
    test('E2E transfer: FAQ skipea y el step responde "recibimos tu aviso" + pausa admin', async () => {
        const { sent, deps } = makeDeps();
        const state = makeMapsState({ step: 'waiting_transfer_confirmation', paymentMethod: 'transferencia' });
        const text = 'Ya hice la transferencia ¿me confirmás?';

        const faqRes = await handleFaq('p5@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(faqRes).toBeNull();

        const stepRes = await handleWaitingTransferConfirmation('p5@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(stepRes.matched).toBe(true);
        // Según haya template transfer_received o no: pide comprobante o avisa
        // que verifica — nunca re-manda las instrucciones del alias.
        expect(sent.join(' ')).toMatch(/comprobante|Recibimos tu aviso/i);
        expect(sent.join(' ')).not.toMatch(/HERBALIS\.TIENDA/); // sin instrucciones repetidas
        expect(deps.notifyAdmin).toHaveBeenCalledWith(
            expect.stringMatching(/BOT PAUSADO/), 'p5@c.us', expect.stringMatching(/transferencia/i)
        );
    });

    test('E2E mp: el paid-branch verifica el pago (pendiente → pide esperar)', async () => {
        const { sent, deps } = makeDeps();
        const state = makeMapsState({
            step: 'waiting_mp_payment',
            mpPaymentLinkUrl: 'https://mp.test/x',
            mpPaymentLinkId: null, // sin registro → _verifyPayment devuelve 'pending'
        });
        const text = 'Ya hice el pago ¿me confirmás?';

        const faqRes = await handleFaq('p6@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(faqRes).toBeNull();

        const stepRes = await handleWaitingMpPayment('p6@c.us', text, norm(text), state, KNOWLEDGE, deps);
        expect(stepRes.matched).toBe(true);
        expect(sent.join(' ')).toMatch(/no veo el pago confirmado/i);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. _startsAffirmative — "sí" afirmativo vs "si" condicional
// ════════════════════════════════════════════════════════════════════════════
describe('_startsAffirmative', () => {
    test.each([
        'Sí',
        'Sí, dale',
        'Si, es correcta ¿cuánto tarda?',
        'si es correcta',
        'Si está bien',
        'dale, ¿cuánto tarda?',
        'claro, mandalo',
        'Perfecto, ¿cuándo llega?',
    ])('afirmativo: %s', (t) => {
        expect(_startsAffirmative(t)).toBe(true);
    });

    test.each([
        'y si tarda mucho?',
        'si tarda mucho no lo quiero',
        'si llega tarde avisame',
        'quiero saber si llega',
        'claro que no',
        '¿Si es correcta?',
        'no, está mal',
        'síntomas raros me da?',
    ])('NO afirmativo: %s', (t) => {
        expect(_startsAffirmative(t)).toBe(false);
    });
});
