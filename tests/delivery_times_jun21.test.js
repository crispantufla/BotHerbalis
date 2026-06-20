/**
 * Demoras diferenciadas (jun-2026): envío a domicilio PREPAGO despacha más rápido
 * (6 a 7 días hábiles); retiro en sucursal (paga al retirar) sigue 7 a 10.
 * Cubre el branch _isRetiro de _formatMessage ({{POSTDATADO_LINE}}).
 */
const { _formatMessage } = require('../src/flows/utils/messages');

const TPL = 'Producto: {{PRODUCT_DETAIL}}\n{{POSTDATADO_LINE}}fin';

describe('_formatMessage — plazo de entrega según tipo de envío', () => {
    test('domicilio prepago (MP) → 6 a 7 días hábiles', () => {
        const out = _formatMessage(TPL, { shippingChoice: 'domicilio', paymentMethod: 'mercadopago', selectedProduct: 'Cápsulas', selectedPlan: '60' });
        expect(out).toMatch(/6 a 7 días/);
        expect(out).not.toMatch(/7 a 10 días/);
    });

    test('domicilio prepago (transferencia) → 6 a 7 días hábiles', () => {
        const out = _formatMessage(TPL, { shippingChoice: 'domicilio', paymentMethod: 'transferencia', selectedProduct: 'Gotas', selectedPlan: '120' });
        expect(out).toMatch(/6 a 7 días/);
    });

    test('retiro en sucursal (contrarembolso) → 7 a 10 días hábiles', () => {
        const out = _formatMessage(TPL, { shippingChoice: 'retiro', paymentMethod: 'contrarembolso', selectedProduct: 'Cápsulas', selectedPlan: '60' });
        expect(out).toMatch(/7 a 10 días/);
        expect(out).not.toMatch(/6 a 7 días/);
    });

    test('postdatado tiene prioridad sobre el plazo', () => {
        const out = _formatMessage(TPL, { shippingChoice: 'domicilio', paymentMethod: 'mercadopago', postdatado: '2026-07-05' });
        expect(out).toMatch(/2026-07-05/);
    });
});
