"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processStep = processStep;
const stepGreeting_1 = require("./stepGreeting");
const stepWaitingWeight_1 = require("./stepWaitingWeight");
const stepWaitingPreference_1 = require("./stepWaitingPreference");
const stepWaitingPriceConfirmation_1 = require("./stepWaitingPriceConfirmation");
const stepWaitingPlanChoice_1 = require("./stepWaitingPlanChoice");
const stepWaitingOk_1 = require("./stepWaitingOk");
const stepWaitingData_1 = require("./stepWaitingData");
const stepWaitingFinalConfirmation_1 = require("./stepWaitingFinalConfirmation");
const stepWaitingMapsConfirmation_1 = require("./stepWaitingMapsConfirmation");
const stepAdmin_1 = require("./stepAdmin");
const stepCompleted_1 = require("./stepCompleted");
const logger_1 = __importDefault(require("../../utils/logger"));
async function processStep(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const step = currentState.step;
    let result = null;
    switch (step) {
        case 'greeting':
            result = await (0, stepGreeting_1.handleGreeting)(userId, text, currentState, knowledge, dependencies);
            break;
        case 'waiting_weight':
            result = await (0, stepWaitingWeight_1.handleWaitingWeight)(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_preference':
            result = await (0, stepWaitingPreference_1.handleWaitingPreference)(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_price_confirmation':
            result = await (0, stepWaitingPriceConfirmation_1.handleWaitingPriceConfirmation)(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_plan_choice':
            result = await (0, stepWaitingPlanChoice_1.handleWaitingPlanChoice)(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_ok':
            result = await (0, stepWaitingOk_1.handleWaitingOk)(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_data':
            result = await (0, stepWaitingData_1.handleWaitingData)(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_final_confirmation':
            result = await (0, stepWaitingFinalConfirmation_1.handleWaitingFinalConfirmation)(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_maps_confirmation':
            result = await (0, stepWaitingMapsConfirmation_1.handleWaitingMapsConfirmation)(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'waiting_admin_ok':
        case 'waiting_admin_validation':
            result = await (0, stepAdmin_1.handleAdminSteps)(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'completed':
            result = await (0, stepCompleted_1.handleCompleted)(userId, text, normalizedText, currentState, knowledge, dependencies);
            break;
        case 'rejected_medical':
        case 'rejected_abusive':
        case 'rejected_geo':
            // Terminal states — bot stays silent, message is swallowed
            logger_1.default.info(`[STEP] User ${userId} is in terminal state "${step}". Ignoring message.`);
            result = { matched: true };
            break;
        default: {
            const { _setStep } = require('../utils/flowHelpers');
            logger_1.default.info(`[STALE-STEP] User ${userId} has unknown step "${currentState.step}". Migrating...`);
            const stepMigrations = { 'waiting_legal_acceptance': 'waiting_final_confirmation' };
            const migratedStep = stepMigrations[currentState.step];
            if (migratedStep) {
                logger_1.default.info(`[STALE-STEP] Migrating ${currentState.step} → ${migratedStep}`);
                _setStep(currentState, migratedStep);
                dependencies.saveState(userId);
                return { matched: false, staleReprocess: true };
            }
            else {
                logger_1.default.info(`[STALE-STEP] No migration for "${currentState.step}". Resetting to greeting.`);
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
