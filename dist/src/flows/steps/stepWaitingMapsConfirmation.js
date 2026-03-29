"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWaitingMapsConfirmation = handleWaitingMapsConfirmation;
const state_1 = require("../../types/state");
const flowHelpers_1 = require("../utils/flowHelpers");
const addressValidator_1 = require("../../services/addressValidator");
const messageTemplates_1 = require("../../utils/messageTemplates");
const pricing_1 = require("../utils/pricing");
const logger_1 = __importDefault(require("../../utils/logger"));
/**
 * WAITING_MAPS_CONFIRMATION step
 *
 * Triggered when Google Maps could NOT verify the client's address.
 * The bot asked: "¿Está bien escrita así? [address]. Respondé sí o pasame la corrección."
 *
 * - Client says "sí" → pause + alert admin to verify manually
 * - Client corrects the address → re-parse and re-validate via Maps
 * - 2 failed attempts → pause + alert admin
 */
async function handleWaitingMapsConfirmation(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;
    const isConfirmation = /^(si|sí|sisi|ok|dale|bueno|joya|de una|perfecto|correcto|esta bien|está bien|esa es|asi es|así es)[\s\?\!\.]*$/i.test(normalizedText);
    const isNegation = /^(no|nop|nope|nel|na|negativo)[\s\?\!\.]*$/i.test(normalizedText);
    if (isConfirmation) {
        // Client confirms the unverified address — pause and alert admin for manual verification
        logger_1.default.info(`[MAPS-CONFIRM] User ${userId} confirmed unverified address. Pausing for admin review.`);
        // Build the order before pausing
        const addr = currentState.partialAddress || {};
        if (!currentState.cart || currentState.cart.length === 0) {
            const product = currentState.selectedProduct;
            if (product) {
                const plan = currentState.selectedPlan || "60";
                const price = currentState.price || (0, pricing_1._getPrice)(product, plan);
                currentState.cart = [{ product, plan, price }];
            }
        }
        currentState.pendingOrder = { ...addr, calleOriginal: addr.calleOriginal || addr.calle, cart: currentState.cart };
        const subtotal = currentState.cart.reduce((sum, i) => sum + parseInt(i.price.toString().replace(/\./g, '')), 0);
        const adicional = currentState.adicionalMAX || 0;
        const total = subtotal + adicional;
        currentState.totalPrice = total.toLocaleString('es-AR').replace(/,/g, '.');
        await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, `📍 Dirección NO verificada en Google Maps, pero el cliente confirma que es correcta.\n` +
            `Dirección: ${addr.calle}, ${addr.ciudad}, CP ${addr.cp || 'N/A'}\n` +
            `Nombre: ${addr.nombre || 'N/A'}\n` +
            `⚠️ Verificar manualmente antes de enviar.`);
        return { matched: true };
    }
    if (isNegation) {
        // Client says "no", go back to waiting_data to collect corrected address
        const goBackMsg = `¡Dale! Pasame la dirección corregida entonces 📝`;
        currentState.history.push({ role: 'bot', content: goBackMsg, timestamp: Date.now() });
        currentState.partialAddress.calle = null;
        (0, flowHelpers_1._setStep)(currentState, state_1.FlowStep.WAITING_DATA);
        saveState(userId);
        await sendMessageWithDelay(userId, goBackMsg);
        return { matched: true };
    }
    // The client sent something else — try to parse it as a corrected address
    const looksLikeAddress = text.length > 5 && (/\d/.test(text) ||
        /\b(calle|av|avenida|barrio|mz|lote|piso|dpto|depto|departamento|casa|block|manzana|localidad|provincia|pcia|código postal)\b/i.test(text));
    if (looksLikeAddress) {
        // Try to parse as a new address and re-validate with Maps
        logger_1.default.info(`[MAPS-CONFIRM] User ${userId} sent what looks like a corrected address: "${text}"`);
        const data = await (dependencies.mockAiService || aiService).parseAddress(text);
        if (data && !data._error && data.calle) {
            // Update the partial address with the correction
            if (data.calle)
                currentState.partialAddress.calle = data.calle;
            if (data.ciudad)
                currentState.partialAddress.ciudad = data.ciudad;
            if (data.cp)
                currentState.partialAddress.cp = data.cp;
            if (data.nombre)
                currentState.partialAddress.nombre = data.nombre;
            const addr = currentState.partialAddress;
            const fullAddress = `${addr.calle}, ${addr.ciudad}${addr.cp ? `, ${addr.cp}` : ''}, Argentina`;
            // Re-validate with Maps
            const mapsResult = await (0, addressValidator_1.validateWithGoogleMaps)(fullAddress);
            if (mapsResult.valid === true && mapsResult.formatted) {
                // Maps found it now! Proceed to confirmation
                logger_1.default.info(`[MAPS-CONFIRM] Corrected address verified: "${mapsResult.formatted}"`);
                currentState.mapsFormattedAddress = mapsResult.formatted;
                if (!currentState.cart || currentState.cart.length === 0) {
                    const product = currentState.selectedProduct;
                    if (product) {
                        const plan = currentState.selectedPlan || "60";
                        const price = currentState.price || (0, pricing_1._getPrice)(product, plan);
                        currentState.cart = [{ product, plan, price }];
                    }
                }
                currentState.pendingOrder = { ...addr, calleOriginal: addr.calleOriginal || addr.calle, cart: currentState.cart };
                currentState.partialAddress = {};
                const subtotal = currentState.cart.reduce((sum, i) => sum + parseInt(i.price.toString().replace(/\./g, '')), 0);
                const adicional = currentState.adicionalMAX || 0;
                const total = subtotal + adicional;
                currentState.totalPrice = total.toLocaleString('es-AR').replace(/,/g, '.');
                const summaryMsg = (0, messageTemplates_1.buildConfirmationMessage)(currentState);
                currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
                currentState.fieldReaskCount = {};
                currentState.addressIssueType = null;
                currentState.addressIssueTries = 0;
                (0, flowHelpers_1._setStep)(currentState, state_1.FlowStep.WAITING_FINAL_CONFIRMATION);
                saveState(userId);
                await sendMessageWithDelay(userId, summaryMsg);
                return { matched: true };
            }
            else {
                // Maps still can't find it — ask again or escalate
                const attempts = (currentState.addressAttempts || 0) + 1;
                currentState.addressAttempts = attempts;
                if (attempts >= 2) {
                    await (0, flowHelpers_1._pauseAndAlert)(userId, currentState, dependencies, text, `📍 Dirección no verificable en Google Maps después de 2 correcciones del cliente.\n` +
                        `Última dirección: ${addr.calle}, ${addr.ciudad}, CP ${addr.cp || 'N/A'}\n` +
                        `⚠️ Intervención manual requerida.`);
                    return { matched: true };
                }
                const retryMsg = `Seguimos sin poder verificar esa dirección 🤔\n\n¿Me la podés pasar de nuevo con todos los datos? Nombre de calle, número, localidad y código postal 📍`;
                currentState.history.push({ role: 'bot', content: retryMsg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, retryMsg);
                return { matched: true };
            }
        }
    }
    // Fallback: unrecognized input — ask to confirm or correct
    const fallbackMsg = `¿La dirección que te pasé es correcta? Respondé *sí* si está bien, o pasame la dirección corregida 🙏`;
    currentState.history.push({ role: 'bot', content: fallbackMsg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, fallbackMsg);
    return { matched: true };
}
