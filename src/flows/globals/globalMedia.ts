import path from 'path';
import fs from 'fs';
import { UserState } from '../../types/state';
import { MessageMedia } from 'whatsapp-web.js';
import { _getGallery } from '../utils/gallery';
import logger from '../../utils/logger';

interface GalleryImage {
    url: string;
    category?: string;
    tags?: string[];
}

interface MediaDependencies {
    sendMessageWithDelay: (chatId: string, content: string) => Promise<void>;
    client: any;
    saveState: (userId: string) => void;
}

/**
 * globalMedia — Handles photo/media requests ONLY.
 * Migrated from globalFaq.js to preserve photo gallery functionality
 * without the FAQ interceptors and step redirects that caused double responses.
 */
export async function handleMediaGlobals(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: MediaDependencies
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, client, saveState } = dependencies;

    // Photos Request
    const PHOTOS_REGEX = /\b(foto|fotos|imagen|imagenes|ver\s*producto|ver\s*fotos)\b/i;
    if (!PHOTOS_REGEX.test(normalizedText)) return null;

    logger.info(`[GLOBAL-MEDIA] User ${userId} requested photos.`);
    const gallery: GalleryImage[] = _getGallery();
    let targetCategory: string | null = null;

    if (normalizedText.includes('capsula')) targetCategory = 'capsulas';
    else if (normalizedText.includes('semilla')) targetCategory = 'semillas';
    else if (normalizedText.includes('gota')) targetCategory = 'gotas';
    else if (currentState.selectedProduct) {
        if (currentState.selectedProduct.toLowerCase().includes('capsula')) targetCategory = 'capsulas';
        if (currentState.selectedProduct.toLowerCase().includes('semilla')) targetCategory = 'semillas';
        if (currentState.selectedProduct.toLowerCase().includes('gota')) targetCategory = 'gotas';
    }

    if (targetCategory) {
        const cat = targetCategory; // narrow for closure
        const productImages = gallery.filter(img =>
            (img.category && img.category.toLowerCase().includes(cat)) ||
            (img.tags && img.tags.some(t => t.toLowerCase().includes(cat)))
        );

        if (productImages.length > 0) {
            const introMsg = `Acá tenés fotos de nuestras ${targetCategory} 👇`;
            currentState.history.push({ role: 'bot', content: introMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, introMsg);

            const shuffled = productImages.sort(() => 0.5 - Math.random()).slice(0, 3);
            for (const img of shuffled) {
                try {
                    const relativePath = img.url.replace(/^\//, '');
                    const localPath = path.join(__dirname, '../../../public', relativePath);
                    if (fs.existsSync(localPath)) {
                        const media = MessageMedia.fromFilePath(localPath);
                        await client.sendMessage(userId, media);
                        currentState.history.push({ role: 'bot', content: `[Imagen adjunta: ${targetCategory}]`, timestamp: Date.now() });
                    }
                } catch (e) { logger.error('Error sending gallery image:', e); }
            }
            saveState(userId);
            // NO step redirect here — the AI will naturally re-ask if needed
        } else {
            // Loguear como cualquier otro mensaje enviado (invariante del dashboard:
            // todo lo que sale queda en history) — antes se enviaba sin registrar.
            const noPhotosMsg = 'Uh, justo no tengo fotos cargadas de ese producto en este momento. 😅';
            currentState.history.push({ role: 'bot', content: noPhotosMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, noPhotosMsg);
        }
    } else {
        const msg = 'Tenemos fotos de Cápsulas, Semillas y Gotas. ¿De cuál te gustaría ver? 📸';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
    }

    return { matched: true };
}
