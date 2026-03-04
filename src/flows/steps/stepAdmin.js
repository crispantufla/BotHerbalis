const { pauseUser } = require('../../services/pauseService');

async function handleAdminSteps(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { saveState } = dependencies;

    // Pedido pendiente de validación manual — el bot se mantiene completamente en silencio.
    // pauseUser maneja debounce, DB y in-memory en un solo lugar.
    await pauseUser(userId, '⌛ Pedido pendiente de validación', { sharedState: dependencies.sharedState });

    // Guardamos el mensaje del usuario en el historial pero NO respondemos nada.
    currentState.history.push({ role: 'user', content: text, timestamp: Date.now() });
    saveState(userId);

    return { matched: true, paused: true };
}

module.exports = { handleAdminSteps };
