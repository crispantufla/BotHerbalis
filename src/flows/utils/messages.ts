const { _getPrices } = require('./pricing');

function _formatMessage(text: string | string[], state: any): string {
    if (!text) return "";

    // Si es un array de respuestas, elige una al azar para dar variabilidad
    let textToFormat = Array.isArray(text) ? text[Math.floor(Math.random() * text.length)] : text;

    const prices = _getPrices();

    let formatted = textToFormat;
    // Replace {{PRICE_PRODUCT_PLAN}}
    formatted = formatted.replace(/{{PRICE_CAPSULAS_60}}/g, prices['Cápsulas']['60']);
    formatted = formatted.replace(/{{PRICE_CAPSULAS_120}}/g, prices['Cápsulas']['120']);
    formatted = formatted.replace(/{{PRICE_SEMILLAS_60}}/g, prices['Semillas']['60']);
    formatted = formatted.replace(/{{PRICE_SEMILLAS_120}}/g, prices['Semillas']['120']);
    formatted = formatted.replace(/{{PRICE_GOTAS_60}}/g, prices['Gotas']['60']);
    formatted = formatted.replace(/{{PRICE_GOTAS_120}}/g, prices['Gotas']['120']);
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
                const basePriceInt = parseInt(state.totalPrice.replace(/\./g, '')) - state.adicionalMAX;
                const basePrice = basePriceInt.toLocaleString('es-AR').replace(/,/g, '.'); // Format back to 00.000
                const adicional = state.adicionalMAX.toLocaleString('es-AR').replace(/,/g, '.');
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
function _isDuplicate(proposedMsg: string, history: any[]): boolean {
    if (!history || history.length === 0) return false;
    // Find last bot message
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'bot') {
            const lastMsg = history[i].content.trim().toLowerCase();
            const newMsg = proposedMsg.trim().toLowerCase();
            // Exact match or very similar (within 10 chars difference)
            if (lastMsg === newMsg) return true;
            // Also catch near-duplicates (same start, same core message)
            if (lastMsg.length > 30 && newMsg.length > 30 && lastMsg.substring(0, 50) === newMsg.substring(0, 50)) return true;
            break; // Only check the LAST bot message
        }
    }
    return false;
}


/**
 * _getAdminSuggestions
 * Returns contextual quick-reply suggestions for the admin based on the step and user message.
 */
function _getAdminSuggestions(step: string, userMessage: string): string[] {
    const base = ['"ok" para confirmar pedido', '"me encargo" + tu instrucción'];
    const normalized = (userMessage || '').toLowerCase();

    if (/no (quiero|puedo|acepto|me interesa)/i.test(normalized)) {
        return [
            '"Tranqui, si cambiás de idea acá estamos 😊"',
            '"¿Hay algo puntual que te genere duda?"',
            ...base
        ];
    }
    if (/estafa|trucho|mentira|robo|engaño|chanta/i.test(normalized)) {
        return [
            '"Entiendo, por eso ofrecemos pago en efectivo al recibir. También aceptamos tarjeta o transferencia si preferís."',
            '"Llevamos 13 años con más de 15.000 clientes. ¿Querés seguir?"',
            ...base
        ];
    }
    if (step === 'waiting_data') {
        return [
            '"No te preocupes, tus datos solo se usan para el envío."',
            ...base
        ];
    }
    if (step === 'waiting_ok') {
        return [
            '"Podés recibir en tu domicilio o retirar en sucursal, lo que te quede mejor."',
            ...base
        ];
    }
    return base;
}

module.exports = {
    _formatMessage,
    _isDuplicate,
    _getAdminSuggestions
};
export { };
