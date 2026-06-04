import { UserState } from '../../types/state';
import { _isNegative } from '../utils/validation';
import { _pauseAndAlert, _setStep } from '../utils/flowHelpers';
import logger from '../../utils/logger';

interface SystemDependencies {
    sendMessageWithDelay: (chatId: string, content: string) => Promise<void>;
    aiService: any;
    saveState: (userId: string) => void;
    notifyAdmin?: (subject: string, userId: string, detail?: string) => Promise<any>;
    sharedState?: { pausedUsers?: Set<string>; io?: any };
}

export async function handleSystemGlobals(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    dependencies: SystemDependencies
): Promise<{ matched: boolean } | null> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;
    const isNegative = _isNegative(normalizedText);

    // 0. PENDING CANCEL CONFIRMATION — intercept before any other logic
    if (currentState.pendingCancelConfirm && currentState.step !== 'completed') {
        const confirmYes = /\b(si|sí|sip|sep|dale|confirmo|claro|seguro|exacto|afirmativo|cancelar)\b/i.test(normalizedText)
            && !/\b(no|para nada|olvida|seguir|quiero seguir|no\s+s[eé])\b/i.test(normalizedText);
        // confirmNo: starts with "no" (direct answer) but NOT "no sé" (uncertainty)
        const startsWithNo = /^no\b/i.test(normalizedText);
        const hasUncertainty = /\b(s[eé]|todav[ií]a|no\s+s[eé])\b/i.test(normalizedText);
        const confirmNo = (startsWithNo && !hasUncertainty)
            || /\b(para nada|olvídalo|olvidalo|seguimos|quiero seguir|dejalo)\b/i.test(normalizedText);

        if (confirmYes) {
            currentState.pendingCancelConfirm = false;
            const byeMsg = 'Entendido, lamentamos no poder ayudarte en esta oportunidad 😔 ¡Si en algún momento nos necesitás, acá estamos!';
            currentState.history.push({ role: 'bot', content: byeMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, byeMsg);
            saveState(userId);
            await _pauseAndAlert(userId, currentState, dependencies, text, '🚫 Cancelación confirmada por el cliente durante el proceso de venta.');
            return { matched: true };
        } else if (confirmNo) {
            currentState.pendingCancelConfirm = false;
            const continueMsg = '¡Qué bien! Seguimos entonces 😊 ¿En qué te puedo ayudar?';
            currentState.history.push({ role: 'bot', content: continueMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, continueMsg);
            saveState(userId);
            return { matched: true };
        } else {
            // Ambiguous — ask again
            const askMsg = 'Perdoname, ¿confirmás que querés cancelar? Respondé *sí* o *no* 😊';
            currentState.history.push({ role: 'bot', content: askMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, askMsg);
            saveState(userId);
            return { matched: true };
        }
    }

    // 1. CANCEL
    //    Explicit: "cancelar", "anular" — allowed unless the user is saying "no quiero cancelar"
    //    Implicit: "ya no quiero", "me arrepenti" — always triggers (these ARE the cancel intent)
    const NO_CANCEL_PHRASE = /\b(no\s+(quiero|quería)\s+cancelar|sin\s+cancelar|no\s+cancelar)\b/i;
    const EXPLICIT_CANCEL_REGEX = /\b(cancelar|cancelarlo|anular|dar de baja|no quiero (el|mi) pedido|baja al pedido)\b/i;
    const IMPLICIT_CANCEL_REGEX = /\b(ya no quiero|me arrepenti|no me interesa mas|no me interesa más)\b/i;
    if (((EXPLICIT_CANCEL_REGEX.test(normalizedText) && !NO_CANCEL_PHRASE.test(normalizedText))
        || IMPLICIT_CANCEL_REGEX.test(normalizedText)) && currentState.step !== 'completed') {
        logger.info(`[GLOBAL] User ${userId} requested cancellation.`);
        currentState.pendingCancelConfirm = true;
        const msg = '¿Estás seguro/a de que no querés continuar? Antes de decidir, puedo responder cualquier duda que tengas 😊\n\nRespondé *sí* para cancelar o *no* para seguir.';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // 2. MEDICAL REJECT
    const MEDICAL_REJECT_REGEX = /\b(embarazada|embarazo|lactancia|lactar|amamantar|amamantando|dando la teta|dando el pecho|8[0-9]\s*a[ñn]os|9[0-9]\s*a[ñn]os)\b/i;
    if ((MEDICAL_REJECT_REGEX.test(normalizedText) && !isNegative) || currentState.step === 'rejected_medical') {
        logger.info(`[MEDICAL REJECT] User ${userId} mentioned contraindicated condition or is already rejected.`);
        const msg = 'Lamentablemente, por estricta precaución, no recomendamos ni permitimos el uso de la Nuez de la India durante el embarazo, la lactancia o en personas mayores de 80 años. Priorizamos tu salud por encima de todo. 🌿😊\n\nPor este motivo, damos por finalizada la consulta y no podremos avanzar con el envío. ¡Cuidate mucho!';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        _setStep(currentState, 'rejected_medical');
        saveState(userId);
        return { matched: true };
    }

    // 2.5 ABUSIVE / ANGRY REJECT
    const ABUSIVE_REGEX = /\b(estafador|estafadores|estafa|robo|ladron|ladrones|mierda|puta|puto|boludos|boludeo|boludear|mentirosos|mentira|chantas|chanta|garcas|garca|denunciar|defensa al consumidor)\b/i;
    if (ABUSIVE_REGEX.test(normalizedText) && currentState.step !== 'rejected_abusive') {
        logger.info(`[ABUSIVE REJECT] User ${userId} used aggressive language.`);
        const msg = 'Lamento mucho que te sientas de esta manera. Voy a suspender la interacción automática para que un asesor humano atienda y analice tu caso a la brevedad.';
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
    // Skip when collecting address (waiting_data) — street names like "Avenida España", "Calle Chile" etc.
    // would false-positive. Google Maps in stepWaitingData validates the country instead.
    const GEO_REGEX = /\b(espana|españa|mexico|méxico|chile|colombia|peru|perú|uruguay|bolivia|paraguay|ecuador|venezuela|brasil|panama|panamá|costa rica|eeuu|ee\.?\s?uu\.?|estados unidos|europa|fuera del pais|fuera de argentina|otro pais|no estoy en argentina|vivo en el exterior|desde afuera|no soy de argentina)\b/i;
    // Excepción: lugares ARGENTINOS que contienen el nombre de un país, o aclaraciones
    // de que el cliente SÍ está en Argentina. Concepción del Uruguay y Río Uruguay
    // están en Entre Ríos. Sin esto, un cliente de "Concepción del Uruguay" quedaba
    // geo-rechazado y NO podía salir del bloqueo aunque aclarara que es Argentina
    // (reporte 5493442409792, jun-2026: el bot lo rechazó 4 veces, intervino el admin).
    const GEO_AR_EXCEPTION = /\b(concepcion del?\s+uruguay|rio uruguay|paso del?\s+uruguay|entre rios|soy de argentina|estoy en argentina|vivo en argentina|si soy de (aca|argentina)|aca en argentina|es (en )?argentina|de entre rios)\b/i;
    const isCollectingAddress = currentState.step === 'waiting_data';
    const clarifiesArgentina = GEO_AR_EXCEPTION.test(normalizedText);

    if (GEO_REGEX.test(normalizedText) && !clarifiesArgentina && !currentState.geoRejected && !isCollectingAddress) {
        logger.info(`[GEO REJECT] User ${userId} is outside Argentina: "${text}"`);
        currentState.geoRejected = true;
        const msg = 'Lamentablemente solo hacemos envíos dentro de Argentina 😔 Si en algún momento necesitás para alguien de acá, ¡con gusto te ayudamos!';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
        _setStep(currentState, 'rejected_geo');
        saveState(userId);
        return { matched: true };
    }
    if (currentState.geoRejected || currentState.step === 'rejected_geo') {
        // Recuperación de falso positivo: si el cliente aclara que SÍ está en Argentina
        // (ej: "es Concepción del Uruguay, Entre Ríos"), levantamos el rechazo y lo
        // derivamos a un humano en vez de seguir bloqueando robóticamente.
        if (clarifiesArgentina) {
            logger.info(`[GEO REJECT] User ${userId} aclara que está en Argentina ("${text}") → levanto geoRejected y derivo a admin.`);
            currentState.geoRejected = false;
            _setStep(currentState, 'greeting');
            await _pauseAndAlert(userId, currentState, dependencies, text, '📍 Cliente geo-rechazado que aclara estar en Argentina (posible falso positivo, ej: Concepción del Uruguay / Entre Ríos). Revisar y continuar la venta a mano.');
            saveState(userId);
            return { matched: true };
        }
        logger.info(`[GEO REJECT] User ${userId} already geo-rejected, blocking.`);
        const msg = 'Como te comenté, lamentablemente solo realizamos envíos dentro de Argentina 😔';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // 3.5 CLIENT INQUIRY
    // Si el usuario es un cliente previo (ya compró antes), el bot se detiene siempre.
    const isTaggedClient = (currentState as any).tags?.some((tag: any) => tag.name === 'Cliente') ?? false;

    // Flag booleano persistido en currentState (evita depender de texto literal frágil)
    const historyIndicatesSale = currentState.hasSoldBefore === true;

    if (isTaggedClient || historyIndicatesSale) {
        logger.info(`[CLIENT SUPPORT] User ${userId} is an existing client speaking. Pausing bot.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, '🚨 Cliente recurrente o con compra reciente escribiendo. Intervención humana requerida.');
        return { matched: true };
    }

    // 4. CHANGE ORDER
    const CHANGE_REGEX = /\b(cambiar|cambiarlo|modificar|otro producto|otra cosa|en vez de|quiero otra)\b/i;
    if (CHANGE_REGEX.test(normalizedText) && currentState.step !== 'greeting' && currentState.step !== 'waiting_data' && !isNegative) {
        logger.info(`[GLOBAL] User ${userId} requested change.`);
        currentState.cart = [];
        currentState.pendingOrder = null;
        currentState.partialAddress = {};
        currentState.selectedProduct = null;
        currentState.selectedPlan = null;

        const msg = '¡Ningún problema! 😊 Volvamos a elegir. ¿Qué te gustaría llevar entonces? (Cápsulas, Semillas, Gotas)';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        _setStep(currentState, 'waiting_preference');
        saveState(userId);
        return { matched: true };
    }

    // Rolling summary: trigger earlier (>30) so each chunk stays small and
    // token cost per AI call remains flat. checkAndSummarize self-guards
    // with a cooldown so chatty users don't burn summaries every turn.
    if (currentState.history && currentState.history.length > 30) {
        const summaryResult = await aiService.checkAndSummarize(
            currentState.history,
            currentState.summary,
            currentState.lastSummarizedAt
        );
        if (summaryResult) {
            currentState.summary = summaryResult.summary;
            currentState.history = summaryResult.prunedHistory;
            currentState.lastSummarizedAt = summaryResult.lastSummarizedAt;
            saveState(userId);
        }
    }

    return null;
}
