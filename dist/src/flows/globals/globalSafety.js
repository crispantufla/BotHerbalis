"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSafetyCheck = handleSafetyCheck;
const logger_1 = __importDefault(require("../../utils/logger"));
async function handleSafetyCheck(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, aiService } = dependencies;
    const SAFETY_REGEX = /\b(hija|hijo|niñ[oa]s?|menor(es)?|bebe|embaraz[oa]|lactanc?ia|1[0-7]\s*años?|bypass|manga\s*gastrica|bariatric[oa]|operad[oa]\s*del\s*estomago|cancer|terminal|quimioterapia|8[0-9]\s*años?|9[0-9]\s*años?)\b/i;
    const AGE_CLARIFICATION = /\b(tiene|tengo|son|es)\s*(\d{2,})\b|\b(\d{2,})\s*(años|año)\b|\b(mayor|adulto|adulta|grande)\b/i;
    // If user clarifies they (or the person) are an adult, resolve the safety check
    const ageMatch = normalizedText.match(/\b(tiene|tengo)\s*(\d{2,})\b|\b(\d{2,})\s*(anos|ano)\b/);
    if (ageMatch) {
        const ageStr = ageMatch[2] || ageMatch[3];
        const age = parseInt(ageStr, 10);
        if (!isNaN(age) && age >= 18) {
            currentState.safetyResolved = true;
            logger_1.default.info(`[SAFETY] Age clarified: ${age} years. Safety resolved.`);
        }
    }
    if (AGE_CLARIFICATION.test(normalizedText) && /\b(mayor|adulto|adulta|grande)\b/i.test(normalizedText)) {
        currentState.safetyResolved = true;
    }
    if (SAFETY_REGEX.test(normalizedText) && !currentState.safetyResolved) {
        logger_1.default.info(`[SAFETY] Potential Red Flag detected: "${text}"`);
        const safetyCheck = await aiService.chat(text, {
            step: 'safety_check',
            goal: 'Verificar si hay contraindicación o riesgo para menor de edad. Si el usuario ya aclaró que la persona es mayor de 18 años, respondé que SÍ puede tomarla y goalMet=true. Si es menor de 18, rechazar venta amablemente.',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge
        });
        if (safetyCheck.response) {
            currentState.history.push({ role: 'bot', content: safetyCheck.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, safetyCheck.response);
            return { matched: true };
        }
    }
    return null;
}
