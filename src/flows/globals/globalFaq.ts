import { UserState } from '../../types/state';
import logger from '../../utils/logger';

/**
 * FAQ keyword matcher — red de seguridad antes del AI.
 *
 * Si el usuario hace una pregunta (termina en `?` o arranca con palabra
 * interrogativa) y matchea keywords de algún FAQ del knowledge, respondemos
 * con la canned response sin gastar AI ni esperar timeouts. Esto protege
 * contra casos donde el AI fallback queda silente (timeout, circuit breaker,
 * error transitorio) y la conversación se cae.
 *
 * Caso disparador: cliente preguntó "Cuanto tarda en llegar?" en
 * waiting_plan_choice; el AI no respondió y el admin tuvo que entrar a mano.
 */

const QUESTION_STARTERS = /^\s*(como|cómo|cuanto|cuánto|cuando|cuándo|donde|dónde|que|qué|cual|cuál|por que|por qué|sale|cuesta|tarda|demora|hay|tienen|tenes|tenés|puedo|se puede|funciona|sirve)\b/i;

function _normalize(s: string): string {
    return (s || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
        .trim();
}

export async function handleFaq(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, saveState } = dependencies;

    if (!knowledge?.faq?.length) return null;

    const trimmed = (text || '').trim();
    if (!trimmed) return null;

    // Solo intercepta si el mensaje parece pregunta — evita falsos positivos
    // sobre datos de envío, números de plan, afirmaciones, etc.
    const isQuestion = trimmed.endsWith('?') || QUESTION_STARTERS.test(trimmed);
    if (!isQuestion) return null;

    // No interferir en pasos finales: ya está pausado o esperando admin.
    const skipSteps = new Set(['waiting_admin_validation', 'completed', 'rejected_medical', 'rejected_abusive', 'rejected_geo', 'closing']);
    if (skipSteps.has(currentState.step as string)) return null;

    const norm = _normalize(text);

    // Buscar el FAQ cuyo keyword más largo matchea (más específico gana).
    let bestEntry: any = null;
    let bestLen = 0;
    for (const entry of knowledge.faq) {
        if (!entry?.keywords || !entry?.response) continue;
        for (const kw of entry.keywords) {
            const nkw = _normalize(kw);
            if (!nkw || nkw.length < 4) continue; // keywords muy cortas (ej "si") generan ruido
            if (norm.includes(nkw) && nkw.length > bestLen) {
                bestEntry = entry;
                bestLen = nkw.length;
            }
        }
    }

    if (!bestEntry) return null;

    // Skip FAQs cuyo triggerStep ya fue superado por el cliente — evita
    // re-preguntar datos ya capturados (caso típico: FAQ de precio que reasea
    // los kilos cuando el cliente ya está en waiting_preference).
    const STEPS_PAST_WEIGHT = new Set<string>([
        'waiting_preference', 'waiting_preference_consultation',
        'waiting_plan_choice', 'waiting_price_confirmation', 'waiting_ok',
        'waiting_payment_method', 'waiting_mp_payment',
        'waiting_transfer_confirmation', 'waiting_data',
        'waiting_maps_confirmation', 'waiting_final_confirmation',
    ]);
    if (bestEntry.triggerStep === 'waiting_weight' && STEPS_PAST_WEIGHT.has(currentState.step as string)) {
        logger.info(`[FAQ] Skip FAQ con triggerStep=waiting_weight — ${userId} ya está en ${currentState.step}`);
        return null;
    }

    logger.info(`[FAQ] ${userId} matched (keyword len=${bestLen}) → "${bestEntry.response.substring(0, 60)}..."`);
    currentState.history.push({ role: 'bot', content: bestEntry.response, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, bestEntry.response);
    return { matched: true };
}
