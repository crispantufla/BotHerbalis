import { UserState, FlowStep } from '../../types/state';
import { _setStep } from '../utils/flowHelpers';
import logger from '../../utils/logger';

/**
 * El cliente avisa que YA compró y lo está tomando ("ya compré las gotas, estoy
 * tomándolas, ¿en cuánto se ve el resultado?"). No es un lead: no se le vende.
 *
 * El 12-nov-2026 a una clienta así el bot le leyó "gotas" como elección de
 * producto, le pasó planes y precios, y le pidió la localidad cuatro veces
 * mientras ella repetía que ya lo tenía. No figuraba en Orders (le vendieron a
 * mano), así que el chequeo de cliente recurrente no la reconocía.
 *
 * Qué hace: la IA le contesta la duda sin venderle, y el chat queda como
 * post-venta (`completed`): el mensaje siguiente lo toma una persona, igual que
 * con cualquier comprador.
 */
const ALREADY_BOUGHT = /\bya\s+(?:lo|la|las|los|les)?\s*(?:compre|adquiri|recibi)\b|\bya\s+(?:lo|la|las|los)\s+tengo\b(?!\s+(?:decidid|clar|pensad|vist))|\b(?:lo|la|las|los)\s+estoy\s+tomando\b|\bestoy\s+tomando(?:lo|la|las|los)\b|\bme\s+(?:lo|la|las|los)\s+trajeron\b|\bya\s+soy\s+client[ea]\b/;
// Vuelve a comprar: eso sí es una venta, y la maneja el flujo normal.
const WANTS_MORE = /\b(quiero|quisiera|necesito|pedir|reponer|otro|otra|otra vez|de nuevo|mas|se me (termino|acabo|esta (terminando|acabando)))\b/;
const SELLING_STEPS = new Set(['greeting', 'waiting_weight', 'waiting_preference', 'waiting_preference_consultation', 'waiting_plan_choice', 'waiting_zone', 'waiting_payment_method']);

export async function handleExistingCustomer(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, saveState, aiService } = dependencies;
    if (!SELLING_STEPS.has(String(currentState.step || '')) || (currentState as any).promo?.active) return null;
    if (!ALREADY_BOUGHT.test(normalizedText) || WANTS_MORE.test(normalizedText)) return null;

    let reply = '¡Qué bueno que ya lo estás tomando! 😊 Cualquier duda que tengas sobre cómo tomarlo, escribime por acá.';
    try {
        const aiRes = await aiService.chat(text, {
            step: FlowStep.COMPLETED,
            goal: `El cliente te avisa que YA COMPRÓ el producto y lo está tomando. NO es un cliente nuevo: 🛑 NO le ofrezcas productos, planes ni precios, NO le pidas localidad ni datos, NO intentes venderle nada. Si en su mensaje hay una duda (cómo se toma, en cuánto se ven resultados, algún efecto), respondela con calidez y con el knowledge, sin prometer kilos ni plazos. Si no hay duda, alegrate con él y decile que estás para lo que necesite. Mensaje corto, sin cerrar con una pregunta de venta. goalMet=false, extractedData=null.`,
            history: currentState.history,
            summary: currentState.summary,
            knowledge,
            userState: currentState,
        });
        if (aiRes?.response) reply = aiRes.response;
    } catch (e: any) {
        logger.warn(`[EXISTING-CUSTOMER] IA falló para ${userId}: ${e.message} — va la respuesta fija.`);
    }

    currentState.cart = [];
    currentState.pendingOrder = null;
    currentState.selectedPlan = null;
    currentState.hasSoldBefore = true;
    _setStep(currentState, FlowStep.COMPLETED);
    saveState(userId);
    await sendMessageWithDelay(userId, reply);
    logger.info(`[EXISTING-CUSTOMER] ${userId} avisó que ya compró ("${text.slice(0, 50)}") → respondo sin vender y queda como post-venta.`);
    return { matched: true };
}
