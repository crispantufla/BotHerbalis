import { UserState } from '../../types/state';
import { _setStep, _pauseAndAlert, _isInfoQuestion, _captureWeightGoal, _assignProductAndPlanByTier, _maybeSendPaymentMenuV7 } from '../utils/flowHelpers';
import { _formatMessage } from '../utils/messages';
import logger from '../../utils/logger';

/**
 * Regla del dueño: entre 70 y 79 años, SOLO gotas (la opción más suave); nunca
 * cápsulas ni semillas. De 80 en adelante la venta se rechaza (eso ya lo hace
 * el MEDICAL REJECT de globalSystem).
 *
 * Hasta el 12-nov-2026 la regla vivía solo en el prompt, atada a las palabras
 * "70 años" / "75 años" / "setenta": "Tengo 73 años" no la disparaba, y aunque
 * lo hiciera valía para ese mensaje nada más. Una clienta de 73 recibió la tabla
 * con los tres productos y un "¡Genial, las cápsulas!" (12-nov-2026).
 * Acá la edad se guarda en el estado y la regla se cumple desde el código.
 */
const AGE_70S = /\b(7\d)\s*a[ñn]os\b(?!\s+de\b)|\btengo\s+(7\d)\b(?!\s*(?:kg|kgs|kilos?|k)\b)/;
const GOTAS = 'Gotas de nuez de la india';
const PRE_PLAN_STEPS = new Set(['greeting', 'waiting_weight', 'waiting_preference', 'waiting_preference_consultation', 'waiting_plan_choice']);
const CLOSED_STEPS = new Set(['completed', 'waiting_admin_validation', 'rejected_medical', 'rejected_abusive', 'rejected_geo', 'closing', 'promo_offer']);

const GOTAS_PLANS = 'Vienen en dos planes:\n🔹 *60 días* → ${{PRICE_GOTAS_60}}\n🔹 *120 días* → ${{PRICE_GOTAS_120}}\n\nEnvío gratis 🚚 ¿Con cuál vas, 60 o 120 días?';

export async function handleAgeRule(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const step = String(currentState.step || '');
    if (CLOSED_STEPS.has(step) || (currentState as any).promo?.active) return null;

    const m = normalizedText.match(AGE_70S);
    const saidNow = m ? parseInt(m[1] || m[2], 10) : null;
    if (saidNow) {
        currentState.clientAge = saidNow;
        saveState(userId);
    }
    const age = Number(currentState.clientAge) || 0;
    if (age < 70 || age >= 80) return null;

    const hasGotas = /gotas/i.test(currentState.selectedProduct || '');
    // Elige otra presentación: por nombre, o por número cuando está mirando la
    // lista (1 = cápsulas, 3 = semillas).
    const namesOther = /\b(capsul\w*|pastill\w*|semill\w*)\b/.test(normalizedText) && !/\bgot\w*\b/.test(normalizedText);
    const numericOther = step === 'waiting_preference' && /^(?:opci[oó]n\s+|la\s+|el\s+)?[13]\s*[.)\-:]?$/.test(normalizedText.trim());
    const picksOther = namesOther || numericOther;

    if (PRE_PLAN_STEPS.has(step)) {
        // Mensaje con dudas y sin elección: lo contesta la IA, que recibe la edad
        // y la regla en el contexto del cliente (aiPrompts._buildStateContext).
        if (!picksOther && (hasGotas || !saidNow || _isInfoQuestion(text) || text.trim().split(/\s+/).length > 25)) return null;

        const lead = picksOther
            ? `Después de los 70 no indicamos las cápsulas ni las semillas 🙏 Con ${age} años te recomiendo las *gotas* 💧, que son la opción más suave.`
            : `Con ${age} años te recomiendo las *gotas* 💧: son la opción más suave y la única que indicamos después de los 70.`;
        _captureWeightGoal(normalizedText, currentState);
        _assignProductAndPlanByTier(currentState, GOTAS);
        const nextStep = knowledge?.flow?.preference_gotas?.nextStep || 'waiting_plan_choice';
        _setStep(currentState, nextStep);
        saveState(userId);
        await sendMessageWithDelay(userId, _formatMessage(`${lead}\n\n${GOTAS_PLANS}`, currentState));
        await _maybeSendPaymentMenuV7(userId, nextStep, currentState, knowledge, dependencies);
        logger.info(`[AGE-70] ${userId} tiene ${age} años${picksOther ? ' y pidió otra presentación' : ''} → solo gotas.`);
        return { matched: true };
    }

    // Ya pasó la elección con cápsulas o semillas y recién ahora dice la edad:
    // rearmar el pedido a mitad del cierre es para una persona, no para el bot.
    if (saidNow && currentState.selectedProduct && !hasGotas) {
        await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente de ${age} años con ${currentState.selectedProduct} elegido. La regla es solo gotas entre 70 y 80: revisar el pedido a mano.`);
        logger.info(`[AGE-70] ${userId} dijo ${age} años en ${step} con ${currentState.selectedProduct} → pausa para revisión.`);
        return { matched: true };
    }
    return null;
}
