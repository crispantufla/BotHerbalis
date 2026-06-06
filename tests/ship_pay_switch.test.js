/**
 * Cambio de idea sobre envío/pago en steps posteriores (jun-2026).
 *
 * Raíz común de varios bugs de may/jun-2026: el cliente que YA pasó por
 * waiting_payment_method cambia de idea (envío o medio) en waiting_data /
 * waiting_final_confirmation, donde antes NO se detectaba → caía a IA/parser.
 *
 * Estrategia: detección ESTRICTA (marker-gated, no se dispara con direcciones) +
 * reroute a waiting_payment_method (única fuente de verdad que aplica la elección).
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../db', () => ({
    prisma: {
        user: { upsert: jest.fn().mockResolvedValue({}) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    },
}));

const { _detectShipPaySwitch, _handleShipPaySwitch } = require('../src/flows/utils/flowHelpers');

describe('_detectShipPaySwitch — detección estricta de cambio de envío/pago', () => {
    test('cambio a RETIRO (estaba domicilio)', () => {
        expect(_detectShipPaySwitch('mejor lo retiro en sucursal', { shippingChoice: 'domicilio' }))
            .toEqual({ shipping: 'retiro' });
    });
    test('cambio a DOMICILIO (estaba retiro)', () => {
        expect(_detectShipPaySwitch('mejor mandalo a domicilio', { shippingChoice: 'retiro' }))
            .toEqual({ shipping: 'domicilio' });
    });
    test('cambio de medio a TARJETA (estaba transferencia)', () => {
        expect(_detectShipPaySwitch('mejor pago con tarjeta', { shippingChoice: 'domicilio', paymentMethod: 'transferencia' }))
            .toEqual({ payment: 'mercadopago' });
    });
    test('cambio de medio a TRANSFERENCIA (estaba mercadopago)', () => {
        expect(_detectShipPaySwitch('prefiero por transferencia', { shippingChoice: 'domicilio', paymentMethod: 'mercadopago' }))
            .toEqual({ payment: 'transferencia' });
    });

    // ── Falsos positivos: NO debe dispararse (clave para no romper waiting_data) ──
    test('dirección normal SIN marcador → null', () => {
        expect(_detectShipPaySwitch('juan perez, av domicilio 123, rosario, 2000', { shippingChoice: 'domicilio' }))
            .toBeNull();
    });
    test('menciona "domicilio" sin marcador de cambio → null', () => {
        expect(_detectShipPaySwitch('lo recibo en mi domicilio', { shippingChoice: 'domicilio' }))
            .toBeNull();
    });
    test('marcador + retiro PERO ya estaba en retiro → null (no es cambio)', () => {
        expect(_detectShipPaySwitch('mejor lo retiro yo', { shippingChoice: 'retiro' }))
            .toBeNull();
    });
    test('confirmación afirmativa simple → null', () => {
        expect(_detectShipPaySwitch('si dale perfecto', { shippingChoice: 'domicilio' }))
            .toBeNull();
    });
});

describe('_handleShipPaySwitch — reroute a waiting_payment_method', () => {
    test('switch detectado → resetea flags acoplados, set step y staleReprocess', () => {
        const state = {
            step: 'waiting_data', shippingChoice: 'retiro', paymentMethod: 'contrarembolso',
            paymentSubChoiceAsked: false, partialAddress: { calle: 'A sucursal', ciudad: 'Rosario' },
        };
        const deps = { saveState: jest.fn() };
        const r = _handleShipPaySwitch('u@c.us', 'mejor mandalo a domicilio', state, deps);
        expect(r).toEqual({ matched: false, staleReprocess: true });
        expect(state.step).toBe('waiting_payment_method');
        expect(state.shippingChoice).toBeNull();
        expect(state.paymentMethod).toBeNull();
        expect(state.partialAddress.calle).toBeUndefined(); // limpia el "A sucursal" del retiro
        expect(deps.saveState).toHaveBeenCalledWith('u@c.us');
    });

    test('sin cambio (dirección normal) → null y NO toca el estado', () => {
        const state = { step: 'waiting_data', shippingChoice: 'domicilio', paymentMethod: 'mercadopago' };
        const deps = { saveState: jest.fn() };
        const r = _handleShipPaySwitch('u@c.us', 'juan perez calle falsa 123 rosario', state, deps);
        expect(r).toBeNull();
        expect(state.step).toBe('waiting_data');
        expect(deps.saveState).not.toHaveBeenCalled();
    });
});
