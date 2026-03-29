"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleMediaGlobals = handleMediaGlobals;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const whatsapp_web_js_1 = require("whatsapp-web.js");
const gallery_1 = require("../utils/gallery");
const logger_1 = __importDefault(require("../../utils/logger"));
/**
 * globalMedia — Handles photo/media requests ONLY.
 * Migrated from globalFaq.js to preserve photo gallery functionality
 * without the FAQ interceptors and step redirects that caused double responses.
 */
async function handleMediaGlobals(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, client, saveState } = dependencies;
    // Photos Request
    const PHOTOS_REGEX = /\b(foto|fotos|imagen|imagenes|ver\s*producto|ver\s*fotos)\b/i;
    if (!PHOTOS_REGEX.test(normalizedText))
        return null;
    logger_1.default.info(`[GLOBAL-MEDIA] User ${userId} requested photos.`);
    const gallery = (0, gallery_1._getGallery)();
    let targetCategory = null;
    if (normalizedText.includes('capsula'))
        targetCategory = 'capsulas';
    else if (normalizedText.includes('semilla'))
        targetCategory = 'semillas';
    else if (normalizedText.includes('gota'))
        targetCategory = 'gotas';
    else if (currentState.selectedProduct) {
        if (currentState.selectedProduct.toLowerCase().includes('capsula'))
            targetCategory = 'capsulas';
        if (currentState.selectedProduct.toLowerCase().includes('semilla'))
            targetCategory = 'semillas';
        if (currentState.selectedProduct.toLowerCase().includes('gota'))
            targetCategory = 'gotas';
    }
    if (targetCategory) {
        const cat = targetCategory; // narrow for closure
        const productImages = gallery.filter(img => (img.category && img.category.toLowerCase().includes(cat)) ||
            (img.tags && img.tags.some(t => t.toLowerCase().includes(cat))));
        if (productImages.length > 0) {
            const introMsg = `Acá tenés fotos de nuestras ${targetCategory} 👇`;
            currentState.history.push({ role: 'bot', content: introMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, introMsg);
            const shuffled = productImages.sort(() => 0.5 - Math.random()).slice(0, 3);
            for (const img of shuffled) {
                try {
                    const relativePath = img.url.replace(/^\//, '');
                    const localPath = path_1.default.join(__dirname, '../../../public', relativePath);
                    if (fs_1.default.existsSync(localPath)) {
                        const media = whatsapp_web_js_1.MessageMedia.fromFilePath(localPath);
                        await client.sendMessage(userId, media);
                        currentState.history.push({ role: 'bot', content: `[Imagen adjunta: ${targetCategory}]`, timestamp: Date.now() });
                    }
                }
                catch (e) {
                    logger_1.default.error('Error sending gallery image:', e);
                }
            }
            saveState(userId);
            // NO step redirect here — the AI will naturally re-ask if needed
        }
        else {
            await sendMessageWithDelay(userId, 'Uh, justo no tengo fotos cargadas de ese producto en este momento. 😅');
        }
    }
    else {
        const msg = 'Tenemos fotos de Cápsulas, Semillas y Gotas. ¿De cuál te gustaría ver? 📸';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
    }
    return { matched: true };
}
