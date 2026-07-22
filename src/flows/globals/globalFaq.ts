import { UserState } from '../../types/state';
import { _isInfoQuestion, _startsAffirmative } from '../utils/flowHelpers';
import { PAID_KEYWORDS as MP_PAID_KEYWORDS } from '../steps/stepWaitingMpPayment';
import { PAID_KEYWORDS as TRANSFER_PAID_KEYWORDS } from '../steps/stepWaitingTransferConfirmation';
import logger from '../../utils/logger';

// Claims de pago que los PAID_KEYWORDS de los steps no cubren pero que también
// significan "ya pagué" (el step los resuelve vía AI fallback con contexto).
const PAYMENT_CLAIM_EXTRA = /\b(comprobante|acabo de (pagar|transferir|abonar)|ya (abone|transferi)|transferencia (hecha|realizada|enviada))\b/i;

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
    // sobre datos de envío, números de plan, afirmaciones, etc. _isInfoQuestion
    // capta interrogativos en medio de la frase ("con tarjeta cuanto tardan"),
    // no solo al inicio o con "?" final.
    if (!_isInfoQuestion(trimmed)) return null;

    // No interferir en pasos finales: ya está pausado o esperando admin.
    const skipSteps = new Set(['waiting_admin_validation', 'completed', 'rejected_medical', 'rejected_abusive', 'rejected_geo', 'closing']);
    if (skipSteps.has(currentState.step as string)) return null;

    const norm = _normalize(text);

    // Buscar el FAQ cuyo keyword más largo matchea (más específico gana).
    let bestEntry: any = null;
    let bestLen = 0;
    let bestKw = '';
    for (const entry of knowledge.faq) {
        if (!entry?.keywords || !entry?.response) continue;
        for (const kw of entry.keywords) {
            const nkw = _normalize(kw);
            if (!nkw || nkw.length < 4) continue; // keywords muy cortas (ej "si") generan ruido
            if (norm.includes(nkw) && nkw.length > bestLen) {
                bestEntry = entry;
                bestLen = nkw.length;
                bestKw = nkw;
            }
        }
    }

    if (!bestEntry) return null;

    // "tarda" / "demora" / "tiempo" son ambiguas: pueden referirse al tiempo del ENVÍO
    // o a cuánto TARDA EN BAJAR DE PESO. Si la pregunta es sobre el ritmo de descenso,
    // NO dispares la FAQ de envío — que la responda el paso/IA (ej. "4 a 6 kg el primer
    // mes"). Reporte admin 2026-06-19 (5493425380805): "Demora mucho en bajar eso kilo?"
    // → el bot soltó el menú de envío y no respondió lo que preguntaba.
    const _timingKw = new Set(['tarda', 'demora', 'tiempo', 'cuanto tarda']);
    const _weightLossTiming =
        /\bbaj/.test(norm)                       // bajar / baja / bajo / bajando
        || /\bperder\b|\bpierd/.test(norm)       // perder / pierdo (NO "perdón")
        || /\badelgaz/.test(norm)                // adelgazar
        || /\bdescenso\b|\bdescend/.test(norm)   // descenso / descender
        || /\bkilo/.test(norm);                  // kilo / kilos
    if (_timingKw.has(bestKw) && _weightLossTiming) {
        logger.info(`[FAQ] Skip FAQ envío — "${trimmed.slice(0, 50)}" pregunta por ritmo de descenso, no por el envío`);
        return null;
    }

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

    // ── Passthroughs POR STEP ────────────────────────────────────────────────
    // Misma clase de bug en tres lugares: el cliente mete la pregunta EN EL
    // MISMO mensaje que la señal operativa que el step espera (datos, "sí",
    // aviso de pago). Si la FAQ devuelve matched, la señal nunca llega al step
    // y la venta se traba. La señal es POR STEP — un passthrough genérico
    // dejaría pasar preguntas puras y el step re-preguntaría arriba de la FAQ.

    // waiting_mp_payment / waiting_transfer_confirmation (caso 22-jul): "Ya
    // hice la transferencia ¿me confirmás?" — la keyword "transferencia"
    // matcheaba la FAQ del alias y el bot RE-MANDABA las instrucciones de
    // transferir a alguien que ya transfirió, y el step nunca veía el aviso.
    // Con claim de pago NO mandamos la canned response (quedó desactualizada
    // frente al claim — reenviarla contradice al paid-branch del step): salimos
    // en silencio y el step responde lo justo ("recibimos tu aviso...").
    const paymentClaim =
        (currentState.step === 'waiting_mp_payment' || currentState.step === 'waiting_transfer_confirmation')
        && (MP_PAID_KEYWORDS.test(norm) || TRANSFER_PAID_KEYWORDS.test(norm) || PAYMENT_CLAIM_EXTRA.test(norm));
    if (paymentClaim) {
        logger.info(`[FAQ] Skip FAQ en ${currentState.step} — "${trimmed.slice(0, 50)}" trae claim de pago; lo maneja el step`);
        return null;
    }

    // waiting_data (caso real 5492215731759, 21-jul: "Quintana y bolivia...
    // \nEnsenada\n1925 Cómo tomo las cápsulas" — la FAQ de posología respondía,
    // devolvía matched y el step nunca veía los datos: el bot los re-pedía y la
    // venta se trabó). Señales de datos: multilínea, o un número de 4+ dígitos
    // (CP/teléfono). Respondemos la FAQ igual, pero devolvemos null para que el
    // step procese el MISMO mensaje y persista los datos.
    const dataBlockPassthrough = currentState.step === 'waiting_data'
        && (/\n/.test(trimmed) || /\b\d{4,}\b/.test(trimmed));

    // waiting_maps_confirmation (caso 22-jul): el bot pidió "respondé *sí*" y
    // el cliente contestó "Si, es correcta ¿cuánto tarda en llegar?" — la FAQ
    // de envíos se tragaba el "sí" y la orden no se armaba. Señal operativa:
    // arranque afirmativo/negativo, o un CP de 4 dígitos (corrección de
    // dirección), ADEMÁS de la pregunta. _startsAffirmative distingue el "sí"
    // afirmativo del "si" condicional: "y si tarda mucho?" NO confirma nada y
    // la FAQ la responde entera (matched), sin dejarla caer al step.
    const mapsPassthrough = currentState.step === 'waiting_maps_confirmation'
        && (_startsAffirmative(trimmed) || /^no\b/.test(norm) || /\b\d{4}\b/.test(trimmed));

    const passthrough = dataBlockPassthrough || mapsPassthrough;
    logger.info(`[FAQ] ${userId} matched (keyword len=${bestLen}) → "${bestEntry.response.substring(0, 60)}..."${passthrough ? ` [passthrough: señal operativa en ${currentState.step}]` : ''}`);
    currentState.history.push({ role: 'bot', content: bestEntry.response, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, bestEntry.response);
    if (passthrough) return null; // el step procesa el MISMO texto (la señal viene adentro)
    return { matched: true };
}
