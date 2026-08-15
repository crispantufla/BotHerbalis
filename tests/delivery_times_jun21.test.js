/**
 * Plazo de entrega en {{POSTDATADO_LINE}}.
 *
 * En el bot argentino este test cubría DOS plazos distintos según la modalidad
 * (domicilio prepago 4 días vs retiro en sucursal 7-10), porque pagar antes
 * adelantaba el despacho. Aquí todo es contra reembolso y las dos modalidades
 * salen por Correos igual, así que el plazo es UNO SOLO: el que anuncia
 * MARKET.deliveryDaysHome. Que no dependa de shippingChoice es justamente lo
 * que hay que proteger — si vuelve a bifurcarse, es que alguien reintrodujo un
 * plazo que el negocio no cumple.
 */
const { _formatMessage } = require('../src/flows/utils/messages');
const { MARKET } = require('../src/config/market');

const TPL = 'Producto: {{PRODUCT_DETAIL}}\n{{POSTDATADO_LINE}}fin';

describe('_formatMessage — plazo de entrega', () => {
    test('envío a casa → anuncia el plazo único del mercado', () => {
        const out = _formatMessage(TPL, { shippingChoice: 'domicilio', paymentMethod: 'contrarembolso', selectedProduct: 'Cápsulas', selectedPlan: '60' });
        expect(out).toContain(MARKET.deliveryDaysHome);
    });

    test('recogida en oficina → el MISMO plazo (no hay ventaja por modalidad)', () => {
        const out = _formatMessage(TPL, { shippingChoice: 'retiro', paymentMethod: 'contrarembolso', selectedProduct: 'Gotas', selectedPlan: '120' });
        expect(out).toContain(MARKET.deliveryDaysHome);
    });

    test('el plazo NO depende de la modalidad de entrega', () => {
        const casa = _formatMessage(TPL, { shippingChoice: 'domicilio', paymentMethod: 'contrarembolso', selectedProduct: 'Cápsulas', selectedPlan: '60' });
        const oficina = _formatMessage(TPL, { shippingChoice: 'retiro', paymentMethod: 'contrarembolso', selectedProduct: 'Cápsulas', selectedPlan: '60' });
        expect(casa).toBe(oficina);
    });

    test('el envío programado tiene prioridad sobre el plazo', () => {
        const out = _formatMessage(TPL, { shippingChoice: 'domicilio', paymentMethod: 'contrarembolso', postdatado: '2026-07-05' });
        expect(out).toMatch(/2026-07-05/);
        expect(out).not.toContain(MARKET.deliveryDaysHome);
    });
});
