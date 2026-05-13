/**
 * Smoke test para la nueva política de pago (mayo 2026):
 * - MP es la única opción ofrecida espontáneamente
 * - Contra reembolso requiere seña de $10.000 por MP
 * - Ya no hay adicional de $6.000
 * - Ya no hay descuento de prepago
 */

const path = require('path');
const fs = require('fs');

// Cargar prices.json con adicionalMAX = 0
const tpl = require('../src/utils/messageTemplates');

const v5 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v5.json'), 'utf8'));
const v6 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v6.json'), 'utf8'));

describe('Política nueva de pago — buildPaymentMessage (MP-only)', () => {
    const pm = tpl.buildPaymentMessage({ selectedPlan: '60', totalPrice: '46.900' });

    test('Menciona Mercado Pago como método único', () => {
        expect(pm).toMatch(/Mercado Pago/);
    });
    test('NO incluye menu de Transferencia bancaria', () => {
        expect(pm).not.toMatch(/Transferencia bancaria/i);
    });
    test('NO incluye menu de Contra reembolso', () => {
        expect(pm).not.toMatch(/Contra reembolso/i);
    });
    test('NO menciona adicional de $6.000', () => {
        expect(pm).not.toMatch(/\$\s*6\.000/);
        expect(pm).not.toMatch(/adicional/i);
    });
    test('NO menciona Pago Fácil / Rapipago (eliminado de la oferta)', () => {
        expect(pm).not.toMatch(/Pago Fácil/i);
        expect(pm).not.toMatch(/Rapipago/i);
    });
    test('Menciona cuotas (sub-opción tarjeta crédito en MP)', () => {
        expect(pm).toMatch(/cuotas/i);
    });
    test('Menciona débito y saldo MP', () => {
        expect(pm).toMatch(/débito/i);
        expect(pm).toMatch(/Saldo Mercado Pago/i);
    });
});

describe('Política nueva de pago — buildCashRetryMessage (seña $10k)', () => {
    const cr = tpl.buildCashRetryMessage({});

    test('Explica la modalidad de seña por $10.000', () => {
        expect(cr).toMatch(/seña/i);
        expect(cr).toMatch(/10\.000/);
    });
    test('Menciona que el saldo se paga en efectivo al cartero', () => {
        expect(cr).toMatch(/efectivo al cartero/i);
    });
    test('NO promociona COD como "lo más cómodo/seguro"', () => {
        expect(cr).not.toMatch(/cómoda?\s+y\s+segura/i);
        expect(cr).not.toMatch(/lo más cómodo/i);
    });
});

describe('Política nueva — rules en V5 y V6', () => {
    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: prepayIncentive desactivado', (_n, guion) => {
        expect(guion.rules.prepayIncentive.enabled).toBe(false);
    });

    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: contraReembolsoMAX seña $10.000 + no espontáneo + aplica a todos', (_n, guion) => {
        expect(guion.rules.contraReembolsoMAX.senaMP).toBe(10000);
        expect(guion.rules.contraReembolsoMAX.spontaneous).toBe(false);
        expect(guion.rules.contraReembolsoMAX.appliesTo).toBe('all');
        expect(guion.rules.contraReembolsoMAX.adicional).toBe(0);
    });

    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: defaultPaymentMethod = mercadopago_link', (_n, guion) => {
        expect(guion.rules.defaultPaymentMethod).toBe('mercadopago_link');
    });
});

describe('Política nueva — FAQ en V5 y V6 sin promoción de COD', () => {
    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: FAQ "estafa" no promociona COD como solución de confianza', (_n, guion) => {
        const estafaFaq = guion.faq.find(f => f.keywords.some(k => k === 'estafa'));
        expect(estafaFaq).toBeDefined();
        expect(estafaFaq.response).toMatch(/13 años/i);
        expect(estafaFaq.response).toMatch(/50\.000/);
        // No debe vender COD como "riesgo cero"
        expect(estafaFaq.response).not.toMatch(/riesgo cero/i);
        // Si menciona COD, debe ser con la seña
        if (/pago al recibir|contra.?reembolso/i.test(estafaFaq.response)) {
            expect(estafaFaq.response).toMatch(/10\.000/);
        }
    });

    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: FAQ "contra reembolso" explica seña $10k', (_n, guion) => {
        const codFaq = guion.faq.find(f => f.keywords.some(k => k === 'contra reembolso'));
        expect(codFaq).toBeDefined();
        expect(codFaq.response).toMatch(/seña/i);
        expect(codFaq.response).toMatch(/10\.000/);
        expect(codFaq._note).toMatch(/SOLO se ofrece si el cliente lo pide|solo se ofrece si el cliente lo pide/);
    });

    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: ningun mensaje en flow/faq promete descuento de $6.000', (_n, guion) => {
        const allText = JSON.stringify(guion.flow) + JSON.stringify(guion.faq);
        expect(allText).not.toMatch(/descuento de \$\s*6\.000/i);
        expect(allText).not.toMatch(/te bajo \$\s*6\.000/i);
        expect(allText).not.toMatch(/te ahorrás \$\s*6\.000/i);
    });
});

describe('Política nueva — recommendations push MP', () => {
    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: recommendation_1/2/3 mencionan Mercado Pago', (_n, guion) => {
        ['recommendation_1', 'recommendation_2', 'recommendation_3'].forEach(key => {
            expect(guion.flow[key].response).toMatch(/Mercado Pago/i);
            // No prometen descuento $6k ni unidad extra como incentivo
            expect(guion.flow[key].response).not.toMatch(/te bajo \$\s*6\.000/i);
            expect(guion.flow[key].response).not.toMatch(/unidad extra de regalo/i);
        });
    });
});
