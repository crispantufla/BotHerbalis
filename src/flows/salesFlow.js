const { processGlobals } = require('./globals');
const { processStep } = require('./steps');
const { _pauseAndAlert, _setStep } = require('./utils/flowHelpers');

async function processSalesFlow(userId, text, userState, knowledge, dependencies) {
    const { saveState } = dependencies;

    // Remove accents and lowercase
    const lowerText = text.toLowerCase();
    const normalizedText = lowerText.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // 1. Initialization
    if (!userState[userId]) {
        console.log(`[STATE] Initializing new internal state for user ${userId}`);
        userState[userId] = {
            step: knowledge.flow.greeting ? 'greeting' : 'completed',
            history: [],
            cart: [],
            summary: "",
            partialAddress: {},
            selectedProduct: null,
            selectedPlan: null,
            geoRejected: false,
            stepEnteredAt: Date.now()
        };
    }
    saveState(userId);

    const currentState = userState[userId];

    // Safety fallback for empty history
    if (!currentState.history) currentState.history = [];

    // Save User message
    currentState.history.push({ role: 'user', content: text, timestamp: Date.now() });
    saveState(userId);

    // 2. Execute Global Interceptors (Priority 0 and 1)
    const globalsResult = await processGlobals(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (globalsResult && globalsResult.matched) {
        return; // Handled globally!
    }

    // 3. Process Specific Step Logic
    const stepResult = await processStep(userId, text, normalizedText, currentState, knowledge, dependencies);

    // Recursive safety for stale steps
    if (stepResult && stepResult.staleReprocess) {
        return await processSalesFlow(userId, text, userState, knowledge, dependencies);
    }

    // 4. Safety Net / Fallback
    if (!stepResult || !stepResult.matched) {
        console.log(`[PAUSE] No match for user ${userId} at step "${currentState.step}". Pausing and alerting admin.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, `Bot no pudo responder en paso "${currentState.step}".`);
    }

    // 5. Post-Processing Medical Reject Check
    if (currentState.history && currentState.history.length > 0) {
        const lastHistory = currentState.history[currentState.history.length - 1];
        if (lastHistory.role === 'bot' && lastHistory.content.includes('por precaución no recomendamos el uso durante el embarazo/lactancia/edad avanzada')) {
            console.log(`[AI MEDICAL REJECT] Intercepted AI rejection for user ${userId}. Halting flow.`);
            _setStep(currentState, 'rejected_medical');
            saveState(userId);
        }
    }
}

module.exports = { processSalesFlow };
