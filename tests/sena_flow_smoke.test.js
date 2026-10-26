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

describe('Modelo por zona (sep-2026) — buildPaymentMessage pregunta la localidad', () => {
    const pm = tpl.buildPaymentMessage({ selectedProduct: 'Cápsulas', selectedPlan: '60', totalPrice: '46.900' });

    test('Confirma producto, plan y total, y pregunta de qué localidad es', () => {
        expect(pm).toMatch(/Cápsulas × 60 días/);
        expect(pm).toMatch(/46\.900/);
        expect(pm).toMatch(/de qué localidad sos/i);
    });
    test('NO le pide al cliente que se clasifique ni ofrece retiro/domicilio todavía', () => {
        expect(pm).not.toMatch(/zona de influencia/i);
        expect(pm).not.toMatch(/OPCI[ÓO]N/);
        expect(pm).not.toMatch(/Retiro en sucursal/i);
    });
    test('Ya NO ofrece Mercado Pago / Pago Fácil / Rapipago al cliente (decisión jun-2026)', () => {
        expect(pm).not.toMatch(/mercado\s?pago/i);
        expect(pm).not.toMatch(/rapipago/i);
        expect(pm).not.toMatch(/pago\s?f[áa]cil/i);
    });
    test('NO menciona anticipo de $10.000, adicional de $6.000 ni cuotas', () => {
        expect(pm).not.toMatch(/10\.000/);
        expect(pm).not.toMatch(/anticipo/i);
        expect(pm).not.toMatch(/\$\s*6\.000/);
        expect(pm).not.toMatch(/adicional/i);
        expect(pm).not.toMatch(/cuotas/i);
    });
});

describe('Modelo nuevo — payment_domicilio_choice (submenú prepago tras elegir domicilio)', () => {
    test.each([
        ['V7', v7],
    ])('%s: existe la entry y ofrece Tarjeta de crédito + Transferencia (sin Mercado Pago/Pago Fácil/Rapipago)', (_n, guion) => {
        const choice = guion.flow.payment_domicilio_choice;
        expect(choice).toBeDefined();
        expect(choice.response).toMatch(/Tarjeta de cr[ée]dito/i);
        expect(choice.response).toMatch(/Transferencia bancaria/i);
        expect(choice.response).not.toMatch(/mercado\s?pago/i);
        expect(choice.response).not.toMatch(/rapipago|pago\s?f[áa]cil/i);
    });
});

describe('Modelo por zona — payment_sucursal_choice (retiro en sucursal PREPAGO)', () => {
    test.each([
        ['V7', v7],
    ])('%s: existe la entry, ofrece tarjeta + transferencia y NO habla de efectivo', (_n, guion) => {
        const choice = guion.flow.payment_sucursal_choice;
        expect(choice).toBeDefined();
        expect(choice.response).toMatch(/sucursal/i);
        expect(choice.response).toMatch(/Tarjeta de cr[ée]dito/i);
        expect(choice.response).toMatch(/Transferencia/i);
        expect(choice.response).not.toMatch(/efectivo/i);
        expect(choice.response).not.toMatch(/anticipo/i);
        expect(choice.response).not.toMatch(/10\.000/);
        // El retiro contrarreembolso viejo ya no tiene texto que lo dispare.
        expect(guion.flow.payment_retiro_confirm).toBeUndefined();
    });

    test('zone_in (reparto propio) pide solo nombre y calle, y paga al recibir', () => {
        const z = v7.flow.zone_in.response;
        expect(z).toMatch(/reparto propio/i);
        expect(z).toMatch(/al recibirlo/i);
        expect(z).toMatch(/nombre completo/i);
        expect(z).toMatch(/calle y número/i);
        expect(z).not.toMatch(/c[óo]digo postal|Correo/i);
    });

    test('prepay_refusal_close es el texto del dueño y prepay_objection lo resume en voz de Elena', () => {
        expect(v7.flow.prepay_refusal_close.response).toMatch(/^Desde hace 13 años realizamos envíos por contrarreembolso/);
        expect(v7.flow.prepay_refusal_close.response).toMatch(/Atentamente,\nHerbalis$/);
        expect(v7.flow.prepay_objection.response).toMatch(/13 años/);
        expect(v7.flow.prepay_objection.response).toMatch(/4 días hábiles/);
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
    ])('%s: contraReembolsoMAX senaTransfer=0 (sin anticipo) + spontaneous + appliesTo=zone_in', (_n, guion) => {
        expect(guion.rules.contraReembolsoMAX.senaTransfer).toBe(0);
        expect(guion.rules.contraReembolsoMAX.spontaneous).toBe(true);
        expect(guion.rules.contraReembolsoMAX.appliesTo).toBe('zone_in');
        expect(guion.rules.contraReembolsoMAX.adicional).toBe(0);
    });

    test.each([
        ['V7', v7],
    ])('%s: defaultPaymentMethod = zone_first + bankAlias oficial', (_n, guion) => {
        expect(guion.rules.defaultPaymentMethod).toBe('zone_first');
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
        // Verifica que lidere con el trust signal de cantidad de clientes.
        // Acepta "70.000" o "70 mil" (cifra actual del guion) — la forma
        // conversacional con "mil" es más humana. Si se vuelve a subir el
        // número, actualizar acá.
        expect(estafaFaq.response).toMatch(/70\.000|70 mil/);
        expect(estafaFaq.response).not.toMatch(/riesgo cero/i);
        // No menciona anticipo
        expect(estafaFaq.response).not.toMatch(/anticipo\s+de\s+\$?10/i);
    });

    test.each([
        ['V7', v7],
    ])('%s: FAQ "contra reembolso" lo acota a la zona de reparto propio (Rosario y 60 km)', (_n, guion) => {
        const codFaq = guion.faq.find(f => f.keywords.some(k => k === 'contra reembolso'));
        expect(codFaq).toBeDefined();
        expect(codFaq.response).toMatch(/Rosario/);
        expect(codFaq.response).toMatch(/al recibir/i);
        expect(codFaq.response).toMatch(/Correo Argentino/);
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
    ])('%s: FAQ "shipping" explica las dos zonas: reparto propio y Correo prepago en 4 días', (_n, guion) => {
        const shipFaq = guion.faq.find(f => f.keywords.some(k => k === 'como lo recibo' || k === 'envio'));
        expect(shipFaq).toBeDefined();
        expect(shipFaq.response).toMatch(/4 d[íi]as h[áa]biles/i);
        expect(shipFaq.response).toMatch(/Rosario y hasta 60 km/i);
        expect(shipFaq.response).toMatch(/Correo Argentino/);
        expect(shipFaq.response).not.toMatch(/7 a 10/);
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

describe('Renombre "Tarjeta de crédito" + poda de medios (corrección jun-2026)', () => {
    // De cara al cliente el medio online se llama "Tarjeta de crédito".
    // Ya NO se ofrecen Mercado Pago (como nombre), débito, saldo en app, Pago Fácil ni Rapipago.
    const customerFacingKeys = ['payment_menu', 'payment_domicilio_choice', 'payment_mp_link', 'payment_mp_retry'];

    test.each(customerFacingKeys)('flow.%s no nombra Mercado Pago / Pago Fácil / Rapipago / débito / saldo al cliente', (key) => {
        const resp = v7.flow[key].response;
        expect(resp).toBeDefined();
        expect(resp).not.toMatch(/mercado\s?pago/i);
        expect(resp).not.toMatch(/rapipago/i);
        expect(resp).not.toMatch(/pago\s?f[áa]cil/i);
        expect(resp).not.toMatch(/d[ée]bito/i);
        expect(resp).not.toMatch(/saldo/i);
    });

    test('payment_domicilio_choice ofrece "Tarjeta de crédito" como opción 1', () => {
        expect(v7.flow.payment_domicilio_choice.response).toMatch(/Tarjeta de cr[ée]dito/i);
    });

    test('payment_mp_link dice "tarjeta de crédito" (no "Mercado Pago")', () => {
        expect(v7.flow.payment_mp_link.response).toMatch(/tarjeta de cr[ée]dito/i);
    });

    test('order_confirmation_mp confirma el pago sin nombrar "MercadoPago"', () => {
        const resp = v7.flow.order_confirmation_mp.response;
        expect(resp).not.toMatch(/mercado\s?pago/i);
        expect(resp).toMatch(/tarjeta de cr[ée]dito/i);
    });

    test('FAQ de envío NO asusta con el recargo de $18.000 (se comunica al confirmar, no al preguntar la demora)', () => {
        // Rev. 2026-06-20 (caso 1131381951): el recargo de devolución se sacó de la
        // FAQ de demora (asustaba antes de cualquier compromiso) y se comunica en
        // order_confirmation_cod, ya con el cliente decidido.
        const shipFaq = v7.faq.find(f => f.keywords.some(k => k === 'como lo recibo' || k === 'envio'));
        expect(shipFaq).toBeDefined();
        expect(shipFaq.response).not.toMatch(/18\.000/);
        // El recargo SIGUE comunicándose en la confirmación del pedido (retiro/COD).
        expect(v7.flow.order_confirmation_cod.response).toMatch(/COSTO_LOGISTICO|18\.000/);
    });

    test('INVARIANTE: order_confirmation_* es CIERRE de venta (no pide "sí" ni pregunta de confirmación)', () => {
        // Cambio jun-2026: el bot cierra la venta solo. El mensaje de confirmación ES
        // el cierre — NO debe pedir el OK del cliente ("¿me confirmás?", "¿te confirmo?")
        // porque ya no se espera respuesta. Debe declarar el pedido confirmado.
        for (const key of ['order_confirmation_cod', 'order_confirmation_mp', 'order_confirmation_transfer', 'order_confirmation_fallback']) {
            const resp = v7.flow[key].response;
            expect(resp).not.toMatch(/¿\s*(me\s+confirm|te\s+confirmo|confirm[aá]s)/i); // sin pregunta de confirmación
            expect(resp).toMatch(/en curso|confirmad/i);                                 // declara el pedido en curso/confirmado (cierre asumido estilo Horacio)
        }
    });
});
