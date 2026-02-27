async function handleAdminSteps(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, saveState } = dependencies;
    const msg = `Estamos revisando tu pedido, te confirmo en breve 😊`;
    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
    await sendMessageWithDelay(userId, msg);
    saveState(userId);
    return { matched: true };
}

module.exports = { handleAdminSteps };
