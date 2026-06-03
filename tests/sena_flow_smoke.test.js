/**
 * Smoke test para el modelo de pago vigente (may-2026 rev 2):
 * - Menú de envío 2-opciones: retiro en sucursal vs envío a domicilio
 * - Retiro en sucursal → contrarrembolso, paga total en efectivo al retirar (sin anticipo)
 * - Envío a domicilio → prepago por Mercado Pago o transferencia (alias HERBALIS.TIENDA)
 * - 7 a 10 días hábiles uniforme
 * - Sin adicional $6.000, sin anticipo $10.000, sin cuotas
 *
 * Nombre del archivo conservado por historia git (originalmente testeaba el flujo seña).
 */

const path = require('path');
const fs = require('fs');

const tpl = require('../src/utils/messageTemplates');

// V5/V6 archivados en may-2026; V7 es el único guion activo.
const v7 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v7.json'), 'utf8'));

describe('Modelo nuevo de pago — buildPaymentMessage (envío primero, sin anticipo)', () => {
    const pm = tpl.buildPaymentMessage({ selectedPlan: '60', totalPrice: '46.900' });

    test('Pregunta tipo de envío: retiro en sucursal vs envío a domicilio', () => {
        expect(pm).toMatch(/Retiro en sucursal/i);
        expect(pm).toMatch(/Env[íi]o a domicilio/i);
    });
    test('Vincula el retiro con pago al retirar (en efectivo)', () => {
        expect(pm).toMatch(/al retirar/i);
        expect(pm).toMatch(/efectivo/i);
    });
    test('Lista medios de pago para domicilio (MercadoPago, Transferencia)', () => {
        expect(pm).toMatch(/MercadoPago/i);
        expect(pm).toMatch(/Transferencia/i);
    });
    test('Menciona canales de MP (Rapipago, PagoFácil, Tarjeta)', () => {
        expect(pm).toMatch(/Rapipago/i);
        expect(pm).toMatch(/PagoF[áa]cil/i);
        expect(pm).toMatch(/Tarjeta/i);
    });
    test('Promete envío gratis y 7 a 10 días hábiles', () => {
        expect(pm).toMatch(/GRATIS/i);
        expect(pm).toMatch(/7 y 10 d[íi]as/i);
    });
    test('NO menciona anticipo de $10.000 (modalidad eliminada)', () => {
        expect(pm).not.toMatch(/10\.000/);
        expect(pm).not.toMatch(/anticipo/i);
    });
    test('NO menciona adicional de $6.000', () => {
        expect(pm).not.toMatch(/\$\s*6\.000/);
        expect(pm).not.toMatch(/adicional/i);
    });
    test('NO menciona cuotas', () => {
        expect(pm).not.toMatch(/cuotas/i);
    });
});

describe('Modelo nuevo — payment_domicilio_choice (submenú prepago tras elegir domicilio)', () => {
    test.each([
        ['V7', v7],
    ])('%s: existe la entry y ofrece MP + Transferencia', (_n, guion) => {
        const choice = guion.flow.payment_domicilio_choice;
        expect(choice).toBeDefined();
        expect(choice.response).toMatch(/Mercado Pago/i);
        expect(choice.response).toMatch(/Transferencia bancaria/i);
    });
});

describe('Modelo nuevo — payment_retiro_confirm (confirmación tras elegir retiro)', () => {
    test.each([
        ['V7', v7],
    ])('%s: existe la entry y aclara "total en efectivo al retirar"', (_n, guion) => {
        const confirm = guion.flow.payment_retiro_confirm;
        expect(confirm).toBeDefined();
        expect(confirm.response).toMatch(/sucursal/i);
        expect(confirm.response).toMatch(/efectivo/i);
        // No menciona anticipo
        expect(confirm.response).not.toMatch(/anticipo/i);
        expect(confirm.response).not.toMatch(/10\.000/);
    });
});

describe('Modelo nuevo — rules en V5 y V6', () => {
    test.each([
        ['V7', v7],
    ])('%s: prepayIncentive desactivado', (_n, guion) => {
        expect(guion.rules.prepayIncentive.enabled).toBe(false);
    });

    test.each([
        ['V7', v7],
    ])('%s: contraReembolsoMAX senaTransfer=0 (sin anticipo) + spontaneous + appliesTo=all', (_n, guion) => {
        expect(guion.rules.contraReembolsoMAX.senaTransfer).toBe(0);
        expect(guion.rules.contraReembolsoMAX.spontaneous).toBe(true);
        expect(guion.rules.contraReembolsoMAX.appliesTo).toBe('all');
        expect(guion.rules.contraReembolsoMAX.adicional).toBe(0);
    });

    test.each([
        ['V7', v7],
    ])('%s: defaultPaymentMethod = shipping_first + bankAlias oficial', (_n, guion) => {
        expect(guion.rules.defaultPaymentMethod).toBe('shipping_first');
        expect(guion.rules.bankAlias.alias).toBe('HERBALIS.TIENDA');
        expect(guion.rules.bankAlias.titular).toBe('BIO ORIGEN S.A.S.');
    });
});

describe('Modelo nuevo — FAQ en V5 y V6', () => {
    test.each([
        ['V7', v7],
    ])('%s: FAQ "estafa" sigue liderando con trust signals + ofrece retiro como risk reversal', (_n, guion) => {
        const estafaFaq = guion.faq.find(f => f.keywords.some(k => k === 'estafa'));
        expect(estafaFaq).toBeDefined();
        expect(estafaFaq.response).toMatch(/13 años/i);
        // Acepta "50.000" o "50 mil" — la forma conversacional es más humana.
        expect(estafaFaq.response).toMatch(/50\.000|50 mil/);
        expect(estafaFaq.response).not.toMatch(/riesgo cero/i);
        // No menciona anticipo
        expect(estafaFaq.response).not.toMatch(/anticipo\s+de\s+\$?10/i);
    });

    test.each([
        ['V7', v7],
    ])('%s: FAQ "contra reembolso" describe retiro en sucursal (sin anticipo)', (_n, guion) => {
        const codFaq = guion.faq.find(f => f.keywords.some(k => k === 'contra reembolso'));
        expect(codFaq).toBeDefined();
        expect(codFaq.response).toMatch(/sucursal/i);
        expect(codFaq.response).toMatch(/efectivo/i);
        // No menciona anticipo ni $10.000
        expect(codFaq.response).not.toMatch(/anticipo/i);
        expect(codFaq.response).not.toMatch(/10\.000/);
    });

    test.each([
        ['V7', v7],
    ])('%s: FAQ "transferencia" expone el alias oficial', (_n, guion) => {
        const trfFaq = guion.faq.find(f => f.keywords.some(k => k === 'transferencia'));
        expect(trfFaq).toBeDefined();
        expect(trfFaq.response).toMatch(/HERBALIS\.TIENDA/);
        expect(trfFaq.response).toMatch(/BIO ORIGEN S.A.S./);
    });

    test.each([
        ['V7', v7],
    ])('%s: FAQ "shipping" unifica 7 a 10 días hábiles + menciona ambas opciones de envío', (_n, guion) => {
        const shipFaq = guion.faq.find(f => f.keywords.some(k => k === 'como lo recibo' || k === 'envio'));
        expect(shipFaq).toBeDefined();
        expect(shipFaq.response).toMatch(/7 a 10 d[íi]as/i);
        expect(shipFaq.response).toMatch(/Retiro en sucursal/i);
        expect(shipFaq.response).toMatch(/Env[íi]o a domicilio/i);
        // No menciona el viejo split 4-6 / 7-10 hábiles ni el viejo 5 a 7
        expect(shipFaq.response).not.toMatch(/4 a 6/);
        expect(shipFaq.response).not.toMatch(/5 a 7/);
    });

    test.each([
        ['V7', v7],
    ])('%s: ningún mensaje en flow/faq promete descuento de $6.000', (_n, guion) => {
        const allText = JSON.stringify(guion.flow) + JSON.stringify(guion.faq);
        expect(allText).not.toMatch(/descuento de \$\s*6\.000/i);
        expect(allText).not.toMatch(/te bajo \$\s*6\.000/i);
        expect(allText).not.toMatch(/te ahorrás \$\s*6\.000/i);
    });
});

describe('V7 — recommendations no filtran precios; los precios van en prices_60/_120', () => {
    // V7: recommendation_1/2 (sólo 2 tiers, no hay rec_3) ofrecen las 3 opciones
    // de producto (livianas — el instructivo de la semilla se movió a
    // preference_semillas). NOTA (2026-06-03): prices_60/_120/_both ya NO se
    // auto-envían tras la recomendación (se mandaba la grilla de 3 precios sin que
    // el cliente eligiera). Ahora el precio llega en preference_X al elegir la
    // presentación. Estos nodos quedan en el JSON como referencia y se siguen
    // validando estructuralmente.
    test('recommendation_1 y _2 no filtran precios', () => {
        ['recommendation_1', 'recommendation_2'].forEach(key => {
            const resp = v7.flow[key].response;
            expect(resp).not.toMatch(/\{\{PRICE_/);
            expect(resp).not.toMatch(/\$\s*\d{2,}\.\d{3}/);
            expect(resp).not.toMatch(/te bajo \$\s*6\.000/i);
            expect(resp).not.toMatch(/unidad extra de regalo/i);
        });
    });

    test('prices_60 y prices_120 muestran las 3 opciones con placeholders + pregunta de avance', () => {
        ['prices_60', 'prices_120'].forEach(key => {
            const resp = v7.flow[key].response;
            expect(resp).toMatch(/\{\{PRICE_/);
            expect(resp).toMatch(/con cu[aá]l quer[eé]s arrancar/i);
        });
    });

    test('V7 NO tiene recommendation_3 (sólo 2 tiers)', () => {
        expect(v7.flow.recommendation_3).toBeUndefined();
    });
});

describe('_formatMessage — defensa contra placeholder leak (regresión Silvina 14/05)', () => {
    const { _formatMessage } = require('../src/flows/utils/messages');

    test('Sin selectedProduct, sustituye {{PRICE_60}}/{{PRICE_120}} con default Cápsulas', () => {
        const txt = 'Plan 2 meses: ${{PRICE_60}} — Plan 4 meses: ${{PRICE_120}}';
        const out = _formatMessage(txt, { /* sin selectedProduct */ });
        expect(out).not.toMatch(/\{\{PRICE_60\}\}/);
        expect(out).not.toMatch(/\{\{PRICE_120\}\}/);
        expect(out).toMatch(/\$\d+\.\d{3}/);
    });

    test('Sweep final: si queda un placeholder desconocido, se elimina (no se manda al cliente)', () => {
        const txt = 'Hola {{UNKNOWN_PLACEHOLDER}} mundo';
        const out = _formatMessage(txt, {});
        expect(out).not.toMatch(/\{\{/);
        expect(out).toBe('Hola  mundo');
    });

    test('{{ALIAS}} y {{TITULAR}} siempre se sustituyen con constantes', () => {
        const txt = 'alias {{ALIAS}} titular {{TITULAR}}';
        const out = _formatMessage(txt, null);
        expect(out).toMatch(/HERBALIS\.TIENDA/);
        expect(out).toMatch(/BIO ORIGEN S\.A\.S\./);
    });
});
