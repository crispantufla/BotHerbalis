const { _formatMessage } = require('../utils/messages');
const { _setStep } = require('../utils/flowHelpers');
const { _isAffirmative } = require('../utils/validation');

async function handleWaitingPriceConfirmation(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    const wantsPrices = /\b(precio|precios|info|cuanto|cuánto|pasame|decime|conta)\b/.test(normalizedText);
    if (wantsPrices || _isAffirmative(normalizedText)) {
        let msg = "";
        if (currentState.selectedProduct && currentState.selectedProduct.includes("Cápsulas")) {
            msg = _formatMessage(knowledge.flow.price_capsulas.response, currentState);
            _setStep(currentState, knowledge.flow.price_capsulas.nextStep);
        } else if (currentState.selectedProduct && currentState.selectedProduct.includes("Gotas")) {
            msg = _formatMessage(knowledge.flow.price_gotas.response, currentState);
            _setStep(currentState, knowledge.flow.price_gotas.nextStep);
        } else {
            msg = _formatMessage(knowledge.flow.price_semillas.response, currentState);
            _setStep(currentState, knowledge.flow.price_semillas.nextStep);
        }
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);

        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    } else {
        console.log(`[AI-FALLBACK] waiting_price_confirmation: No match for ${userId}`);
        const aiPrice = await aiService.chat(text, {
            step: 'waiting_price_confirmation',
            goal: 'El usuario debe confirmar si quiere ver los precios. Si tiene dudas, respondé brevemente y preguntale si quiere que le pases los precios.',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiPrice.response) {
            currentState.history.push({ role: 'bot', content: aiPrice.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiPrice.response);
            return { matched: true };
        }
    }
    return { matched: false };
}

module.exports = { handleWaitingPriceConfirmation };
