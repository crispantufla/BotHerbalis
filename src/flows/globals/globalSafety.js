async function handleSafetyCheck(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, aiService } = dependencies;
    const SAFETY_REGEX = /\b(hija|hijo|niñ[oa]s?|menor(es)?|bebe|embaraz[oa]|lactanc?ia|1[0-7]\s*años?|bypass|manga\s*gastrica|bariatric[oa]|operad[oa]\s*del\s*estomago|cancer|terminal|quimioterapia|8[0-9]\s*años?|9[0-9]\s*años?)\b/i;
    const AGE_CLARIFICATION = /\b(tiene|tengo|son|es)\s*(\d{2,})\b|\b(\d{2,})\s*(años|año)\b|\b(mayor|adulto|adulta|grande)\b/i;

    const ageMatch = normalizedText.match(/\b(tiene|tengo)\s*(\d{2,})\b|\b(\d{2,})\s*(anos|ano)\b/);
    if (ageMatch) {
        const age = parseInt(ageMatch[2] || ageMatch[3]);
        if (age >= 18) {
            currentState.safetyResolved = true;
            console.log(`[SAFETY] Age clarified: ${age} years. Safety resolved.`);
        }
    }
    if (AGE_CLARIFICATION.test(normalizedText) && /\b(mayor|adulto|adulta|grande)\b/i.test(normalizedText)) {
        currentState.safetyResolved = true;
    }

    if (SAFETY_REGEX.test(normalizedText) && !currentState.safetyResolved) {
        console.log(`[SAFETY] Potential Red Flag detected: "${text}"`);
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

module.exports = { handleSafetyCheck };
