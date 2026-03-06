import path from 'path';
import fs from 'fs';
import { UserState } from '../../types/state';
const { MessageMedia } = require('whatsapp-web.js');
const { _getStepRedirect, _formatMessage } = require('../utils/messages');
const { _getGallery } = require('../utils/gallery');
const { _setStep } = require('../utils/flowHelpers');

interface GalleryImage {
    url: string;
    category?: string;
    tags?: string[];
}

interface FaqEntry {
    keywords: string[];
    response: string | string[];
    triggerStep?: string;
}

interface FaqDependencies {
    sendMessageWithDelay: (chatId: string, content: string) => Promise<void>;
    client: any;
    saveState: (userId: string) => void;
}

export async function handleFaqGlobals(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: { faq: FaqEntry[] },
    dependencies: FaqDependencies
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, client, saveState } = dependencies;

    // Delivery Constraints
    const DAYS_REGEX = /lunes|martes|miercoles|jueves|viernes|sabado|domingo|fin de semana|finde/i;
    const AVAILABILITY_REGEX = /estoy|estar.|voy a estar|puedo|recib|estaré/i;
    if (DAYS_REGEX.test(normalizedText) && AVAILABILITY_REGEX.test(normalizedText)) {
        const deliveryMsg1 = 'Mirá, te comento que enviamos por Correo Argentino 📦. La demora promedio es de 7 a 10 días hábiles y lamentablemente el correo NO trabaja los findes.';
        const deliveryMsg2 = 'Nosotros no podemos pedirles a ellos a qué hora pasar, pero tranqui: Si justo no estás, el correo te deja un aviso para que lo retires en la sucursal más cercana con tu DNI 😉';

        currentState.history.push({ role: 'bot', content: deliveryMsg1, timestamp: Date.now() });
        await sendMessageWithDelay(userId, deliveryMsg1);

        currentState.history.push({ role: 'bot', content: deliveryMsg2, timestamp: Date.now() });
        await sendMessageWithDelay(userId, deliveryMsg2);

        const redirect: string | null = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
            await sendMessageWithDelay(userId, redirect);
        }
        return { matched: true };
    }

    // Payment Method Check — Two-Phase Logic
    // Phase 1: User is CHOOSING tarjeta/transferencia (→ pause + alert admin)
    const PAYMENT_CHOICE_REGEX = /\b(tarjeta|credito|crédito|debito|débito|transferencia|mercadopago|mercado\s*pago|visa|mastercard|rapipago|pago\s*facil|pago\s*fácil|pagofacil|billetera|virtual|nequi|uala|ualá|cuenta\s*bancaria|cbu|alias|deposito|depósito)\b/i;
    const CHOICE_INTENT_REGEX = /\b(quiero|prefiero|elijo|pago con|pagar con|por tarjeta|por transferencia|con tarjeta|con transferencia|con mercadopago|dale|si|sí|bueno|perfecto|con eso|esa opcion|esa opción)\b/i;

    // Check if the bot's last message was the payment options question
    const lastBotMsg = currentState.history?.filter((h: any) => h.role === 'bot').slice(-1)[0]?.content || '';
    const botJustAskedPayment = lastBotMsg.includes('tarjeta o transferencia al momento de realizar el pedido');

    if (PAYMENT_CHOICE_REGEX.test(normalizedText)) {
        const isChoosingElectronic = CHOICE_INTENT_REGEX.test(normalizedText) || botJustAskedPayment;
        const isChoosingEfectivo = /\b(efectivo|en efectivo|al recibir|contrareembolso|contra\s*reembolso|al cartero|cuando llegue|cuando me llegue)\b/i.test(normalizedText);

        if (isChoosingElectronic && !isChoosingEfectivo) {
            const { isBusinessHours } = require('../../services/timeUtils');
            const { _pauseAndAlert } = require('../utils/flowHelpers');

            let paymentMsg: string;
            if (isBusinessHours()) {
                paymentMsg = 'Perfecto, te derivo al sector donde te tomarán el pedido a pagar con tarjeta 😊';
            } else {
                paymentMsg = 'Se comunicarán con vos a la brevedad 😊';
            }

            currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, paymentMsg);

            await _pauseAndAlert(userId, currentState, dependencies, text,
                `💳 Cliente eligió pagar con tarjeta/transferencia. Derivar al sector de cobros.`);
            return { matched: true };
        }

        // If choosing efectivo, just acknowledge and continue
        if (isChoosingEfectivo) {
            const efectivoMsg = '¡Perfecto! El pago se realiza en efectivo al cartero cuando recibís el paquete en tu casa 😊';
            currentState.history.push({ role: 'bot', content: efectivoMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, efectivoMsg);

            const redirect: string | null = _getStepRedirect(currentState.step, currentState);
            if (redirect) {
                currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
                await sendMessageWithDelay(userId, redirect);
            }
            return { matched: true };
        }

        // Phase 2: General payment question (not a direct choice) — inform about options
        const paymentInfoMsg = 'El pago se puede realizar con tarjeta o transferencia al momento de realizar el pedido, o en efectivo al recibir 😊';
        currentState.history.push({ role: 'bot', content: paymentInfoMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, paymentInfoMsg);

        const redirect: string | null = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
            await sendMessageWithDelay(userId, redirect);
        }
        return { matched: true };
    }

    // Phase 2b: Generic payment question without specific method keywords
    const GENERIC_PAYMENT_REGEX = /\b(como se paga|como pago|formas? de pago|medios? de pago|que pago|metodos? de pago|metodo de pago|medio de pago|forma de pago)\b/i;
    if (GENERIC_PAYMENT_REGEX.test(normalizedText)) {
        const paymentInfoMsg = 'El pago se puede realizar con tarjeta o transferencia al momento de realizar el pedido, o en efectivo al recibir 😊';
        currentState.history.push({ role: 'bot', content: paymentInfoMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, paymentInfoMsg);

        const redirect: string | null = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
            await sendMessageWithDelay(userId, redirect);
        }
        return { matched: true };
    }

    // Como se toman interceptor
    const COMO_SE_TOMAN_REGEX = /\b(como se toman|como lo tomo|como se toma|como se usa)\b/i;
    if (COMO_SE_TOMAN_REGEX.test(normalizedText) && currentState.selectedProduct) {
        let msg = '';
        if (currentState.selectedProduct.includes('Cápsulas')) {
            msg = '💊 **CÁPSULAS:**\nUna al día, media hora antes de tu comida principal (almuerzo o cena, la que sea más abundante o donde tengas más ansiedad), con un vaso de agua.';
        } else if (currentState.selectedProduct.includes('Gotas')) {
            msg = '💧 **GOTAS:**\n**Semana 1:** 10 gotas al día, media hora antes de la comida principal con un vaso de agua.\n**Semana 2 en adelante:** Podés tomarlas antes del almuerzo o cena, ajustando según cómo vayas perdiendo peso y ansiedad.';
        } else {
            msg = '🌿 **SEMILLAS:**\nPara la primera semana, partís una nuez en 8 pedacitos. Las demás van a ser en 4.\nCada noche hervís un pedacito 5 minutos. Cuando se enfría, te tomás el agua junto con el pedacito antes de dormir. (No tiene gusto a nada)';
        }

        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        const redirect: string | null = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
            await sendMessageWithDelay(userId, redirect);
        }
        return { matched: true };
    }

    // Photos Request
    const PHOTOS_REGEX = /\b(foto|fotos|imagen|imagenes|ver\s*producto|ver\s*fotos)\b/i;
    if (PHOTOS_REGEX.test(normalizedText)) {
        console.log(`[GLOBAL] User ${userId} requested photos.`);
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
            const cat = targetCategory; // narrowed type for closure
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
                            // Register the image in history so AI knows it was sent
                            currentState.history.push({ role: 'bot', content: `[Imagen adjunta: ${targetCategory}]`, timestamp: Date.now() });
                        }
                    } catch (e) { console.error('Error sending gallery image:', e); }
                }
                saveState(userId);

                const redirect: string | null = _getStepRedirect(currentState.step, currentState);
                if (redirect) {
                    currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, redirect);
                }
            } else {
                await sendMessageWithDelay(userId, 'Uh, justo no tengo fotos cargadas de ese producto en este momento. 😅');
            }
        } else {
            const msg = 'Tenemos fotos de Cápsulas, Semillas y Gotas. ¿De cuál te gustaría ver? 📸';
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, msg);
        }

        return { matched: true };
    }

    // Knowledge FAQ matching
    for (const faq of knowledge.faq) {
        if (faq.keywords.some(k => new RegExp(`\\b${k}\\b`, 'i').test(normalizedText))) {

            if (currentState.step === 'waiting_plan_choice' && /\b(60|120|180|240|300|360|420|480|540|600)\b/.test(normalizedText)) {
                console.log(`[FLOW-PRESERVE] Bypassing FAQ to allow plan selection to process: ${normalizedText}`);
                continue;
            }

            let faqMsg: string = _formatMessage(faq.response, currentState);
            let targetStep: string | null = faq.triggerStep ?? null;

            const isPriceFaq = faq.keywords.includes('cuanto sale') || faq.keywords.includes('que precio') || faq.keywords.includes('cuanto cuesta');
            if (isPriceFaq) {
                const hasPassedWeight = currentState.weightGoal ||
                    ['waiting_preference', 'waiting_price_confirmation', 'waiting_plan_choice', 'waiting_data', 'waiting_final_confirmation'].includes(currentState.step);

                if (hasPassedWeight) {
                    faqMsg = 'Los tratamientos están entre $37.000 y $69.000,\nsegún duración y formato.\n\n¿Te tomo los datos de envío?';
                    targetStep = null;
                }
            }

            currentState.history.push({ role: 'bot', content: faqMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, faqMsg);

            if (targetStep) {
                _setStep(currentState, targetStep);
                saveState(userId);
            }

            const redirect: string | null = _getStepRedirect(currentState.step, currentState);
            const endsWithQuestion = faqMsg.trim().endsWith('?');

            if (redirect && !targetStep && !endsWithQuestion) {
                currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
                await sendMessageWithDelay(userId, redirect);
            }

            return { matched: true };
        }
    }

    return null;
}

module.exports = { handleFaqGlobals };
