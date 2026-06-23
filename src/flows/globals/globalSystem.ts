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
            // Retomar el HILO: re-enviar el último prompt real del bot ANTES de que
            // se metiera la pregunta de cancelación, en vez de soltar con un genérico
            // "¿en qué te puedo ayudar?". Reporte 5491157450451: el cliente venía de
            // "¿confirmás que podés retirar?", un audio se transcribió "...me arrepentí
            // ya" → cancel-confirm; el cliente aclaró "no, voy a retirar, afirmativo"
            // y el bot perdió el hilo en vez de retomar la confirmación.
            const CANCEL_PROMPT_RE = /quer[ée]s (continuar|cancelar)|para cancelar|confirm[áa]s que quer[ée]s cancelar/i;
            let resumePrompt: string | null = null;
            for (let i = currentState.history.length - 1; i >= 0; i--) {
                const h = currentState.history[i];
                if (h.role !== 'bot') continue;
                if (CANCEL_PROMPT_RE.test(h.content || '')) continue; // saltear prompts de cancelación
                resumePrompt = h.content;
                break;
            }
            const continueMsg = resumePrompt
                ? `¡Perfecto, seguimos! 😊\n\n${resumePrompt}`
                : '¡Qué bien, seguimos! 😊 ¿Avanzamos con el pedido?';
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
    // Modismos rioplatenses NO dirigidos al bot: intensificadores ("como un hijo
    // de puta" = muchísimo) y expresiones ("de/la puta madre"). Los borramos ANTES
    // de evaluar abuso, así un comprador no queda rechazado por su forma de hablar.
    // Caso real 5491130735300: "como como un hijo de puta... necesito un quemador
    // de grasa" (pedía cápsulas) → el bot lo rechazó por abuso. El abuso DIRIGIDO
    // ("sos un hijo de puta", "son unos estafadores") sigue gatillando porque no se borra.
    const normWithoutIdioms = normalizedText
        .replace(/\bcomo\s+(con\s+|que\s+)?(un|una)\s+(hij[oa]\s+de\s+puta|animal|bestia|condenad[oa])\b/gi, ' ')
        .replace(/\b(de|la)\s+puta\s+madre\b/gi, ' ');
    if (ABUSIVE_REGEX.test(normWithoutIdioms) && currentState.step !== 'rejected_abusive') {
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

    // 2.6 PAGO FANTASMA / CONFUSIÓN DE PAGO
    // El cliente dice que YA pagó / mandó comprobante, PERO el bot todavía no lo
    // llevó a ningún paso de pago (nunca le dio link ni alias). En los pasos de
    // pago "ya pagué" es esperado y lo maneja el step; FUERA de ellos es señal de
    // confusión o de ESTAFA de un tercero que se hizo pasar por nosotros y le sacó
    // plata (caso Haidee: pagó a un alias ajeno, sin orden registrada). El bot NO
    // debe seguir vendiendo ni insistir con el menú de pago: corta, le pide que NO
    // avance con más pagos, y avisa URGENTE a un humano.
    const CLAIMS_PAID_REGEX = /\b(ya (lo )?pague|ya (lo )?abone|ya transferi|ya hice (la )?transferencia|hice (la )?transferencia|ya esta pag[oa]|ya lo deposite|te pase el comprobante|te mande el comprobante|pague por mercado pago|ya hice el pago|ya pague todo)\b/;
    const PAYMENT_STEPS = ['waiting_mp_payment', 'waiting_transfer_confirmation', 'waiting_admin_validation', 'completed'];
    if (CLAIMS_PAID_REGEX.test(normalizedText) && !PAYMENT_STEPS.includes(currentState.step)) {
        logger.warn(`[PAGO-CONFUSO] User ${userId} dice que ya pagó pero NO está en un paso de pago (step=${currentState.step}) — posible estafa/confusión. Pauso + alerto.`);
        const msg = 'Pará un toque que reviso bien tu caso 🙏 Dejame chequearlo con el equipo y enseguida te escribo. Por las dudas, NO hagas ningún otro pago hasta que te confirme, ¿dale? 😊';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
        await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ PAGO CONFUSO: el cliente dice que YA PAGÓ / mandó comprobante pero el bot nunca le dio un medio de pago (no hay orden). Posible ESTAFA de un tercero o confusión. Revisar URGENTE: ¿a qué alias/cuenta pagó?');
        saveState(userId);
        return { matched: true };
    }

    // 3. GEO REJECT
    // Skip when collecting address (waiting_data) — street names like "Avenida España", "Calle Chile" etc.
    // would false-positive. Google Maps in stepWaitingData validates the country instead.
    const GEO_REGEX = /\b(espana|españa|mexico|méxico|chile|colombia|peru|perú|uruguay|bolivia|paraguay|ecuador|venezuela|brasil|panama|panamá|costa rica|eeuu|ee\.?\s?uu\.?|estados unidos|europa|fuera del pais|fuera de argentina|otro pais|no estoy en argentina|vivo en el exterior|desde afuera|no soy de argentina)\b/i;
    // Negaciones explícitas de pertenencia — éstas SÍ son extranjero real, NO una
    // aclaración (evita que "no estoy en argentina" cuente como señal argentina).
    const GEO_NEG_AR = /\b(no estoy en argentina|fuera de argentina|no soy de argentina|no es argentina)\b/i;
    // Señal de identidad ARGENTINA: nombra Argentina / su provincia, o una localidad
    // argentina ambigua que contiene un nombre de país (Concepción del Uruguay, Río
    // Uruguay = Entre Ríos). NO se enumeran localidades sueltas (sería whack-a-mole,
    // ej: Claromecó): basta con que el cliente mencione "argentina"/su provincia en
    // positivo. Cubre tanto la aclaración tras un rechazo ("queda dentro de Argentina")
    // como la identificación temprana ("soy del sur de prov. de Bs. As.") que debe
    // inmunizar contra un "estoy en Europa" posterior.
    // (reporte 5493442409792 Concepción del Uruguay + caso Claromecó, jun-2026.)
    const GEO_AR_IDENTITY = /\b(concepcion del?\s+uruguay|rio uruguay|paso del?\s+uruguay|entre rios|buenos aires|bs\.?\s?as|provincia|argentin[ao])\b/i;
    // Marco de "argentino de viaje": menciona el exterior PERO con regreso o compra a
    // futuro. No es un extranjero — ante la duda pausamos en vez de rechazar.
    const TRAVEL_FRAME = /\b(cuando (vuelv|regres|lleg|retorn|baj)|al volver|al regresar|de vacaciones|de viaje|estoy de paso|me vuelvo)\w*/i;
    const isCollectingAddress = currentState.step === 'waiting_data';
    const clarifiesArgentina = GEO_AR_IDENTITY.test(normalizedText) && !GEO_NEG_AR.test(normalizedText);

    // Una vez que el cliente se identifica como argentino queda inmunizado: las
    // keywords de exterior posteriores (de viaje, compra al volver) no lo rechazan.
    if (clarifiesArgentina) currentState.argentineConfirmed = true;

    if (GEO_REGEX.test(normalizedText) && !clarifiesArgentina && !currentState.argentineConfirmed && !currentState.geoRejected && !isCollectingAddress) {
        // Argentino de viaje (menciona exterior + regreso/compra futura): no es un
        // extranjero. Pausamos y derivamos a un humano en vez de rechazar y perder la venta.
        if (TRAVEL_FRAME.test(normalizedText)) {
            logger.info(`[GEO REJECT] User ${userId} menciona exterior con marco de viaje/compra futura → pauso en vez de rechazar: "${text}"`);
            await _pauseAndAlert(userId, currentState, dependencies, text, '✈️ Menciona estar en el exterior pero con marco de viaje / compra al volver. Posible argentino de viaje — revisar y continuar la venta a mano.');
            saveState(userId);
            return { matched: true };
        }
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
        // (ej: "es Concepción del Uruguay, Entre Ríos" / "queda dentro de Argentina"),
        // levantamos el rechazo y lo derivamos a un humano en vez de seguir bloqueando.
        if (clarifiesArgentina || currentState.argentineConfirmed) {
            logger.info(`[GEO REJECT] User ${userId} aclara que está en Argentina ("${text}") → levanto geoRejected y derivo a admin.`);
            currentState.geoRejected = false;
            _setStep(currentState, 'greeting');
            await _pauseAndAlert(userId, currentState, dependencies, text, '📍 Cliente geo-rechazado que aclara estar en Argentina (posible falso positivo, ej: Concepción del Uruguay / Claromecó). Revisar y continuar la venta a mano.');
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

    // Rolling summary: solo cuando el history supera la ventana viva (SUMMARIZE_TRIGGER
    // = MAX_HISTORY_LENGTH = 60 en ai.ts). checkAndSummarize igual se auto-protege
    // (devuelve null si length <= SUMMARIZE_TRIGGER y con un cooldown), así que este
    // gate es solo para no llamarla de gusto. Mantener en sync con ai.ts si cambia.
    if (currentState.history && currentState.history.length > 60) {
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
