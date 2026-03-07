import { UserState } from '../../types/state';
const { handleSystemGlobals } = require('./globalSystem');
const { handleSafetyCheck } = require('./globalSafety');
const { handleMediaGlobals } = require('./globalMedia');

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

    // Media requests (photos) — handled globally for any step
    result = await handleMediaGlobals(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (result && result.matched) return result;

    // FAQ questions (payment, shipping, how-to-take, etc.) are now handled
    // by the AI naturally within each step handler — no more global interceptors.

    return null; // Not matched by any global interceptor
}
