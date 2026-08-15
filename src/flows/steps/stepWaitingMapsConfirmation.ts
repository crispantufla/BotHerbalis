import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _startsAffirmative } from '../utils/flowHelpers';
import { validateWithGoogleMaps } from '../../services/addressValidator';
import { buildConfirmationMessage } from '../../utils/messageTemplates';
import { _getPrice } from '../utils/pricing';
import { calculateTotal } from '../utils/cartHelpers';
import { _isDuplicate } from '../utils/messages';
import logger from '../../utils/logger';

/**
 * WAITING_MAPS_CONFIRMATION step
 * 
 * Triggered when Google Maps could NOT verify the client's address.
 * The bot asked: "¿La dirección que te he puesto es correcta? Responde *sí* si está bien, o pásame la corregida."
 * 
 * - Client says "sí" → pause + alert admin to verify manually
 * - Client corrects the address → re-parse and re-validate via Maps
 * - 2 failed attempts → pause + alert admin
 */
export async function handleWaitingMapsConfirmation(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    const looksLikeAddress = text.length > 5 && (
        /\d/.test(text) ||
        /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana|localidad|provincia|pcia|código postal)\b/i.test(text)
    );

    const isConfirmation = /^(si|sí|sisi|ok|dale|bueno|joya|de una|perfecto|correcto|esta bien|está bien|esa es|asi es|así es)[\s\?\!\.]*$/i.test(normalizedText)
        // "Sí" al frente + cola de texto (típicamente una pregunta que globalFaq
        // ya respondió vía passthrough): "Si, es correcta ¿cuánto tarda en
        // llegar?". No cuenta si trae corrección ("pero...") o pinta de
        // dirección — esos van al re-parseo de abajo. _startsAffirmative
        // descarta el "si" condicional ("y si tarda mucho?").
        || (_startsAffirmative(text) && !looksLikeAddress && !/\bpero\b/.test(normalizedText));
    const isNegation = /^(no|nop|nope|nel|na|negativo)[\s\?\!\.]*$/i.test(normalizedText);

    if (isConfirmation) {
        // Client confirms the unverified address — pause and alert admin for manual verification
        logger.info(`[MAPS-CONFIRM] User ${userId} confirmed unverified address. Pausing for admin review.`);

        // Build the order before pausing
        const addr = currentState.partialAddress || {};
        if (!currentState.cart || currentState.cart.length === 0) {
            const product = currentState.selectedProduct;
            if (product) {
                const plan = currentState.selectedPlan || "60";
                const price = _getPrice(product, plan); // F2: precio SIEMPRE coherente con el plan (no usar un currentState.price viejo)
                currentState.cart = [{ product, plan, price }];
            }
        }

        currentState.pendingOrder = { ...addr, calleOriginal: addr.calleOriginal || addr.calle, cart: currentState.cart };

        // El total lo suma calculateTotal (céntimos por dentro, euros al salir).
        // La cuenta a mano que había aquí quitaba los puntos y hacía parseInt:
        // con pesos "49.900" daba 49900, pero con euros "49,90" da 49 — el bot
        // cobraba cuarenta y nueve euros pelados.
        currentState.totalPrice = calculateTotal(currentState);

        await _pauseAndAlert(userId, currentState, dependencies, text,
            `📍 Dirección NO verificada en Google Maps, pero el cliente confirma que es correcta.\n` +
            `Dirección: ${addr.calle}, ${addr.ciudad}, CP ${addr.cp || 'N/A'}\n` +
            `Nombre: ${addr.nombre || 'N/A'}\n` +
            `⚠️ Verificar manualmente antes de enviar.`
        );
        return { matched: true };
    }

    if (isNegation) {
        // Client says "no", go back to waiting_data to collect corrected address
        const goBackMsg = `¡Vale! Pásame entonces la dirección corregida 📝`;
        currentState.history.push({ role: 'bot', content: goBackMsg, timestamp: Date.now() });
        currentState.partialAddress.calle = null;
        _setStep(currentState, FlowStep.WAITING_DATA);
        saveState(userId);
        await sendMessageWithDelay(userId, goBackMsg);
        return { matched: true };
    }

    // The client sent something else — try to parse it as a corrected address
    if (looksLikeAddress) {
        // Try to parse as a new address and re-validate with Maps
        logger.info(`[MAPS-CONFIRM] User ${userId} sent what looks like a corrected address: "${text}"`);
        const data = await (dependencies.mockAiService || aiService).parseAddress(text);

        if (data && !data._error && data.calle) {
            // Update the partial address with the correction
            if (data.calle) currentState.partialAddress.calle = data.calle;
            if (data.ciudad) currentState.partialAddress.ciudad = data.ciudad;
            if (data.cp) currentState.partialAddress.cp = data.cp;
            if (data.nombre) currentState.partialAddress.nombre = data.nombre;

            const addr = currentState.partialAddress;
            const fullAddress = `${addr.calle}, ${addr.ciudad}${addr.cp ? `, ${addr.cp}` : ''}, España`;

            // Re-validate with Maps
            const mapsResult = await validateWithGoogleMaps(fullAddress);

            if (mapsResult.valid === true && mapsResult.formatted) {
                // Maps found it now! Proceed to confirmation
                logger.info(`[MAPS-CONFIRM] Corrected address verified: "${mapsResult.formatted}"`);
                currentState.mapsFormattedAddress = mapsResult.formatted;

                if (!currentState.cart || currentState.cart.length === 0) {
                    const product = currentState.selectedProduct;
                    if (product) {
                        const plan = currentState.selectedPlan || "60";
                        const price = _getPrice(product, plan); // F2: precio SIEMPRE coherente con el plan (no usar un currentState.price viejo)
                        currentState.cart = [{ product, plan, price }];
                    }
                }

                currentState.pendingOrder = { ...addr, calleOriginal: addr.calleOriginal || addr.calle, cart: currentState.cart };
                currentState.partialAddress = {} as any;

                currentState.totalPrice = calculateTotal(currentState);

                const summaryMsg = buildConfirmationMessage(currentState, knowledge);
                currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
                currentState.fieldReaskCount = {};
                currentState.addressIssueType = null;
                currentState.addressIssueTries = 0;
                _setStep(currentState, FlowStep.WAITING_FINAL_CONFIRMATION);
                saveState(userId);
                await sendMessageWithDelay(userId, summaryMsg);
                return { matched: true };
            } else {
                // Maps still can't find it — ask again or escalate
                const attempts = (currentState.addressAttempts || 0) + 1;
                currentState.addressAttempts = attempts;

                if (attempts >= 2) {
                    await _pauseAndAlert(userId, currentState, dependencies, text,
                        `📍 Dirección no verificable en Google Maps después de 2 correcciones del cliente.\n` +
                        `Última dirección: ${addr.calle}, ${addr.ciudad}, CP ${addr.cp || 'N/A'}\n` +
                        `⚠️ Intervención manual requerida.`
                    );
                    return { matched: true };
                }

                const retryMsg = `Seguimos sin poder verificar esa dirección 🤔\n\n¿Me la puedes pasar otra vez con todos los datos? Calle, número, piso, población y código postal 📍`;
                currentState.history.push({ role: 'bot', content: retryMsg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, retryMsg);
                return { matched: true };
            }
        }
    }

    // Fallback: unrecognized input — ask to confirm or correct
    const fallbackMsg = `¿La dirección que te he puesto es correcta? Responde *sí* si está bien, o pásame la corregida 🙏`;
    currentState.history.push({ role: 'bot', content: fallbackMsg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, fallbackMsg);
    return { matched: true };
}
