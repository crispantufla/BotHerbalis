const path = require('path');
const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const { _formatMessage } = require('../utils/messages');
const { _setStep } = require('../utils/flowHelpers');

async function handleGreeting(userId, text, currentState, knowledge, dependencies) {
    const { client, sendMessageWithDelay, saveState } = dependencies;
    // We defer requiring processSalesFlow to prevent circular dependency issues
    const { processSalesFlow } = require('../salesFlow');

    // --- CHECK: Manual greeting already sent by admin ---
    const existingHistory = currentState.history || [];
    const hasManualGreeting = existingHistory.some(m =>
        m.role === 'bot' &&
        (m.content.includes('Buscás bajar hasta 10 kg') ||
            m.content.includes('Cuántos kilos buscás bajar') ||
            m.content.includes('cuántos kilos buscás bajar'))
    );

    if (hasManualGreeting) {
        console.log(`[GREETING] Manual greeting detected for ${userId}, skipping to waiting_weight.`);
        _setStep(currentState, 'waiting_weight');
        saveState(userId);

        // Let the caller (salesFlow.js) know it should yield/continue the recursive call, 
        // to avoid circular promise loops, it's safer to just set the state and let the caller re-run or we can run it here
        const fakeUserStateMap = { [userId]: currentState };
        return await processSalesFlow(userId, text, fakeUserStateMap, knowledge, dependencies);
    }

    // --- CHECK: Ad Interaction (User manual push) ---
    // If the message is exactly the ad trigger, the user implies they are sending it on behalf of the customer
    // The bot should simply acknowledge the state change without sending an explicit response yet.
    if (text.trim() === 'Hola! (Vengo de un anuncio)') {
        console.log(`[GREETING] Ad trigger detected for ${userId}. Skipping auto-greeting.`);
        _setStep(currentState, knowledge.flow.greeting.nextStep);
        saveState(userId);
        return { matched: true };
    }

    // --- METRICS TRACKING ---
    const trackScript = dependencies.effectiveScript || dependencies.config?.activeScript || 'v3';
    if (dependencies.config && dependencies.config.scriptStats && trackScript !== 'rotacion') {
        if (!dependencies.config.scriptStats[trackScript]) {
            dependencies.config.scriptStats[trackScript] = { started: 0, completed: 0 };
        }
        dependencies.config.scriptStats[trackScript].started++;
    }

    // 1. Send Text FIRST (Presentation part)
    const rawGreetMsg = _formatMessage(knowledge.flow.greeting.response, currentState);

    // Attempt to split the greeting naturally if it contains the question at the end
    let greetingPart1 = rawGreetMsg;
    let greetingPart2 = null;

    const splitIndex = rawGreetMsg.lastIndexOf('Para recomendarte bien:');
    if (splitIndex !== -1) {
        greetingPart1 = rawGreetMsg.substring(0, splitIndex).trim();
        greetingPart2 = rawGreetMsg.substring(splitIndex).trim();
    } else {
        const splitIndexAlt = rawGreetMsg.lastIndexOf('¿Cuántos kilos');
        if (splitIndexAlt !== -1) {
            greetingPart1 = rawGreetMsg.substring(0, splitIndexAlt).trim();
            greetingPart2 = rawGreetMsg.substring(splitIndexAlt).trim();
        }
    }

    currentState.history.push({ role: 'bot', content: greetingPart1, timestamp: Date.now() });
    await sendMessageWithDelay(userId, greetingPart1);

    // 2. Send Image SECOND (if configured)
    try {
        const greetingNode = knowledge.flow.greeting;
        if (greetingNode && greetingNode.image && greetingNode.imageEnabled) {
            let media;
            if (greetingNode.image.startsWith('/media/')) {
                const relativePath = greetingNode.image.replace(/^\//, '');
                const localPath = path.join(__dirname, '../../../public', relativePath);
                if (fs.existsSync(localPath)) {
                    media = MessageMedia.fromFilePath(localPath);
                } else {
                    console.error(`[GREETING] Gallery image not found at: ${localPath}`);
                }
            } else {
                media = new MessageMedia(
                    greetingNode.imageMimetype || 'image/jpeg',
                    greetingNode.image,
                    greetingNode.imageFilename || 'welcome.jpg'
                );
            }

            if (media) {
                await client.sendMessage(userId, media, { caption: '' });
                console.log(`[GREETING] Image sent to ${userId} from knowledge config`);
            }
        }
    } catch (e) {
        console.error('[GREETING] Failed to send image:', e.message);
    }

    // 3. Send Question Part THIRD
    if (greetingPart2) {
        currentState.history.push({ role: 'bot', content: greetingPart2, timestamp: Date.now() });
        await sendMessageWithDelay(userId, greetingPart2);
    }

    _setStep(currentState, knowledge.flow.greeting.nextStep);
    saveState(userId);

    return { matched: true };
}

module.exports = { handleGreeting };
