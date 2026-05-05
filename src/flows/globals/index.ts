import { UserState } from '../../types/state';
import { handleSystemGlobals } from './globalSystem';
import { handleSafetyCheck } from './globalSafety';
import { handleMediaGlobals } from './globalMedia';
import { handleFaq } from './globalFaq';
import { handleScheduleRequest } from './globalScheduleRequest';

export async function processGlobals(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean; paused?: boolean } | null> {
    let result: { matched: boolean; paused?: boolean } | null;

    result = await handleSystemGlobals(userId, text, normalizedText, currentState, dependencies);
    if (result && result.matched) return result;

    result = await handleSafetyCheck(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (result && result.matched) return result;

    // Cliente pide horario específico de entrega (ej: "vengan mañana a las 17:30").
    // Correo Argentino NO permite agendar horarios — escalamos a admin antes
    // de que la IA invente una promesa imposible de cumplir.
    result = await handleScheduleRequest(userId, text, normalizedText, currentState, dependencies);
    if (result && result.matched) return result;

    // Media requests (photos) — handled globally for any step
    result = await handleMediaGlobals(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (result && result.matched) return result;

    // FAQ keyword matcher — red de seguridad antes del AI. Solo intercepta
    // mensajes con forma de pregunta (?, "como/cuanto/..."), así no toca
    // afirmaciones de dato, números de plan, etc. El AI sigue siendo el
    // primer intento dentro de cada step; esto cubre cuando el AI cae.
    result = await handleFaq(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (result && result.matched) return result;

    return null; // Not matched by any global interceptor
}
