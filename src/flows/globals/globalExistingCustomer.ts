import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
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
const ALREADY_BOUGHT = /\bya\s+(?:lo|la|las|los|les)?\s*(?:compre|adquiri|recibi)\b|\bya\s+(?:lo|la|las|los)\s+tengo\b(?!\s+(?:decidid|clar|pensad|vist))|\b(?:lo|la|las|los)\s+estoy\s+tomando\b|\bestoy\s+tomando(?:lo|la|las|los)\b|\bme\s+(?:lo|la|las|los)\s+trajeron\b|\b(?:ya|hoy|ayer|recien)\s+me\s+(?:llego|llegaron)\b|\bme\s+llegaron\s+(?:las|los)\b|\bya\s+soy\s+client[ea]\b|\bestoy\s+tomando\s+(?:las?|los|el)?\s*(?:capsulas?|gotas?|semillas?|pastillas?|nuez|producto|tratamiento)\b|\b(?:empece|comence)\s+(?:a\s+tomar|con\s+(?:las?|los|el))\b|\bdesde\s+que\s+(?:empece|(?:lo|la|las|los)\s+tomo|tomo)\b|\bhace\s+(?:\d+|un[oa]?|dos|tres)\s+(?:dias?|semanas?|mes(?:es)?)\s+que\s+(?:(?:lo|la|las|los)\s+)?(?:tomo|estoy\s+tomando)\b/;
// Síntomas que el cliente le atribuye al producto. Solo cuentan junto a "ya lo
// estoy tomando": de un lead, "¿da diarrea?" es una pregunta y la contesta el paso.
const ADVERSE = /\b(diarrea|vomit\w*|nauseas?|mareos?|maread[oa]|colicos?|retorcijon\w*|dolor(?:es)?\s+de\s+(?:panza|estomago|cabeza|barriga|pecho)|me\s+duele\w*\s+(?:la|el)\s+(?:panza|estomago|cabeza|barriga|pecho)|taquicardia|palpitaciones|alergia|sarpullido|ronchas|me\s+(?:cayo|cae|cayeron|caen|hizo|hace|hicieron|hacen)\s+(?:re\s+|muy\s+)?mal|descompuest[oa]|descompostura|me\s+descompuse)\b/;
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
    if (!ALREADY_BOUGHT.test(normalizedText)) return null;

    // Lo está tomando y le cayó mal: tema de salud, lo sigue una persona. En el
    // PRIMER mensaje esto recibía el saludo de ventas con "¿Te paso los precios?"
    // (simulación del 24-nov-2026); más adelante dependía de que la IA marcara
    // el caso.
    if (ADVERSE.test(normalizedText)) {
        currentState.cart = [];
        currentState.pendingOrder = null;
        saveState(userId);
        await sendMessageWithDelay(userId, 'Lamento muchísimo que te esté pasando eso 🙏 Le paso tu caso ahora a una asesora de atención al cliente para que te ayude, enseguida te escribe.');
        await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ Cliente reporta una REACCIÓN ADVERSA al producto (tema de salud). Derivado a atención humana — NO vender, revisar el caso.');
        logger.info(`[EXISTING-CUSTOMER] ${userId} lo está tomando y reporta un malestar ("${text.slice(0, 50)}") → pauso y aviso.`);
        return { matched: true };
    }
    if (WANTS_MORE.test(normalizedText)) return null;

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
