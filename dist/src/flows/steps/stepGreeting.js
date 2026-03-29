"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGreeting = handleGreeting;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const whatsapp_web_js_1 = require("whatsapp-web.js");
const messages_1 = require("../utils/messages");
const flowHelpers_1 = require("../utils/flowHelpers");
const logger_1 = __importDefault(require("../../utils/logger"));
async function handleGreeting(userId, text, currentState, knowledge, dependencies) {
    const { client, sendMessageWithDelay, saveState } = dependencies;
    // We defer requiring processSalesFlow to prevent circular dependency issues
    const { processSalesFlow } = require('../salesFlow');
    // --- CHECK: Manual greeting already sent by admin ---
    const existingHistory = currentState.history || [];
    const hasManualGreeting = existingHistory.some(m => m.role === 'bot' &&
        (m.content.includes('Buscás bajar hasta 10 kg') ||
            m.content.includes('Cuántos kilos buscás bajar') ||
            m.content.includes('cuántos kilos buscás bajar')));
    if (hasManualGreeting) {
        logger_1.default.info(`[GREETING] Manual greeting detected for ${userId}, skipping to waiting_weight.`);
        (0, flowHelpers_1._setStep)(currentState, 'waiting_weight');
        saveState(userId);
        // Defer to salesFlow to avoid circular promise loops
        const fakeUserStateMap = { [userId]: currentState };
        await processSalesFlow(userId, text, fakeUserStateMap, knowledge, dependencies);
        return { matched: true };
    }
    // --- CHECK: Ad Interaction ---
    if (text.trim() === 'Hola! (Vengo de un anuncio)') {
        logger_1.default.info(`[GREETING] Ad trigger detected for ${userId}. Sending full greeting.`);
        // Fall through to the normal greeting logic below (don't return early)
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
    const rawGreetMsg = (0, messages_1._formatMessage)(knowledge.flow.greeting.response, currentState);
    let greetingPart1 = rawGreetMsg;
    let greetingPart2 = null;
    const splitIndex = rawGreetMsg.lastIndexOf('Para recomendarte bien:');
    if (splitIndex !== -1) {
        greetingPart1 = rawGreetMsg.substring(0, splitIndex).trim();
        greetingPart2 = rawGreetMsg.substring(splitIndex).trim();
    }
    else {
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
                const localPath = path_1.default.join(__dirname, '../../../public', relativePath);
                if (fs_1.default.existsSync(localPath)) {
                    media = whatsapp_web_js_1.MessageMedia.fromFilePath(localPath);
                }
                else {
                    logger_1.default.error(`[GREETING] Gallery image not found at: ${localPath}`);
                }
            }
            else {
                media = new whatsapp_web_js_1.MessageMedia(greetingNode.imageMimetype || 'image/jpeg', greetingNode.image, greetingNode.imageFilename || 'welcome.jpg');
            }
            if (media) {
                await client.sendMessage(userId, media, { caption: '' });
                logger_1.default.info(`[GREETING] Image sent to ${userId} from knowledge config`);
            }
        }
    }
    catch (e) {
        logger_1.default.error('[GREETING] Failed to send image:', e.message);
    }
    // 3. Send Question Part THIRD
    if (greetingPart2) {
        currentState.history.push({ role: 'bot', content: greetingPart2, timestamp: Date.now() });
        await sendMessageWithDelay(userId, greetingPart2);
    }
    (0, flowHelpers_1._setStep)(currentState, knowledge.flow.greeting.nextStep);
    saveState(userId);
    return { matched: true };
}
