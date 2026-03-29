"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports._formatMessage = _formatMessage;
exports._isDuplicate = _isDuplicate;
exports._getAdminSuggestions = _getAdminSuggestions;
exports._getQuickReplies = _getQuickReplies;
const pricing_1 = require("./pricing");
const cartHelpers_1 = require("./cartHelpers");
function _formatMessage(text, state) {
    if (!text)
        return "";
    // Si es un array de respuestas, elige una al azar para dar variabilidad
    let textToFormat = Array.isArray(text) ? text[Math.floor(Math.random() * text.length)] : text;
    const prices = (0, pricing_1._getPrices)();
    let formatted = textToFormat;
    // Replace {{PRICE_PRODUCT_PLAN}}
    formatted = formatted.replace(/{{PRICE_CAPSULAS_60}}/g, prices['Cápsulas']?.['60'] || '');
    formatted = formatted.replace(/{{PRICE_CAPSULAS_120}}/g, prices['Cápsulas']?.['120'] || '');
    formatted = formatted.replace(/{{PRICE_SEMILLAS_60}}/g, prices['Semillas']?.['60'] || '');
    formatted = formatted.replace(/{{PRICE_SEMILLAS_120}}/g, prices['Semillas']?.['120'] || '');
    formatted = formatted.replace(/{{PRICE_GOTAS_60}}/g, prices['Gotas']?.['60'] || '');
    formatted = formatted.replace(/{{PRICE_GOTAS_120}}/g, prices['Gotas']?.['120'] || '');
    formatted = formatted.replace(/{{ADICIONAL_MAX}}/g, prices.adicionalMAX || '6.000');
    formatted = formatted.replace(/{{COSTO_LOGISTICO}}/g, prices.costoLogistico || '18.000');
    // Replace dynamic order placeholders if state is provided
    if (state) {
        if (state.selectedProduct) {
            formatted = formatted.replace(/{{PRODUCT}}/g, state.selectedProduct);
        }
        if (state.selectedPlan) {
            formatted = formatted.replace(/{{PLAN}}/g, state.selectedPlan);
        }
        if (state.totalPrice) {
            let displayPrice = state.totalPrice;
            // If Contra Reembolso MAX, show breakdown
            if (state.isContraReembolsoMAX && state.adicionalMAX > 0) {
                const basePriceInt = Math.max(0, parseInt(String(state.totalPrice).replace(/\./g, '')) - state.adicionalMAX);
                const basePrice = (0, cartHelpers_1._formatPrice)(basePriceInt);
                const adicional = (0, cartHelpers_1._formatPrice)(state.adicionalMAX);
                displayPrice = `$${basePrice} + $${adicional}`;
            }
            formatted = formatted.replace(/{{TOTAL}}/g, displayPrice);
        }
    }
    return formatted;
}
/**
 * _isDuplicate
 * Checks if the proposed message is identical or near-identical to the last bot message.
 * Prevents the bot from sending the same text twice in a row.
 */
function _isDuplicate(proposedMsg, history) {
    if (!history || history.length === 0)
        return false;
    // Find last bot message
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'bot') {
            const lastMsg = history[i].content.trim().toLowerCase();
            const newMsg = proposedMsg.trim().toLowerCase();
            // Exact match or very similar (within 10 chars difference)
            if (lastMsg === newMsg)
                return true;
            // Also catch near-duplicates (same start, same core message)
            if (lastMsg.length > 30 && newMsg.length > 30 && lastMsg.substring(0, 50) === newMsg.substring(0, 50))
                return true;
            break; // Only check the LAST bot message
        }
    }
    return false;
}
/**
 * _getAdminSuggestions
 * Returns contextual quick-reply suggestions for the admin based on the step and user message.
 * Legacy string[] return for backwards compat with _pauseAndAlert display.
 */
function _getAdminSuggestions(step, userMessage) {
    return _getQuickReplies(step, userMessage).map(qr => qr.message);
}
/**
 * _getQuickReplies
 * Returns actionable quick replies the admin can trigger with "Xr1", "Xr2", "Xr3".
 * Each reply has a label (shown in alert) and a message (sent to client).
 */
function _getQuickReplies(step, userMessage) {
    const normalized = (userMessage || '').toLowerCase();
    // Rejection / refusal
    if (/no (quiero|puedo|acepto|me interesa)|no gracias|dejá|dej[aá]/i.test(normalized)) {
        return [
            { label: 'Dejar puerta abierta', message: 'Tranqui, si cambiás de idea acá estamos 😊' },
            { label: 'Preguntar duda', message: '¿Hay algo puntual que te genere duda? Estoy para ayudarte.' },
            { label: 'Ofrecer descuento', message: 'Mirá, te puedo hacer un precio especial si te decidís hoy. ¿Te interesa?' },
        ];
    }
    // Trust / scam concerns
    if (/estafa|trucho|mentira|robo|engaño|chanta|falso|fraude/i.test(normalized)) {
        return [
            { label: 'Aclarar pago', message: 'Entiendo tu preocupación. Solo cobramos en efectivo al recibir el producto, no pedimos datos bancarios ni pagos por adelantado.' },
            { label: 'Mostrar trayectoria', message: 'Llevamos 13 años con más de 15.000 clientes satisfechos. ¿Querés que te pase testimonios?' },
            { label: 'Dejar abierto', message: 'Respeto tu decisión. Si querés verificar, podés buscarnos en Google o Instagram. Acá estamos cuando quieras.' },
        ];
    }
    // Price / payment concerns
    if (/caro|precio|plata|dinero|pagar|costoso|barato|descuento|cuota/i.test(normalized)) {
        return [
            { label: 'Justificar valor', message: 'El precio incluye tratamiento completo + envío gratis + seguimiento personalizado. Es una inversión en tu salud.' },
            { label: 'Ofrecer plan corto', message: '¿Querés que te muestre un plan más corto para arrancar? Así probás y si te gusta seguís.' },
            { label: 'Descuento hoy', message: 'Te hago un descuento especial si confirmás hoy. ¿Te interesa?' },
        ];
    }
    // Waiting for data — privacy concern
    if (step === 'waiting_data') {
        return [
            { label: 'Aclarar privacidad', message: 'Tus datos solo se usan para el envío, no los compartimos con nadie.' },
            { label: 'Retiro en sucursal', message: 'Si preferís, podés retirar en sucursal y no necesitás dar dirección.' },
            { label: 'Ayudar con datos', message: '¿Necesitás ayuda para completar los datos? Te guío paso a paso.' },
        ];
    }
    // Waiting for OK — close the sale
    if (step === 'waiting_ok') {
        return [
            { label: 'Opciones de envío', message: 'Podés recibir en tu domicilio o retirar en sucursal, lo que te quede mejor.' },
            { label: 'Urgencia amable', message: 'Te comento que este precio es por tiempo limitado. ¿Seguimos?' },
            { label: 'Resolver duda', message: '¿Tenés alguna duda antes de confirmar? Estoy para ayudarte.' },
        ];
    }
    // Waiting for plan choice
    if (step === 'waiting_plan_choice') {
        return [
            { label: 'Recomendar plan', message: 'Te recomiendo el plan de 60 días, es el que mejor resultados da y tiene mejor precio por día.' },
            { label: 'Explicar diferencias', message: '¿Querés que te explique las diferencias entre los planes?' },
            { label: 'Plan corto', message: 'Si querés probar, el plan de 30 días es buena opción para arrancar.' },
        ];
    }
    // Generic fallback
    return [
        { label: 'Preguntar si necesita ayuda', message: '¡Hola! ¿Necesitás ayuda con algo? Estoy acá para lo que necesites.' },
        { label: 'Recordar producto', message: 'Te recuerdo que estabamos viendo los productos de Herbalis. ¿Seguimos?' },
        { label: 'Cerrar amable', message: 'Cualquier duda que tengas, acá estamos. ¡Éxitos!' },
    ];
}
