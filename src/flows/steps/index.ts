import { UserState } from '../../types/state';
import { handleGreeting } from './stepGreeting';
import { handleWaitingWeight } from './stepWaitingWeight';
import { handleWaitingPreference } from './stepWaitingPreference';
import { handleWaitingPriceConfirmation } from './stepWaitingPriceConfirmation';
import { handleWaitingPlanChoice } from './stepWaitingPlanChoice';
import { handleWaitingOk } from './stepWaitingOk';
import { handleWaitingData } from './stepWaitingData';
import { handleWaitingFinalConfirmation } from './stepWaitingFinalConfirmation';
import { handleWaitingMapsConfirmation } from './stepWaitingMapsConfirmation';
import { handleWaitingPaymentMethod } from './stepWaitingPaymentMethod';
import { handleWaitingMpPayment } from './stepWaitingMpPayment';
import { handleAdminSteps } from './stepAdmin';
import { handleCompleted } from './stepCompleted';
import logger from '../../utils/logger';

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
        case 'waiting_maps_confirmation':
            result = await handleWaitingMapsConfirmation(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_payment_method':
            result = await handleWaitingPaymentMethod(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_mp_payment':
            result = await handleWaitingMpPayment(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_admin_ok':
        case 'waiting_admin_validation':
            result = await handleAdminSteps(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'completed':
            result = await handleCompleted(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'rejected_medical':
        case 'rejected_abusive':
        case 'rejected_geo':
            // Terminal states — bot stays silent, message is swallowed
            logger.info(`[STEP] User ${userId} is in terminal state "${step}". Ignoring message.`);
            result = { matched: true };
            break;
        default: {
            const { _setStep } = require('../utils/flowHelpers');
            logger.info(`[STALE-STEP] User ${userId} has unknown step "${currentState.step}". Migrating...`);
            const stepMigrations: Record<string, string> = {
                'waiting_legal_acceptance': 'waiting_final_confirmation',
                'waiting_payment_method': 'waiting_payment_method', // already valid — just re-process
                'waiting_mp_payment': 'waiting_payment_method',      // MP link likely expired — restart payment
            };
            const migratedStep = stepMigrations[currentState.step];

            if (migratedStep) {
                logger.info(`[STALE-STEP] Migrating ${currentState.step} → ${migratedStep}`);
                _setStep(currentState, migratedStep);
                dependencies.saveState(userId);
                return { matched: false, staleReprocess: true };
            } else {
                logger.info(`[STALE-STEP] No migration for "${currentState.step}". Resetting to greeting.`);
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
