"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWaitingPriceConfirmation = handleWaitingPriceConfirmation;
const messages_1 = require("../utils/messages");
const flowHelpers_1 = require("../utils/flowHelpers");
const validation_1 = require("../utils/validation");
const logger_1 = __importDefault(require("../../utils/logger"));
async function handleWaitingPriceConfirmation(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;
    const wantsPrices = /\b(precio|precios|info|cuanto|cuánto|pasame|decime|conta)\b/.test(normalizedText);
    if (wantsPrices || (0, validation_1._isAffirmative)(normalizedText)) {
        let msg = '';
        if (currentState.selectedProduct && currentState.selectedProduct.includes('Cápsulas')) {
            msg = (0, messages_1._formatMessage)(knowledge.flow.price_capsulas.response, currentState);
            (0, flowHelpers_1._setStep)(currentState, knowledge.flow.price_capsulas.nextStep);
        }
        else if (currentState.selectedProduct && currentState.selectedProduct.includes('Gotas')) {
            msg = (0, messages_1._formatMessage)(knowledge.flow.price_gotas.response, currentState);
            (0, flowHelpers_1._setStep)(currentState, knowledge.flow.price_gotas.nextStep);
        }
        else {
            msg = (0, messages_1._formatMessage)(knowledge.flow.price_semillas.response, currentState);
            (0, flowHelpers_1._setStep)(currentState, knowledge.flow.price_semillas.nextStep);
        }
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }
    else {
        logger_1.default.info(`[AI-FALLBACK] waiting_price_confirmation: No match for ${userId}`);
        const aiPrice = await aiService.chat(text, {
            step: 'waiting_price_confirmation',
            goal: 'El usuario debe confirmar si quiere ver los precios. Si tiene dudas, respondé de manera detallada, humana y empática, resolviendo sus ansiedades de forma cálida y extensa, tómate tu tiempo, y luego preguntale si quiere que le pases los precios.',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });
        if (aiPrice.response) {
            currentState.history.push({ role: 'bot', content: aiPrice.response, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, aiPrice.response);
            return { matched: true };
        }
    }
    return { matched: false };
}
