// Guion por zona (V8) revertido el 2026-09-28: los clientes que quedaron a mitad
// de ese guion vuelven al menú de retiro/domicilio en vez de pausarse o seguir
// un camino que el guion actual no tiene.
// _setStep registra la transición en el embudo (DB de prod): mockeado.
jest.mock('../src/services/funnelLogger');

const { processStep } = require('../src/flows/steps');

const deps = () => ({ saveState: jest.fn() });

describe('estados del guion por zona tras el revert', () => {
    test('waiting_zone → waiting_payment_method', async () => {
        const state = { step: 'waiting_zone', history: [] };
        const d = deps();
        const r = await processStep('5493410000000@c.us', 'funes', 'funes', state, {}, d);
        expect(r).toEqual({ matched: false, staleReprocess: true });
        expect(state.step).toBe('waiting_payment_method');
        expect(d.saveState).toHaveBeenCalled();
    });

    test('reparto propio en datos → vuelve al menú de pago, sin la elección vieja', async () => {
        const state = { step: 'waiting_data', shippingChoice: 'reparto', paymentMethod: 'contrarembolso', deliveryZone: 'in', history: [] };
        const r = await processStep('5493410000000@c.us', 'juan perez', 'juan perez', state, {}, deps());
        expect(r).toEqual({ matched: false, staleReprocess: true });
        expect(state.step).toBe('waiting_payment_method');
        expect(state.shippingChoice).toBeNull();
        expect(state.paymentMethod).toBeNull();
        expect(state.deliveryZone).toBeNull();
    });
});
