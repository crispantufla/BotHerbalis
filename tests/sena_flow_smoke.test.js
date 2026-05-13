/**
 * Smoke test para la política de pago vigente (mayo 2026):
 * - Se ofrecen 3 opciones espontáneamente: MP, Transferencia, Contra reembolso
 * - Alias oficial: ERRONEA.HABLAME.LUZ a nombre de Bio Origen SAS
 * - Contra reembolso: anticipo $10.000 por transferencia al alias + saldo en efectivo al cartero
 * - Ya no hay adicional de $6.000 ni descuento de prepago
 */

const path = require('path');
const fs = require('fs');

const tpl = require('../src/utils/messageTemplates');

const v5 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v5.json'), 'utf8'));
const v6 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v6.json'), 'utf8'));

describe('Política nueva de pago — buildPaymentMessage (3 opciones espontáneas)', () => {
    const pm = tpl.buildPaymentMessage({ selectedPlan: '60', totalPrice: '46.900' });

    test('Menciona Mercado Pago (opción 1)', () => {
        expect(pm).toMatch(/Mercado Pago/);
    });
    test('Menciona Transferencia bancaria (opción 2)', () => {
        expect(pm).toMatch(/Transferencia bancaria/i);
    });
    test('Menciona Contra reembolso con anticipo de $10.000 (opción 3)', () => {
        expect(pm).toMatch(/Contra reembolso/i);
        expect(pm).toMatch(/10\.000/);
    });
    test('NO menciona adicional de $6.000', () => {
        expect(pm).not.toMatch(/\$\s*6\.000/);
        expect(pm).not.toMatch(/adicional/i);
    });
    test('NO menciona Pago Fácil / Rapipago', () => {
        expect(pm).not.toMatch(/Pago Fácil/i);
        expect(pm).not.toMatch(/Rapipago/i);
    });
    test('Menciona cuotas (sub-opción tarjeta crédito por MP)', () => {
        expect(pm).toMatch(/cuotas/i);
    });
});

describe('Política nueva — buildCashRetryMessage (anticipo $10k al alias)', () => {
    const cr = tpl.buildCashRetryMessage({});

    test('Explica la modalidad de anticipo por $10.000', () => {
        expect(cr).toMatch(/anticipo/i);
        expect(cr).toMatch(/10\.000/);
    });
    test('Menciona que el saldo se paga en efectivo al cartero', () => {
        expect(cr).toMatch(/efectivo al cartero/i);
    });
    test('Menciona el alias oficial ERRONEA.HABLAME.LUZ y titular Bio Origen SAS', () => {
        expect(cr).toMatch(/ERRONEA\.HABLAME\.LUZ/);
        expect(cr).toMatch(/Bio Origen SAS/);
    });
    test('NO promociona COD como "lo más cómodo/seguro"', () => {
        expect(cr).not.toMatch(/cómoda?\s+y\s+segura/i);
        expect(cr).not.toMatch(/lo más cómodo/i);
    });
    test('NO menciona Mercado Pago como vehículo del anticipo (ahora va por alias)', () => {
        // El mensaje sí ofrece MP como alternativa por el total, pero el anticipo va por transferencia.
        expect(cr).toMatch(/transferencia/i);
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
    ])('%s: contraReembolsoMAX anticipo $10.000 espontáneo + aplica a todos', (_n, guion) => {
        expect(guion.rules.contraReembolsoMAX.senaTransfer).toBe(10000);
        expect(guion.rules.contraReembolsoMAX.spontaneous).toBe(true);
        expect(guion.rules.contraReembolsoMAX.appliesTo).toBe('all');
        expect(guion.rules.contraReembolsoMAX.adicional).toBe(0);
    });

    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: defaultPaymentMethod = three_options + bankAlias oficial', (_n, guion) => {
        expect(guion.rules.defaultPaymentMethod).toBe('three_options');
        expect(guion.rules.bankAlias.alias).toBe('ERRONEA.HABLAME.LUZ');
        expect(guion.rules.bankAlias.titular).toBe('Bio Origen SAS');
    });
});

describe('Política nueva — FAQ en V5 y V6', () => {
    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: FAQ "estafa" sigue liderando con trust signals', (_n, guion) => {
        const estafaFaq = guion.faq.find(f => f.keywords.some(k => k === 'estafa'));
        expect(estafaFaq).toBeDefined();
        expect(estafaFaq.response).toMatch(/13 años/i);
        expect(estafaFaq.response).toMatch(/50\.000/);
        expect(estafaFaq.response).not.toMatch(/riesgo cero/i);
        // Si menciona COD, debe ser con el anticipo $10k
        if (/pago al recibir|contra.?reembolso/i.test(estafaFaq.response)) {
            expect(estafaFaq.response).toMatch(/10\.000/);
        }
    });

    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: FAQ "contra reembolso" explica anticipo $10k por transferencia al alias', (_n, guion) => {
        const codFaq = guion.faq.find(f => f.keywords.some(k => k === 'contra reembolso'));
        expect(codFaq).toBeDefined();
        expect(codFaq.response).toMatch(/anticipo/i);
        expect(codFaq.response).toMatch(/10\.000/);
        expect(codFaq.response).toMatch(/ERRONEA\.HABLAME\.LUZ/);
        expect(codFaq.response).toMatch(/Bio Origen SAS/);
    });

    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: FAQ "transferencia" expone el alias oficial', (_n, guion) => {
        const trfFaq = guion.faq.find(f => f.keywords.some(k => k === 'transferencia'));
        expect(trfFaq).toBeDefined();
        expect(trfFaq.response).toMatch(/ERRONEA\.HABLAME\.LUZ/);
        expect(trfFaq.response).toMatch(/Bio Origen SAS/);
    });

    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: ningún mensaje en flow/faq promete descuento de $6.000', (_n, guion) => {
        const allText = JSON.stringify(guion.flow) + JSON.stringify(guion.faq);
        expect(allText).not.toMatch(/descuento de \$\s*6\.000/i);
        expect(allText).not.toMatch(/te bajo \$\s*6\.000/i);
        expect(allText).not.toMatch(/te ahorrás \$\s*6\.000/i);
    });
});

describe('Política nueva — recommendations (TEXTO 1+2 → "¿Te paso los precios?")', () => {
    test.each([
        ['V5', v5],
        ['V6', v6],
    ])('%s: recommendation_1/2/3 terminan pidiendo aceptación para mostrar precios', (_n, guion) => {
        ['recommendation_1', 'recommendation_2', 'recommendation_3'].forEach(key => {
            const resp = guion.flow[key].response;
            // No incluyen el precio ni el menú de pago (eso ahora vive en TEXTO 3/4)
            expect(resp).not.toMatch(/\{\{PRICE_/);
            expect(resp).not.toMatch(/\$\s*\d{2,}\.\d{3}/);
            // Termina invitando a ver precios
            expect(resp).toMatch(/precios/i);
            // No promete incentivos viejos
            expect(resp).not.toMatch(/te bajo \$\s*6\.000/i);
            expect(resp).not.toMatch(/unidad extra de regalo/i);
        });
    });
});
