import { UserState } from '../../types/state';
const { handleGreeting } = require('./stepGreeting');
const { handleWaitingWeight } = require('./stepWaitingWeight');
const { handleWaitingPreference } = require('./stepWaitingPreference');
const { handleWaitingPriceConfirmation } = require('./stepWaitingPriceConfirmation');
const { handleWaitingPlanChoice } = require('./stepWaitingPlanChoice');
const { handleWaitingOk } = require('./stepWaitingOk');
const { handleWaitingData } = require('./stepWaitingData');
const { handleWaitingFinalConfirmation } = require('./stepWaitingFinalConfirmation');
const { handleAdminSteps } = require('./stepAdmin');
const { handleCompleted } = require('./stepCompleted');

export async function processStep(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean; staleReprocess?: boolean; paused?: boolean }> {
    const step = currentState.step;
    let result: { matched: boolean; staleReprocess?: boolean; paused?: boolean } | null = null;

    switch (step) {
        case 'greeting':
            result = await handleGreeting(userId, text, currentState, knowledge, dependencies);
            break;
        case 'waiting_weight':
            result = await handleWaitingWeight(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_preference':
            result = await handleWaitingPreference(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_price_confirmation':
            result = await handleWaitingPriceConfirmation(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_plan_choice':
            result = await handleWaitingPlanChoice(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_ok':
            result = await handleWaitingOk(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_data':
            result = await handleWaitingData(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_final_confirmation':
            result = await handleWaitingFinalConfirmation(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_admin_ok':
        case 'waiting_admin_validation':
            result = await handleAdminSteps(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'completed':
            result = await handleCompleted(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        default: {
            const { _setStep } = require('../utils/flowHelpers');
            console.log(`[STALE-STEP] User ${userId} has unknown step "${currentState.step}". Migrating...`);
            const stepMigrations: Record<string, string> = { 'waiting_legal_acceptance': 'waiting_final_confirmation' };
            const migratedStep = stepMigrations[currentState.step];

            if (migratedStep) {
                console.log(`[STALE-STEP] Migrating ${currentState.step} → ${migratedStep}`);
                _setStep(currentState, migratedStep);
                dependencies.saveState(userId);
                return { matched: false, staleReprocess: true };
            } else {
                console.log(`[STALE-STEP] No migration for "${currentState.step}". Resetting to greeting.`);
                _setStep(currentState, 'greeting');
                currentState.cart = [];
                currentState.pendingOrder = null;
                currentState.partialAddress = {};
                currentState.addressAttempts = 0;
                dependencies.saveState(userId);
                return { matched: false, staleReprocess: true };
            }
        }
    }
    return result || { matched: false };
}

module.exports = { processStep };
