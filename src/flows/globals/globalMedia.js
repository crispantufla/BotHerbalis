const path = require('path');
const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const { _getGallery } = require('../utils/gallery');

/**
 * globalMedia — Handles photo/media requests ONLY.
 * Migrated from globalFaq.js to preserve photo gallery functionality
 * without the FAQ interceptors and step redirects that caused double responses.
 */
async function handleMediaGlobals(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, client, saveState } = dependencies;

    // Photos Request
    const PHOTOS_REGEX = /\b(foto|fotos|imagen|imagenes|ver\s*producto|ver\s*fotos)\b/i;
    if (!PHOTOS_REGEX.test(normalizedText)) return null;

    console.log(`[GLOBAL-MEDIA] User ${userId} requested photos.`);
    const gallery = _getGallery();
    let targetCategory = null;

    if (normalizedText.includes('capsula')) targetCategory = 'capsulas';
    else if (normalizedText.includes('semilla')) targetCategory = 'semillas';
    else if (normalizedText.includes('gota')) targetCategory = 'gotas';
    else if (currentState.selectedProduct) {
        if (currentState.selectedProduct.toLowerCase().includes('capsula')) targetCategory = 'capsulas';
        if (currentState.selectedProduct.toLowerCase().includes('semilla')) targetCategory = 'semillas';
        if (currentState.selectedProduct.toLowerCase().includes('gota')) targetCategory = 'gotas';
    }

    if (targetCategory) {
        const productImages = gallery.filter(img =>
            (img.category && img.category.toLowerCase().includes(targetCategory)) ||
            (img.tags && img.tags.some(t => t.toLowerCase().includes(targetCategory)))
        );

        if (productImages.length > 0) {
            const shuffled = productImages.sort(() => 0.5 - Math.random()).slice(0, 3);
            await sendMessageWithDelay(userId, `Acá tenés fotos de nuestras ${targetCategory} 👇`);

            for (const img of shuffled) {
                try {
                    const relativePath = img.url.replace(/^\//, '');
                    const localPath = path.join(__dirname, '../../../public', relativePath);
                    if (fs.existsSync(localPath)) {
                        const media = MessageMedia.fromFilePath(localPath);
                        await client.sendMessage(userId, media);
                    }
                } catch (e) { console.error('Error sending gallery image:', e); }
            }

            // NO step redirect here — the AI will naturally re-ask if needed
        } else {
            await sendMessageWithDelay(userId, "Uh, justo no tengo fotos cargadas de ese producto en este momento. 😅");
        }
    } else {
        const msg = "Tenemos fotos de Cápsulas, Semillas y Gotas. ¿De cuál te gustaría ver? 📸";
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
    }

    return { matched: true };
}

module.exports = { handleMediaGlobals };
