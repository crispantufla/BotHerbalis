const path = require('path');
const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const { _getStepRedirect, _formatMessage } = require('../utils/messages');
const { _getGallery } = require('../utils/gallery');
const { _setStep } = require('../utils/flowHelpers');

async function handleFaqGlobals(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, client, saveState } = dependencies;

    // Delivery Constraints
    const DAYS_REGEX = /lunes|martes|miercoles|jueves|viernes|sabado|domingo|fin de semana|finde/i;
    const AVAILABILITY_REGEX = /estoy|estar.|voy a estar|puedo|recib|estaré/i;
    if (DAYS_REGEX.test(normalizedText) && AVAILABILITY_REGEX.test(normalizedText)) {
        const deliveryMsg1 = "Mirá, te comento que enviamos por Correo Argentino 📦. La demora promedio es de 7 a 10 días hábiles y lamentablemente el correo NO trabaja los findes.";
        const deliveryMsg2 = "Nosotros no podemos pedirles a ellos a qué hora pasar, pero tranqui: Si justo no estás, el correo te deja un aviso para que lo retires en la sucursal más cercana con tu DNI 😉";

        currentState.history.push({ role: 'bot', content: deliveryMsg1, timestamp: Date.now() });
        await sendMessageWithDelay(userId, deliveryMsg1);

        currentState.history.push({ role: 'bot', content: deliveryMsg2, timestamp: Date.now() });
        await sendMessageWithDelay(userId, deliveryMsg2);

        const redirect = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
            await sendMessageWithDelay(userId, redirect);
        }
        return { matched: true };
    }

    // Payment Method Check
    const PAYMENT_REGEX = /\b(tarjeta|credito|crédito|debito|débito|transferencia|mercadopago|mercado\s*pago|visa|mastercard|rapipago|pago\s*facil|pago\s*fácil|pagofacil|billetera|virtual|nequi|uala|ualá|cuenta\s*bancaria|cbu|alias|deposito|depósito)\b/i;
    if (PAYMENT_REGEX.test(normalizedText)) {
        const paymentMsg = "Te cuento, el pago es únicamente en efectivo al recibir el pedido en tu casa 😊";
        const paymentMsg2 = "El cartero te lo entrega y ahí mismo abonás. Cero riesgos por transferencia.\n\n¿Te gustaría continuar entonces?";

        currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, paymentMsg);

        currentState.history.push({ role: 'bot', content: paymentMsg2, timestamp: Date.now() });
        await sendMessageWithDelay(userId, paymentMsg2);

        const redirect = _getStepRedirect(currentState.step, currentState);
        if (redirect) {
            currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
            await sendMessageWithDelay(userId, redirect);
        }
        return { matched: true };
    }

    // Como se toman interceptor
    const COMO_SE_TOMAN_REGEX = /\b(como se toman|como lo tomo|como se toma|como se usa)\b/i;
    if (COMO_SE_TOMAN_REGEX.test(normalizedText) && currentState.selectedProduct) {
        let msg = "";
        if (currentState.selectedProduct.includes("Cápsulas")) {
            msg = "💊 **CÁPSULAS:**\nUna al día, media hora antes de tu comida principal (almuerzo o cena, la que sea más abundante o donde tengas más ansiedad), con un vaso de agua.";
        } else if (currentState.selectedProduct.includes("Gotas")) {
            msg = "💧 **GOTAS:**\n**Semana 1:** 10 gotas al día, media hora antes de la comida principal con un vaso de agua.\n**Semana 2 en adelante:** Podés tomarlas antes del almuerzo o cena, ajustando según cómo vayas perdiendo peso y ansiedad.";
        } else {
            msg = "🌿 **SEMILLAS:**\nPara la primera semana, partís una nuez en 8 pedacitos. Las demás van a ser en 4.\nCada noche hervís un pedacito 5 minutos. Cuando se enfría, te tomás el agua junto con el pedacito antes de dormir. (No tiene gusto a nada)";
        }

        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        const redirect = _getStepRedirect(currentState.step, currentState);
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

                const redirect = _getStepRedirect(currentState.step, currentState);
                if (redirect) {
                    currentState.history.push({ role: 'bot', content: redirect, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, redirect);
                }
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

    // Knowledge FAQ matching
    for (const faq of knowledge.faq) {
        if (faq.keywords.some(k => new RegExp(`\\b${k}\\b`, 'i').test(normalizedText))) {

            if (currentState.step === 'waiting_plan_choice' && /\b(60|120|180|240|300|360|420|480|540|600)\b/.test(normalizedText)) {
                console.log(`[FLOW-PRESERVE] Bypassing FAQ to allow plan selection to process: ${normalizedText}`);
                continue;
            }

            let faqMsg = _formatMessage(faq.response, currentState);
            let targetStep = faq.triggerStep;

            const isPriceFaq = faq.keywords.includes('cuanto sale') || faq.keywords.includes('que precio') || faq.keywords.includes('cuanto cuesta');
            if (isPriceFaq) {
                const hasPassedWeight = currentState.weightGoal ||
                    ['waiting_preference', 'waiting_price_confirmation', 'waiting_plan_choice', 'waiting_data', 'waiting_final_confirmation'].includes(currentState.step);

                if (hasPassedWeight) {
                    faqMsg = "Los tratamientos están entre $37.000 y $69.000,\nsegún duración y formato.\n\n¿Te tomo los datos de envío?";
                    targetStep = null;
                }
            }

            currentState.history.push({ role: 'bot', content: faqMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, faqMsg);

            if (targetStep) {
                _setStep(currentState, targetStep);
                saveState(userId);
            }

            const redirect = _getStepRedirect(currentState.step, currentState);
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
