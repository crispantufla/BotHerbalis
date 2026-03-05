const { _isNegative } = require('../utils/validation');
const { _pauseAndAlert, _setStep } = require('../utils/flowHelpers');

async function handleSystemGlobals(userId, text, normalizedText, currentState, dependencies) {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;
    const isNegative = _isNegative(normalizedText);

    // 1. CANCEL
    const CANCEL_REGEX = /\b(cancelar|cancelarlo|anular|dar de baja|no quiero (el|mi) pedido|baja al pedido|me arrepenti)\b/i;
    if (CANCEL_REGEX.test(normalizedText) && !isNegative && currentState.step !== 'completed') {
        console.log(`[GLOBAL] User ${userId} requested cancellation.`);
        const msg = "Qué pena... 😔 ¿Por qué querés cancelarlo? (Respondeme y le aviso a mi compañero para que te ayude)";
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        await _pauseAndAlert(userId, currentState, dependencies, text, '🚫 Solicitud de cancelación. El bot preguntó motivo.');
        return { matched: true };
    }

    // 2. MEDICAL REJECT
    const MEDICAL_REJECT_REGEX = /\b(embarazada|embarazo|lactancia|lactar|amamantar|amamantando|dando la teta|dando el pecho|8[0-9]\s*a[ñn]os|9[0-9]\s*a[ñn]os)\b/i;
    if ((MEDICAL_REJECT_REGEX.test(normalizedText) && !isNegative) || currentState.step === 'rejected_medical') {
        console.log(`[MEDICAL REJECT] User ${userId} mentioned contraindicated condition or is already rejected.`);
        const msg = "Lamentablemente, por estricta precaución, no recomendamos ni permitimos el uso de la Nuez de la India durante el embarazo, la lactancia o en personas mayores de 80 años. Priorizamos tu salud por encima de todo. 🌿😊\n\nPor este motivo, damos por finalizada la consulta y no podremos avanzar con el envío. ¡Cuidate mucho!";
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        _setStep(currentState, 'rejected_medical');
        saveState(userId);
        return { matched: true };
    }

    // 2.5 ABUSIVE / ANGRY REJECT
    const ABUSIVE_REGEX = /\b(estafador|estafadores|estafa|robo|ladron|ladrones|mierda|puta|puto|boludos|boludeo|boludear|mentirosos|mentira|chantas|chanta|garcas|garca|denunciar|defensa al consumidor)\b/i;
    if (ABUSIVE_REGEX.test(normalizedText) && currentState.step !== 'rejected_abusive') {
        console.log(`[ABUSIVE REJECT] User ${userId} used aggressive language.`);
        const msg = "Lamento mucho que te sientas de esta manera. Voy a suspender la interacción automática para que un asesor humano atienda y analice tu caso a la brevedad.";
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        _setStep(currentState, 'rejected_abusive');
        await _pauseAndAlert(userId, currentState, dependencies, text, '🚨 Lenguaje agresivo o acusación de estafa detectado. Bot silenciado.');
        saveState(userId);
        return { matched: true };
    }
    if (currentState.step === 'rejected_abusive') {
        return { matched: true }; // Silent block if they keep insulting
    }

    // 3. GEO REJECT
    const GEO_REGEX = /\b(espana|españa|mexico|méxico|chile|colombia|peru|perú|uruguay|bolivia|paraguay|ecuador|venezuela|brasil|panama|panamá|costa rica|eeuu|estados unidos|usa|europa|fuera del pais|fuera de argentina|otro pais|no estoy en argentina|vivo en el exterior|desde afuera|no soy de argentina)\b/i;
    if (GEO_REGEX.test(normalizedText) && !currentState.geoRejected) {
        console.log(`[GEO REJECT] User ${userId} is outside Argentina: "${text}"`);
        currentState.geoRejected = true;
        const msg = "Lamentablemente solo hacemos envíos dentro de Argentina 😔 Si en algún momento necesitás para alguien de acá, ¡con gusto te ayudamos!";
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
        _setStep(currentState, 'rejected_geo');
        saveState(userId);
        return { matched: true };
    }
    if (currentState.geoRejected || currentState.step === 'rejected_geo') {
        console.log(`[GEO REJECT] User ${userId} already geo-rejected, blocking.`);
        const msg = "Como te comenté, lamentablemente solo realizamos envíos dentro de Argentina 😔";
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // 3.5 CLIENT INQUIRY
    // Si el usuario es un cliente previo (ya compró antes), el bot se detiene siempre.
    // Detectamos si es cliente por un Tag explícito del CRM en currentState
    const isTaggedClient = currentState.tags && currentState.tags.some(tag => tag.name === 'Cliente');

    // O detectamos si en el estado del bot se marca que se realizó una venta exitosa
    // (flag booleano persistido en currentState, evita depender de texto literal frágil)
    const historyIndicatesSale = currentState.hasSoldBefore === true;

    if (isTaggedClient || historyIndicatesSale) {
        console.log(`[CLIENT SUPPORT] User ${userId} is an existing client speaking. Pausing bot.`);
        // Note: No auto-reply here as requested by user ("Simplemente te pausabas te pedias ayuda al administrador")
        await _pauseAndAlert(userId, currentState, dependencies, text, '🚨 Cliente recurrente o con compra reciente escribiendo. Intervención humana requerida.');
        return { matched: true };
    }

    // 4. CHANGE ORDER
    const CHANGE_REGEX = /\b(cambiar|cambiarlo|modificar|otro producto|otra cosa|en vez de|quiero otra)\b/i;
    if (CHANGE_REGEX.test(normalizedText) && currentState.step !== 'greeting' && currentState.step !== 'waiting_data' && !isNegative) {
        console.log(`[GLOBAL] User ${userId} requested change.`);
        currentState.cart = [];
        currentState.pendingOrder = null;
        currentState.partialAddress = {};
        currentState.selectedProduct = null;
        currentState.selectedPlan = null;

        const msg = "¡Ningún problema! 😊 Volvamos a elegir. ¿Qué te gustaría llevar entonces? (Cápsulas, Semillas, Gotas)";
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        _setStep(currentState, 'waiting_preference');
        saveState(userId);
        return { matched: true };
    }

    // Summarize history if too long (Priority 0 background task)
    if (currentState.history && currentState.history.length > 50) {
        const summaryResult = await aiService.checkAndSummarize(currentState.history);
        if (summaryResult) {
            currentState.summary = summaryResult.summary;
            currentState.history = summaryResult.prunedHistory;
            saveState(userId);
        }
    }

    return null;
}

module.exports = { handleSystemGlobals };
