import { UserState, FlowStep } from '../../types/state';
import { _formatMessage } from '../utils/messages';
import { _setStep, _maybeUpsell, _detectPostdatado, _assignProductAndPlanByTier, _maybeSendPaymentMenuV7 } from '../utils/flowHelpers';
import logger from '../../utils/logger';

export async function handleWaitingPreference(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // Plan elegido por el cliente: si pide explícitamente el otro plan (ej: "dale
    // pero el de 120" aunque le hayamos recomendado 60), lo guardamos en _planChoice
    // para que _assignProductAndPlanByTier lo respete. Ya no auto-mostramos ambos
    // planes (prices_both se quitó el 2026-06-03), pero el cliente igual puede
    // pedir el otro. No colisiona con la elección de producto (1/2/3): acá pedimos
    // "120"/"4 meses", nunca un dígito suelto.
    if (/\b(120|4\s*meses|cuatro\s*meses|el\s+(largo|completo|grande))\b/i.test(normalizedText)) {
        (currentState as any)._planChoice = '120';
    } else if (/\b(60|2\s*meses|dos\s*meses|el\s+(corto|chico))\b/i.test(normalizedText)) {
        (currentState as any)._planChoice = '60';
    }

    // SCRIPT FIRST: Check if the user is asking for a deferred "postdatado" date early
    const earlyPostdatado = _detectPostdatado(normalizedText);
    if (earlyPostdatado) {
        logger.info(`[EARLY POSTDATADO] Captured in waiting_preference: ${earlyPostdatado}`);
        if (!currentState.postdatado) currentState.postdatado = earlyPostdatado;
        saveState(userId);
    }

    // SCRIPT FIRST: Check if the user has a health concern or explicit question that must be answered
    const hasQuestionOrConcern = /\b(diabetes|diabetica|presion|hipertens|salud|enfermedad|tiroides|hipotiroidismo|operada|cirugia|bypass|manga|estomago|gastritis|acidez|contraindicacion|lactancia|embarazo|peligro|efecto|secundario|laxante|diarrea|consulta|duda|pregunta|horario)\b|[?¿]/i.test(normalizedText);

    // SCRIPT FIRST: Check keywords for capsulas or semillas
    const isMatch = (keywords: string[], text: string) => keywords.some((k: string) => new RegExp(`\\b${k}\\b`, 'i').test(text));

    // Numeric option matching: el script muestra "1️⃣ Cápsulas, 2️⃣ Semillas, 3️⃣ Gotas".
    // Sin esto, "1"/"2"/"3" caen al fallback de IA — y si OpenAI responde 429
    // todos esos clientes terminan pausados (causa raíz del peor día de ventas 28/04).
    const trimmed = normalizedText.trim();
    const numericReply =
        trimmed.match(/^([123])\s*[.)\-:°]?\s*$/) ||           // "1", "1.", "1)", "1-"
        trimmed.match(/^([123])[️⃣]+/) ||              // "1️⃣"
        trimmed.match(/^(?:opci[oó]n\s+|la\s+|el\s+|opc\s*)?([123])\b/);  // "opcion 1", "el 1"
    let numericCapsulas = false, numericSemillas = false, numericGotas = false;
    if (numericReply && !hasQuestionOrConcern && trimmed.length <= 30) {
        const choice = numericReply[1];
        // Mapeo según el orden de prices_60/120 en V7: 1=Cápsulas, 2=Gotas, 3=Semillas.
        // Bug previo (reportes 2026-05-29 5493813928867 + 5493562507143): los slots
        // 2 y 3 estaban invertidos — "3" mapeaba a gotas y "2" a semillas, contra
        // lo que el cliente ve en pantalla.
        if (choice === '1') numericCapsulas = true;
        else if (choice === '2') numericGotas = true;
        else if (choice === '3') numericSemillas = true;
        logger.info(`[NUMERIC-PREF] User ${userId} replied with option ${choice} ("${text.substring(0, 30)}").`);
    }

    const mentionsCapsulas = numericCapsulas || isMatch(knowledge.flow.preference_capsulas.match, normalizedText);
    const mentionsSemillas = numericSemillas || isMatch(knowledge.flow.preference_semillas.match, normalizedText);
    const mentionsGotas = numericGotas || (knowledge.flow.preference_gotas ? isMatch(knowledge.flow.preference_gotas.match, normalizedText) : false);

    const totalMatches = (mentionsCapsulas ? 1 : 0) + (mentionsSemillas ? 1 : 0) + (mentionsGotas ? 1 : 0);

    // Or if they ask for a recommendation or express a physical objection (e.g., hard to swallow)
    // FIX: Only treat as comparison if they ACTUALLY mention more than one, explicitly ask for comparison,
    // OR have a health concern/question while also mentioning a product (so the AI can answer before proceeding).
    const hasObjection = /\b(tragar|ahogar|grandes|cuestan|complicado|dificil|miedo a ahogarme)\b/i.test(normalizedText);
    const isComparison = totalMatches > 1 || hasObjection || (hasQuestionOrConcern && totalMatches >= 1) || (totalMatches === 0 && /\b(cual|recomend|mejor|diferencia|que me recomiendas|que me conviene|cual me das|asesorame|efectiv|rapido)\b/i.test(normalizedText));

    if (isComparison) {
        // HARDCODED: si el cliente DELEGA explícitamente ("elegí vos", "lo mejor",
        // "cualquiera"), default determinístico a cápsulas (forma práctica) sin
        // mentir diciendo "es lo más efectivo". Las 3 funcionan igual; cápsulas
        // se elige solo porque es la forma más usada. Este fallback existe para
        // no depender de la IA cuando claramente el cliente delega.
        const directRecommend = /\b(lo (mas|más) (efectivo|eficaz|mejor|rapido|rápido|potente)|lo mejor|cualquiera|el (mas|más) (efectivo|eficaz|mejor|rapido|rápido|potente)|el que (sea )?mejor|recomienda(me|n)? vos|recomendame|tu eligen?|elegi vos)\b/i;
        if (directRecommend.test(normalizedText.trim())) {
            logger.info(`[HARDCODED-PREF] User ${userId} delegó la elección ("${text.substring(0, 40)}") → default Cápsulas.`);
            _assignProductAndPlanByTier(currentState, 'Cápsulas de nuez de la india');
            const priceNode = knowledge.flow.preference_capsulas;
            const msg = _formatMessage(priceNode.response, currentState);
            _setStep(currentState, priceNode.nextStep);
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            await _maybeSendPaymentMenuV7(userId, priceNode.nextStep, currentState, knowledge, dependencies);
            await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
            return { matched: true };
        }

        if (/^(capsulas? o gotas?|gotas? o capsulas?|capsulas o gotas porfa(?:vor)?)$/i.test(normalizedText.trim())) {
            logger.info(`[HARDCODED-PREF] User ${userId} preguntó "capsulas o gotas" — comparamos forma sin push.`);
            const cmp1 = "Las dos formas funcionan igual de bien 🌿";
            const cmp2 = "Las *cápsulas* son la forma más práctica — una al día y listo.\nLas *gotas* son líquidas y un poco más suaves al estómago.\n\n👉 ¿Con cuál vas?";

            currentState.history.push({ role: 'bot', content: cmp1, timestamp: Date.now() });
            await sendMessageWithDelay(userId, cmp1);

            currentState.history.push({ role: 'bot', content: cmp2, timestamp: Date.now() });
            _setStep(currentState, FlowStep.WAITING_PREFERENCE);
            currentState.consultativeSale = true;
            saveState(userId);
            await sendMessageWithDelay(userId, cmp2);

            return { matched: true };
        }

        logger.info(`[INDICISION] User ${userId} compares products or asks for recommendation.`);

        const aiRecommendation = await aiService.chat(text, {
            step: FlowStep.WAITING_PREF_CONSULT,
            goal: `El usuario está indeciso entre productos o pide recomendaciones. Modelo V5 (rev. 2026-05-26): las 3 opciones (Cápsulas / Gotas / Semillas) se ofrecen IGUALES — no empujes una en particular. REGLAS:
            1) Si el usuario MENCIONÓ EXPLÍCITAMENTE un producto (ej: "capsulas", "gotas", "semillas"), goalMet=true con extractedData del producto que dijo.
            2) Si el usuario está aceptando con un genérico ("dale", "bueno", "ok") SIN nombrar producto, NO ASUMAS — goalMet=false y re-preguntá "¿con cuál vas, cápsulas, gotas o semillas?".
            3) Si pide "lo más efectivo/mejor/rápido", "cualquiera" o "elegí vos": el cliente está DELEGANDO. Asumí Cápsulas (forma más práctica) PERO sin decir que son "más efectivas" — decí "Te traigo cápsulas que es la forma más práctica, las 3 funcionan igual". goalMet=true, extractedData="Cápsulas de nuez de la india".
            4) EMOCIÓN Y SALUD: Si cuenta su historia de peso, problemas médicos (tiroides, operaciones) o inseguridades, REDACTÁ UN PÁRRAFO EMPÁTICO validando sus sentimientos ANTES de cerrar nada. goalMet=false.
            5) Si tiene GASTRITIS / úlcera / acidez: recomendá cápsulas o gotas (semillas pueden irritar — es una contraindicación real). goalMet=false hasta que confirme.
            6) Si pide "info de las 3", "precio de las 3" o "todas": dale un resumen breve de las 3 opciones con sus precios de 60 días (del knowledge). NO empujes ninguna. Después preguntá cuál prefiere.
            7) Si pregunta por envío o medios de pago: envío gratis. 2 opciones: retiro en sucursal (paga total en efectivo al retirar, sin anticipo, 7 a 10 días hábiles) o domicilio prepago por tarjeta de crédito o transferencia (más rápido, 6 a 7 días hábiles). NUNCA menciones cuotas ni anticipo. Después preguntá con cuál producto avanzar.
            8) HORARIOS DE ENVÍO: si pregunta a qué hora llega o pide un horario, respondé que no controlamos al cartero del Correo Argentino, pero que avisamos si no lo encuentran. Después preguntá con cuál producto avanzar.`,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiRecommendation.goalMet && aiRecommendation.extractedData) {
            // First send the AI's natural response if it exists (e.g., to answer a health question)
            if (aiRecommendation.response) {
                currentState.history.push({ role: 'bot', content: aiRecommendation.response, timestamp: Date.now() });
                await sendMessageWithDelay(userId, aiRecommendation.response);
            }

            const ext = aiRecommendation.extractedData.toLowerCase();
            let priceNode;
            if (ext.includes('cápsula') || ext.includes('capsula')) {
                _assignProductAndPlanByTier(currentState, 'Cápsulas de nuez de la india');
                priceNode = knowledge.flow.preference_capsulas;
            } else if (ext.includes('gota')) {
                _assignProductAndPlanByTier(currentState, 'Gotas de nuez de la india');
                priceNode = knowledge.flow.preference_gotas;
            } else if (ext.includes('semilla')) {
                _assignProductAndPlanByTier(currentState, 'Semillas de nuez de la india');
                priceNode = knowledge.flow.preference_semillas;
            }

            if (priceNode) {
                const msg = _formatMessage(priceNode.response, currentState);
                _setStep(currentState, priceNode.nextStep);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, msg);

                await _maybeSendPaymentMenuV7(userId, priceNode.nextStep, currentState, knowledge, dependencies);
                await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
                return { matched: true };
            }
        } else if (aiRecommendation.response) {
            currentState.history.push({ role: 'bot', content: aiRecommendation.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiRecommendation.response);
            currentState.consultativeSale = true;
            saveState(userId);
            return { matched: true };
        }
    }

    if (mentionsCapsulas) {
        _assignProductAndPlanByTier(currentState, "Cápsulas de nuez de la india");
        const node = knowledge.flow.preference_capsulas;
        const msg = _formatMessage(node.response, currentState);

        _setStep(currentState, node.nextStep);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _maybeSendPaymentMenuV7(userId, node.nextStep, currentState, knowledge, dependencies);
        await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
        return { matched: true };
    } else if (mentionsSemillas) {
        _assignProductAndPlanByTier(currentState, "Semillas de nuez de la india");
        const node = knowledge.flow.preference_semillas;
        const msg = _formatMessage(node.response, currentState);

        _setStep(currentState, node.nextStep);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _maybeSendPaymentMenuV7(userId, node.nextStep, currentState, knowledge, dependencies);
        await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
        return { matched: true };
    } else if (knowledge.flow.preference_gotas && mentionsGotas) {
        _assignProductAndPlanByTier(currentState, "Gotas de nuez de la india");
        const node = knowledge.flow.preference_gotas;
        const msg = _formatMessage(node.response, currentState);

        _setStep(currentState, node.nextStep);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _maybeSendPaymentMenuV7(userId, node.nextStep, currentState, knowledge, dependencies);
        await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
        return { matched: true };
    } else {
        logger.info(`[AI-FALLBACK] waiting_preference: No keyword match for ${userId}`);
        const aiPref = await aiService.chat(text, {
            step: FlowStep.WAITING_PREFERENCE,
            goal: `Determinar qué producto prefiere el usuario: Cápsulas, Gotas o Semillas. Modelo V5 (rev. 2026-05-26): las 3 opciones se ofrecen IGUALES — no empujes una en particular.
1) EMOCIÓN Y SALUD: Si hace un descargo sobre su peso, operaciones o inseguridades médicas, REDACTÁ MÚLTIPLES PÁRRAFOS demostrando altísima empatía y contención. Tono explayado y compasivo antes de cerrar nada.
2) Usá muletillas argentinas naturales ("dale", "tranqui", "te cuento") sin exagerar.
3) Si MENCIONA explícitamente un producto ("capsulas", "gotas", "semillas"), goalMet=true, extractedData con el producto.
4) Si solo dice "dale"/"si"/"bueno" SIN nombrar producto, NO asumas — goalMet=false y re-preguntá "¿con cuál te gustaría avanzar: cápsulas, gotas o semillas?".
5) Si pide "lo más efectivo/mejor/rápido", "cualquiera" o "elegí vos": el cliente delega. Asumí cápsulas (forma más práctica) PERO aclarando que las 3 funcionan igual. extractedData="PRODUCTO: Cápsulas de nuez de la india".
6) Si habla en PASADO ("yo tomaba semillas"): preguntá si quiere repetir o probar otra forma — no le impongas cápsulas.
7) Si tiene gastritis/úlcera/acidez: recomendá cápsulas o gotas (semillas pueden irritar). goalMet=false hasta que confirme.
8) Si pide información o precios de "las 3", brindá explicación breve de las 3 formas con precios de 60 días (knowledge). Después preguntá cuál prefiere.
9) Si pregunta si puede pagar/recibir un día concreto: dale el OK y volvé a la elección de producto.
10) Si pregunta por envío o medios de pago: envío gratis, 2 opciones (retiro en sucursal sin anticipo, paga al retirar, 7 a 10 días hábiles / domicilio prepago por tarjeta de crédito o transferencia, más rápido 6 a 7 días hábiles). NUNCA menciones anticipo ni cuotas. Después preguntá producto.`,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiPref.goalMet && aiPref.extractedData) {
            // First send the AI's natural response if it exists (e.g., to answer a health question)
            if (aiPref.response) {
                currentState.history.push({ role: 'bot', content: aiPref.response, timestamp: Date.now() });
                await sendMessageWithDelay(userId, aiPref.response);
            }

            const ext = aiPref.extractedData.toLowerCase();
            let priceNode;
            if (ext.includes('cápsula') || ext.includes('capsula')) {
                _assignProductAndPlanByTier(currentState, 'Cápsulas de nuez de la india');
                priceNode = knowledge.flow.price_capsulas || knowledge.flow.preference_capsulas;
            } else if (ext.includes('gota')) {
                _assignProductAndPlanByTier(currentState, 'Gotas de nuez de la india');
                priceNode = knowledge.flow.price_gotas || knowledge.flow.preference_gotas;
            } else if (ext.includes('semilla')) {
                _assignProductAndPlanByTier(currentState, 'Semillas de nuez de la india');
                priceNode = knowledge.flow.price_semillas || knowledge.flow.preference_semillas;
            }

            if (priceNode) {
                const msg = _formatMessage(priceNode.response, currentState);
                _setStep(currentState, priceNode.nextStep);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, msg);

                await _maybeSendPaymentMenuV7(userId, priceNode.nextStep, currentState, knowledge, dependencies);
                await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
                return { matched: true };
            }
        }

        if (aiPref.response) {
            currentState.history.push({ role: 'bot', content: aiPref.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiPref.response);
            saveState(userId);
            return { matched: true };
        }
    }
    return { matched: false };
}
