"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWaitingOk = handleWaitingOk;
const state_1 = require("../../types/state");
const messages_1 = require("../utils/messages");
const flowHelpers_1 = require("../utils/flowHelpers");
const validation_1 = require("../utils/validation");
const logger_1 = __importDefault(require("../../utils/logger"));
async function handleWaitingOk(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;
    const isQuestion = (text.includes('?') || /\b(puedo|puede|como|donde|cuando|que pasa)\b/.test(normalizedText)) && !/\b(si|dale|ok|listo|bueno|claro|vamos|joya)\b/.test(normalizedText);
    if (/\b(buscar|recoger|ir yo|ir a buscar|retirar yo|retiro yo|paso a buscar)\b/.test(normalizedText)) {
        const msg = 'No tenemos local de venta al público. Los envíos se hacen exclusivamente por Correo Argentino 📦. Pero tranqui, si el cartero no te encuentra, podés retirarlo en la sucursal más cercana.\n\n👉 ¿Te resulta posible recibirlo así? SÍ o NO';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }
    else if (isQuestion) {
        logger_1.default.info(`[AI-FALLBACK] waiting_ok: Detected QUESTION from ${userId}`);
        const aiOk = await aiService.chat(text, {
            step: state_1.FlowStep.WAITING_OK,
            goal: 'El usuario tiene una duda sobre el envío. Respondé de manera detallada, humana y empática, resolviendo sus ansiedades sobre el envío de forma cálida y extensa. Tómate tu tiempo en conversar antes de preguntar: ¿Te resulta posible retirar en sucursal si fuera necesario? SÍ o NO.',
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
    else if ((0, validation_1._isAffirmative)(normalizedText)) {
        const msg = (0, messages_1._formatMessage)(knowledge.flow.closing.response, currentState);
        (0, flowHelpers_1._setStep)(currentState, knowledge.flow.closing.nextStep);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }
    else if ((0, validation_1._isNegative)(normalizedText)) {
        logger_1.default.info(`[PAUSE] waiting_ok: User ${userId} declined delivery conditions.`);
        await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, 'El cliente rechazó las condiciones de envío.');
        return { matched: true };
    }
    else {
        logger_1.default.info(`[AI-FALLBACK] waiting_ok: No match for ${userId}`);
        const aiOk = await aiService.chat(text, {
            step: state_1.FlowStep.WAITING_OK,
            goal: 'El usuario debe confirmar que puede retirar en sucursal si es necesario. Respondé de manera muy amable, calmando cualquier duda de forma detallada y preguntándole de vuelta con mucha calidez: SÍ o NO.',
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
