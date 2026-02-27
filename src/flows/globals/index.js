const { handleSystemGlobals } = require('./globalSystem');
const { handleSafetyCheck } = require('./globalSafety');
const { handleFaqGlobals } = require('./globalFaq');

async function processGlobals(userId, text, normalizedText, currentState, knowledge, dependencies) {
    let result;

    result = await handleSystemGlobals(userId, text, normalizedText, currentState, dependencies);
    if (result && result.matched) return result;

    result = await handleSafetyCheck(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (result && result.matched) return result;

    result = await handleFaqGlobals(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (result && result.matched) return result;

    return null; // Not matched by any global interceptor
}

module.exports = { processGlobals };
