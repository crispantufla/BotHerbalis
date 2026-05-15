import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import { _isAffirmative, _isNegative } from '../utils/validation';
import { _formatMessage } from '../utils/messages';
import { getFlowTemplate } from '../../utils/messageTemplates';
import logger from '../../utils/logger';

/**
 * TEXTO 3 — Tras la recomendación ("¿te paso precios?"), cliente dice "sí".
 * Plantilla en knowledge.flow.prices.response (visible en panel Guiones).
 * Placeholders: {{PRICE_60}}, {{PRICE_120}} se sustituyen por _getPrice según el producto.
 */
function _buildPricesMessage(state: UserState, knowledge: any): string {
    const tpl = getFlowTemplate('prices', knowledge);
    if (!tpl) {
        logger.error('[stepWaitingOk] flow.prices missing in knowledge — fallback genérico');
        return '¿Qué plan preferís: 60 o 120 días?';
    }
    return _formatMessage(tpl, state);
}

export async function handleWaitingOk(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // CAMBIO DE PRODUCTO: tras el soft-push de cápsulas en preference_gotas /
    // preference_semillas, el cliente puede responder "cápsulas" para cambiar
    // de opinión. Sin este branch caería en el AI fallback y la IA podría
    // ignorar el cambio (mostraría precios del producto viejo). Detectamos
    // cualquier mención EXPLÍCITA del producto alternativo y re-seteamos
    // selectedProduct antes de mostrar precios.
    const wantsCapsulas = /\b(c[aá]psulas?|pastillas?)\b/i.test(normalizedText);
    const wantsGotas = /\b(gotas?|gotero|l[ií]quido)\b/i.test(normalizedText);
    const wantsSemillas = /\b(semillas?|infusi[oó]n)\b/i.test(normalizedText);
    const currentProduct = currentState.selectedProduct || '';
    const productSwitches: Array<[string, boolean]> = [
        ['Cápsulas de nuez de la india', wantsCapsulas && !currentProduct.includes('Cápsulas')],
        ['Gotas de nuez de la india', wantsGotas && !currentProduct.includes('Gotas')],
        ['Semillas de nuez de la india', wantsSemillas && !currentProduct.includes('Semillas')],
    ];
    const switchTo = productSwitches.find(([_, should]) => should)?.[0];
    if (switchTo) {
        logger.info(`[PRODUCT-SWITCH] User ${userId} en waiting_ok cambió ${currentProduct} → ${switchTo}`);
        currentState.selectedProduct = switchTo;
        // Reset plan/cart — el cart se recalculará en waiting_plan_choice
        currentState.selectedPlan = undefined as any;
        currentState.cart = undefined as any;
    }

    // Si el cliente pide precios directamente ("precio", "cuánto sale", "valor"),
    // lo tratamos igual que un "sí, pasame los precios" — es la misma intención.
    // Sin este branch caía en el AI fallback y la IA improvisaba un texto que
    // solo mostraba el plan 60 (caso real: conversación de Nora 13/05 20:08).
    // El cambio de producto explícito (cápsulas/gotas) también dispara precios.
    const askingForPrices = !!switchTo || /\b(precio|precios|cu[áa]nto|cuanto|cuesta|cuestan|sale|salen|vale|valen|valor|costo)\b/i.test(normalizedText);

    const isQuestion = (text.includes('?') || /\b(puedo|puede|como|donde|cuando|que pasa)\b/.test(normalizedText)) && !/\b(si|dale|ok|listo|bueno|claro|vamos|joya)\b/.test(normalizedText) && !askingForPrices;

    if (/\b(buscar|recoger|ir yo|ir a buscar|retirar yo|retiro yo|paso a buscar)\b/.test(normalizedText)) {
        const msg = 'No tenemos local de venta al público. Los envíos se hacen exclusivamente por Correo Argentino 📦. Pero tranqui, si el cartero no te encuentra, podés retirarlo en la sucursal más cercana.\n\n👉 ¿Te resulta posible recibirlo así? SÍ o NO';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }
    else if (isQuestion) {
        logger.info(`[AI-FALLBACK] waiting_ok: Detected QUESTION from ${userId}`);
        const aiOk = await aiService.chat(text, {
            step: FlowStep.WAITING_OK,
            goal: 'El usuario tiene una duda tras la recomendación del plan. Respondé de manera detallada, humana y empática. Cuando termines, retomá la propuesta preguntando: ¿Te paso los precios?',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });
        if (aiOk.response) {
            currentState.history.push({ role: 'bot', content: aiOk.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiOk.response);
            saveState(userId);
            return { matched: true };
        }
    }
    else if (_isAffirmative(normalizedText) || askingForPrices) {
        // TEXTO 3 — Mostramos precios (60 Y 120) y pedimos plan choice.
        // askingForPrices: cliente pidió precios sin haber dicho "sí" explícito;
        // misma intención, evitamos AI fallback que solo mostraba 60.
        const msg = _buildPricesMessage(currentState, knowledge);
        _setStep(currentState, FlowStep.WAITING_PLAN_CHOICE);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    } else if (_isNegative(normalizedText)) {
        logger.info(`[PAUSE] waiting_ok: User ${userId} declined seeing prices/plan info.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente rechazó ver los precios o avanzar tras la recomendación.');
        return { matched: true };
    } else {
        logger.info(`[AI-FALLBACK] waiting_ok: No match for ${userId}`);
        const aiOk = await aiService.chat(text, {
            step: FlowStep.WAITING_OK,
            goal: 'El usuario aún no confirmó si quiere ver los precios del plan recomendado. Respondé con calidez resolviendo cualquier duda y retomá: ¿Te paso los precios? SÍ o NO.',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiOk.response) {
            currentState.history.push({ role: 'bot', content: aiOk.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiOk.response);
            saveState(userId);
            return { matched: true };
        }
    }
    return { matched: false };
}
