"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAdminSteps = handleAdminSteps;
const pauseService_1 = require("../../services/pauseService");
async function handleAdminSteps(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { saveState } = dependencies;
    // Pedido pendiente de validación manual — el bot se mantiene completamente en silencio.
    // pauseUser maneja debounce, DB y in-memory en un solo lugar.
    await (0, pauseService_1.pauseUser)(userId, '⌛ Pedido pendiente de validación', { sharedState: dependencies.sharedState });
    // El mensaje del usuario ya fue guardado en salesFlow.ts, no lo duplicamos.
    saveState(userId);
    return { matched: true, paused: true };
}
