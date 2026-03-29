"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processGlobals = processGlobals;
const globalSystem_1 = require("./globalSystem");
const globalSafety_1 = require("./globalSafety");
const globalMedia_1 = require("./globalMedia");
async function processGlobals(userId, text, normalizedText, currentState, knowledge, dependencies) {
    let result;
    result = await (0, globalSystem_1.handleSystemGlobals)(userId, text, normalizedText, currentState, dependencies);
    if (result && result.matched)
        return result;
    result = await (0, globalSafety_1.handleSafetyCheck)(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (result && result.matched)
        return result;
    // Media requests (photos) — handled globally for any step
    result = await (0, globalMedia_1.handleMediaGlobals)(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (result && result.matched)
        return result;
    // FAQ questions (payment, shipping, how-to-take, etc.) are now handled
    // by the AI naturally within each step handler — no more global interceptors.
    return null; // Not matched by any global interceptor
}
