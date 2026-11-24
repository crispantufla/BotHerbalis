import { UserState, FlowStep } from '../../types/state';
import { _formatMessage } from '../utils/messages';
import { _setStep, _maybeUpsell, _detectPostdatado, _captureWeightGoal, _assignProductAndPlanByTier, _maybeSendPaymentMenuV7, _pushHistory } from '../utils/flowHelpers';
import { isMpEnabled, prepayMeans } from '../utils/paymentOptions';
import { isNotAChoice, isDeferral } from '../../services/intentClassifier';
import logger from '../../utils/logger';

/**
 * Guion de bot-promo (28-oct): si el cliente ya dijo el plan ("gotas de 60") o el producto
 * viene en un solo plan (semillas, solo 120 días), no se pregunta "¿60 o 120?": se
 * arma el carrito y se pasa directo a la localidad.
 */
async function _clubSkipPlanQuestion(userId: string, text: string, product: string, currentState: UserState, knowledge: any, dependencies: any): Promise<boolean> {
    const { _getEffectivePrice } = require('../utils/pricing');
    const singlePlan = !_getEffectivePrice(product, '60', currentState);
    const choice = (currentState as any)._planChoice;
    if (!singlePlan && choice !== '60' && choice !== '120') return false;
    const { buildCartFromSelection } = require('../utils/cartHelpers');
    buildCartFromSelection(product, singlePlan ? '120' : choice, currentState);
    _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
    const prefix = singlePlan && knowledge?.flow?.preference_semillas && product.startsWith('Semillas')
        ? _formatMessage(knowledge.flow.preference_semillas.response, currentState) + '\n\n'
        : '';
    const { _startZoneStep } = require('./stepWaitingZone');
    await _startZoneStep(userId, text, currentState, knowledge, dependencies, prefix);
    logger.info(`[CLUB-PLAN] ${userId} → ${product} × ${currentState.selectedPlan} sin preguntar el plan → localidad.`);
    return true;
}

/**
 * A quien dijo que quiere bajar hasta 10 kg no se le empuja el plan de 120 días:
 * la lista de precios le acaba de decir que con el de 60 alcanza.
 */
/**
 * La IA ya contestó la duda y devolvió el producto elegido. Hasta el
 * 24-nov-2026 después salía la plantilla "¡Genial, las gotas! … ¿Con cuál vas,
 * 60 o 120 días?" aunque el cliente ya hubiera dicho el plan o la IA hubiera
 * cerrado con otra pregunta (cinco charlas de la simulación). Ahora:
 *  - con el plan dicho (o producto de un solo plan) se arma el pedido y se pasa
 *    a la localidad, sin volver a preguntar el plan;
 *  - sin plan, si la IA ya cerró con una pregunta no se le suma otra: el
 *    cliente queda en la elección de plan y su respuesta se lee ahí.
 * Devuelve true si se hizo cargo. Solo guion por zona.
 */
async function _advanceAfterAiAnswer(userId: string, text: string, product: string, aiResponse: string | null, aiSent: boolean, currentState: UserState, knowledge: any, dependencies: any): Promise<boolean> {
    if (!knowledge?.flow?.prices_club) return false;
    const { _getEffectivePrice } = require('../utils/pricing');
    const singlePlan = !_getEffectivePrice(product, '60', currentState);
    const choice = (currentState as any)._planChoice;
    if (singlePlan || choice === '60' || choice === '120') {
        const { buildCartFromSelection } = require('../utils/cartHelpers');
        buildCartFromSelection(product, singlePlan ? '120' : choice, currentState);
        _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
        const { _startZoneStep } = require('./stepWaitingZone');
        const askedPlace = aiSent && /de qu[eé] (localidad|ciudad|pueblo|zona)|de d[oó]nde sos|tu localidad/i.test(aiResponse || '');
        await _startZoneStep(userId, text, currentState, knowledge, dependencies, '', { skipQuestion: askedPlace });
        logger.info(`[CLUB-PLAN] ${userId} → ${product} × ${currentState.selectedPlan} tras la respuesta de la IA → localidad.`);
        return true;
    }
    if (aiSent && aiResponse && /[?¿]/.test(aiResponse.slice(-160))) {
        const node = product.startsWith('Cápsulas') ? knowledge.flow.preference_capsulas : product.startsWith('Gotas') ? knowledge.flow.preference_gotas : knowledge.flow.preference_semillas;
        _setStep(currentState, node?.nextStep || FlowStep.WAITING_PLAN_CHOICE);
        dependencies.saveState(userId);
        logger.info(`[CLUB-PLAN] ${userId} → ${product}: la IA ya cerró con una pregunta, no mando la plantilla de planes.`);
        return true;
    }
    return false;
}

// "nooo gracias me equivoqué" después de la lista de precios: la IA se despedía
// bien pero marcaba NEED_ADMIN y el chat quedaba pausado con aviso al vendedor.
const SOFT_DECLINE = /\b(no+,?\s*gracias|me equivoque|numero equivocado|chat equivocado|no me interesa|no quiero nada|no necesito|era para otr[oa])\b/;

function _pitchForGoal(msg: string, state: UserState): string {
    const w = Number(state.weightGoal) || 0;
    if (w <= 0 || w > 10) return msg;
    return msg.replace(/El de \*120 días\* es el tratamiento completo y el que más eligen 💪/, 'Para lo que querés bajar, con el de *60 días* te alcanza 💪');
}

export async function handleWaitingPreference(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;
    _captureWeightGoal(normalizedText, currentState);

    if (knowledge?.flow?.prices_club && normalizedText.trim().split(/\s+/).length <= 8 && SOFT_DECLINE.test(normalizedText)
        && !/\b(got\w*|capsul\w*|semill\w*|pastill\w*|precios?|cuanto)\b/.test(normalizedText) && !/[?¿]/.test(text)) {
        currentState.cartRecovered = true; // sin recordatorio a quien dijo que no
        saveState(userId);
        const bye = '¡Tranqui, no pasa nada! 😊 Si más adelante querés saber algo, acá estoy.';
        const lastBot: any = [...(currentState.history || [])].reverse().find((h: any) => h && h.role === 'bot');
        if (String(lastBot?.content || '').trim() !== bye) await sendMessageWithDelay(userId, bye);
        logger.info(`[CLUB-PRECIOS] ${userId} no quiere seguir ("${text.slice(0, 50)}") en la elección de producto → me despido sin pausar.`);
        return { matched: true };
    }

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
    // La IA leyó el mensaje como pregunta u objeción y NO como elección
    // (dependencies.intent): nombrar un producto para preguntar por él no es
    // elegirlo. "Que son naturales porque yo tomo pastillas para el corazón" y
    // "contame un poquito sobre las gotas" recibían "¡Genial, las cápsulas!"
    // (revisión de charlas del 13 al 19-nov-2026).
    // Lo mismo si avisa que compra más adelante (intent.defers): "las cápsulas
    // de 60 pero dejame que mañana le hablo a mi hermana" armó un pedido que la
    // clienta nunca hizo.
    const aiSaysLater = isDeferral(dependencies.intent);
    const aiSaysNotChoice = isNotAChoice(dependencies.intent) || aiSaysLater;
    const notChoiceHint = aiSaysLater
        ? `\n0) ⚠️ EL CLIENTE AVISA QUE COMPRA MÁS ADELANTE (lo consulta con alguien, espera a cobrar, lo va a pensar). Aunque nombre un producto, todavía NO lo está pidiendo: no des el pedido por hecho ni pidas datos. Respondé con calidez y sin presionar; podés ofrecerle UNA sola vez dejarlo agendado para la fecha que le quede cómoda (si es de Rosario o alrededores, recordale que paga recién al recibir). goalMet=false y extractedData=null. Esto manda sobre las reglas de abajo.`
        : aiSaysNotChoice
        ? `\n0) ⚠️ ESTE MENSAJE ES UNA PREGUNTA O UNA DUDA, NO UNA ELECCIÓN. Aunque nombre un producto ("pastillas", "gotas"), el cliente todavía NO eligió: respondé primero lo que pregunta o le preocupa y recién después preguntá con cuál quiere avanzar. goalMet=false y extractedData=null. Esto manda sobre las reglas de abajo.`
        : '';
    const hasQuestionOrConcern = aiSaysNotChoice || /\b(diabetes|diabetica|presion|hipertens|salud|enfermedad|tiroides|hipotiroidismo|operada|cirugia|bypass|manga|estomago|gastritis|acidez|contraindicacion|lactancia|embarazo|peligro|efecto|secundario|laxante|diarrea|consulta|duda|pregunta|horario)\b|[?¿]/i.test(normalizedText);

    // SCRIPT FIRST: Check keywords for capsulas or semillas
    const isMatch = (keywords: string[], text: string) => keywords.some((k: string) => new RegExp(`\\b${k}\\b`, 'i').test(text));

    // Numeric option matching: el script muestra "1️⃣ Cápsulas, 2️⃣ Semillas, 3️⃣ Gotas".
    // Sin esto, "1"/"2"/"3" caen al fallback de IA — y si OpenAI responde 429
    // todos esos clientes terminan pausados (causa raíz del peor día de ventas 28/04).
    const trimmed = normalizedText.trim();
    const numericReply =
        trimmed.match(/^([123])\s*[.)\-:°]?\s*$/) ||           // "1", "1.", "1)", "1-"
        trimmed.match(/^([123])[️⃣]+/) ||              // "1️⃣"
        trimmed.match(/^(?:opci[oó]n\s+|la\s+|el\s+|opc\s*)?([123])\b/) ||  // "opcion 1", "el 1"
        trimmed.match(/\bopci[oó]n\s*([123])\b/);  // "elegiría la opción 3" (caso 5493424784464)
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

            await sendMessageWithDelay(userId, cmp1);

            _setStep(currentState, FlowStep.WAITING_PREFERENCE);
            saveState(userId);
            await sendMessageWithDelay(userId, cmp2);

            return { matched: true };
        }

        logger.info(`[INDICISION] User ${userId} compares products or asks for recommendation.`);

        const aiRecommendation = await aiService.chat(text, {
            step: FlowStep.WAITING_PREF_CONSULT,
            goal: `El usuario está indeciso entre productos o pide recomendaciones. Modelo V5 (rev. 2026-05-26): las 3 opciones (Cápsulas / Gotas / Semillas) se ofrecen IGUALES — no empujes una en particular. REGLAS:${notChoiceHint}
            1) Si el usuario MENCIONÓ EXPLÍCITAMENTE un producto (ej: "capsulas", "gotas", "semillas"), goalMet=true con extractedData del producto que dijo.
            2) Si el usuario está aceptando con un genérico ("dale", "bueno", "ok") SIN nombrar producto, NO ASUMAS — goalMet=false y re-preguntá "¿con cuál vas, cápsulas, gotas o semillas?".
            3) Si pide "lo más efectivo/mejor/rápido", "cualquiera" o "elegí vos": el cliente está DELEGANDO. Asumí Cápsulas (forma más práctica) PERO sin decir que son "más efectivas" — decí "Te traigo cápsulas que es la forma más práctica, las 3 funcionan igual". goalMet=true, extractedData="Cápsulas de nuez de la india".
            4) EMOCIÓN Y SALUD: Si cuenta su historia de peso, problemas médicos (tiroides, operaciones) o inseguridades, REDACTÁ UN PÁRRAFO EMPÁTICO validando sus sentimientos ANTES de cerrar nada. goalMet=false.
            5) Si tiene GASTRITIS / úlcera / acidez: recomendá cápsulas o gotas (semillas pueden irritar — es una contraindicación real). goalMet=false hasta que confirme.
            6) Si pide "info de las 3", "precio de las 3" o "todas": dale un resumen breve de las 3 opciones con sus precios de 60 días (del knowledge). NO empujes ninguna. Después preguntá cuál prefiere.
            7) Si pregunta por envío o medios de pago: envío gratis a todo el país. En Rosario y hasta 60 km lo llevamos nosotros y paga al recibir (efectivo, tarjeta o transferencia); al resto del país va por Correo Argentino prepago por ${prepayMeans(isMpEnabled(dependencies.config))}, a domicilio o sucursal, 4 días hábiles.${isMpEnabled(dependencies.config) ? '' : ' 🛑 El pago con tarjeta está fuera de servicio en estos días: NO lo ofrezcas ni lo menciones.'} NUNCA menciones cuotas ni anticipo. Después preguntá con cuál producto avanzar (la localidad se pregunta más adelante, no acá).
            8) HORARIOS DE ENVÍO: si pregunta a qué hora llega o pide un horario, respondé que no controlamos al cartero del Correo Argentino, pero que avisamos si no lo encuentran. Después preguntá con cuál producto avanzar.
            9) Si pide el TOTAL de dos productos o pregunta por un descuento, contestalo en ESTE mensaje con los precios de lista del knowledge (sumalos vos); nunca digas "te lo paso en el próximo mensaje".
            10) Si el cliente ya nombró producto Y plan (60 o 120 días), respondé su duda y NO cierres con una pregunta ni pidas la localidad ni los datos: el sistema manda el paso siguiente.`,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        // Quiere DOS productos en un pedido ("cápsulas para mí y gotas para mi
        // mamá, ¿cuánto todo junto?"). El pedido se arma de a un producto: en la
        // simulación del 24-nov-2026 salió una confirmación solo con las
        // cápsulas después de haberle dicho el total de las dos. La IA contesta
        // (el total) y el pedido lo arma una persona.
        const wantsBoth = !!knowledge?.flow?.prices_club && totalMatches > 1
            && /\b(las dos|los dos|ambas|ambos|todo junto|juntas|juntos)\b|\bpara\s+mi\b.*\bpara\s+(mi|la|el)\b|\b(capsul\w*|got\w*|semill\w*)\s+(?:de\s+\d+\s+)?(?:y|mas|\+)\s+(?:las\s+|unas\s+)?(capsul\w*|got\w*|semill\w*)/.test(normalizedText)
            && !/\b(cual|diferencia|mejor|conviene|recomend\w*)\b/.test(normalizedText);
        if (wantsBoth && aiRecommendation.response) {
            saveState(userId);
            await sendMessageWithDelay(userId, aiRecommendation.response);
            await sendMessageWithDelay(userId, 'Como son dos productos, el pedido te lo arma una asesora para que salga todo junto 🙌 Enseguida te escribe.');
            const { _pauseAndAlert } = require('../utils/flowHelpers');
            await _pauseAndAlert(userId, currentState, dependencies, text, `Quiere DOS productos en un mismo pedido ("${text.slice(0, 80)}"). Armar el pedido a mano.`);
            return { matched: true };
        }
        if (aiRecommendation.goalMet && aiRecommendation.extractedData && !aiSaysNotChoice) {
            // First send the AI's natural response if it exists (e.g., to answer a health question)
            if (aiRecommendation.response) {
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
                if (totalMatches <= 1 && await _advanceAfterAiAnswer(userId, text, currentState.selectedProduct as string, aiRecommendation.response, !!aiRecommendation.response, currentState, knowledge, dependencies)) return { matched: true };
                const msg = _formatMessage(priceNode.response, currentState);
                _setStep(currentState, priceNode.nextStep);
                saveState(userId);
                await sendMessageWithDelay(userId, msg);

                await _maybeSendPaymentMenuV7(userId, priceNode.nextStep, currentState, knowledge, dependencies);
                await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
                return { matched: true };
            }
        } else if (aiRecommendation.response) {
            await sendMessageWithDelay(userId, aiRecommendation.response);
            saveState(userId);
            return { matched: true };
        }
    }

    if (mentionsCapsulas) {
        _assignProductAndPlanByTier(currentState, "Cápsulas de nuez de la india");
        if (await _clubSkipPlanQuestion(userId, text, "Cápsulas de nuez de la india", currentState, knowledge, dependencies)) return { matched: true };
        const node = knowledge.flow.preference_capsulas;
        const msg = _pitchForGoal(_formatMessage(node.response, currentState), currentState);

        _setStep(currentState, node.nextStep);
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _maybeSendPaymentMenuV7(userId, node.nextStep, currentState, knowledge, dependencies);
        await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
        return { matched: true };
    } else if (mentionsSemillas) {
        _assignProductAndPlanByTier(currentState, "Semillas de nuez de la india");
        if (await _clubSkipPlanQuestion(userId, text, "Semillas de nuez de la india", currentState, knowledge, dependencies)) return { matched: true };
        const node = knowledge.flow.preference_semillas;
        const msg = _pitchForGoal(_formatMessage(node.response, currentState), currentState);

        _setStep(currentState, node.nextStep);
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _maybeSendPaymentMenuV7(userId, node.nextStep, currentState, knowledge, dependencies);
        await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
        return { matched: true };
    } else if (knowledge.flow.preference_gotas && mentionsGotas) {
        _assignProductAndPlanByTier(currentState, "Gotas de nuez de la india");
        if (await _clubSkipPlanQuestion(userId, text, "Gotas de nuez de la india", currentState, knowledge, dependencies)) return { matched: true };
        const node = knowledge.flow.preference_gotas;
        const msg = _pitchForGoal(_formatMessage(node.response, currentState), currentState);

        _setStep(currentState, node.nextStep);
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _maybeSendPaymentMenuV7(userId, node.nextStep, currentState, knowledge, dependencies);
        await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
        return { matched: true };
    } else {
        logger.info(`[AI-FALLBACK] waiting_preference: No keyword match for ${userId}`);
        const aiPref = await aiService.chat(text, {
            step: FlowStep.WAITING_PREFERENCE,
            goal: `Determinar qué producto prefiere el usuario: Cápsulas, Gotas o Semillas. Modelo V5 (rev. 2026-05-26): las 3 opciones se ofrecen IGUALES — no empujes una en particular.${notChoiceHint}
1) EMOCIÓN Y SALUD: Si hace un descargo sobre su peso, operaciones o inseguridades médicas, REDACTÁ MÚLTIPLES PÁRRAFOS demostrando altísima empatía y contención. Tono explayado y compasivo antes de cerrar nada.
2) Usá muletillas argentinas naturales ("dale", "tranqui", "te cuento") sin exagerar.
3) Si MENCIONA explícitamente un producto ("capsulas", "gotas", "semillas"), goalMet=true, extractedData con el producto.
4) Si solo dice "dale"/"si"/"bueno" SIN nombrar producto, NO asumas — goalMet=false y re-preguntá "¿con cuál te gustaría avanzar: cápsulas, gotas o semillas?".
5) Si pide "lo más efectivo/mejor/rápido", "cualquiera" o "elegí vos": el cliente delega. Asumí cápsulas (forma más práctica) PERO aclarando que las 3 funcionan igual. extractedData="PRODUCTO: Cápsulas de nuez de la india".
6) Si habla en PASADO ("yo tomaba semillas"): preguntá si quiere repetir o probar otra forma — no le impongas cápsulas.
7) Si tiene gastritis/úlcera/acidez: recomendá cápsulas o gotas (semillas pueden irritar). goalMet=false hasta que confirme.
8) Si pide información o precios de "las 3", brindá explicación breve de las 3 formas con precios de 60 días (knowledge). Después preguntá cuál prefiere.
9) Si pregunta si puede pagar/recibir un día concreto: dale el OK y volvé a la elección de producto.
10) Si pregunta por envío o medios de pago: envío gratis a todo el país (Rosario y 60 km → lo llevamos nosotros, paga al recibir; resto → Correo prepago por ${prepayMeans(isMpEnabled(dependencies.config))}, 4 días hábiles).${isMpEnabled(dependencies.config) ? '' : ' 🛑 El pago con tarjeta está fuera de servicio en estos días: NO lo ofrezcas ni lo menciones.'} NUNCA menciones anticipo ni cuotas. Después preguntá producto.
11) Si pide el TOTAL de dos productos o pregunta por un descuento, contestalo en ESTE mensaje con los precios de lista del knowledge (sumalos vos); nunca digas "te lo paso en el próximo mensaje".
12) Si el cliente ya nombró producto Y plan (60 o 120 días), respondé su duda y NO cierres con una pregunta ni pidas la localidad ni los datos: el sistema manda el paso siguiente.`,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiPref.goalMet && aiPref.extractedData && !aiSaysNotChoice) {
            // First send the AI's natural response if it exists (e.g., to answer a health question).
            // Si el cliente solo eligió ("la natural", "esa") no hay nada que responder:
            // la plantilla de precios confirma la elección. Mandar las dos generaba
            // doble mensaje y la IA a veces preguntaba la localidad antes de tiempo.
            const onlyChose = !hasQuestionOrConcern && text.trim().split(/\s+/).length <= 8;
            if (aiPref.response && !onlyChose) {
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
                if (totalMatches <= 1 && await _advanceAfterAiAnswer(userId, text, currentState.selectedProduct as string, aiPref.response, !!aiPref.response && !onlyChose, currentState, knowledge, dependencies)) return { matched: true };
                const msg = _formatMessage(priceNode.response, currentState);
                _setStep(currentState, priceNode.nextStep);
                saveState(userId);
                await sendMessageWithDelay(userId, msg);

                await _maybeSendPaymentMenuV7(userId, priceNode.nextStep, currentState, knowledge, dependencies);
                await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
                return { matched: true };
            }
        }

        if (aiPref.response) {
            await sendMessageWithDelay(userId, aiPref.response);
            saveState(userId);
            return { matched: true };
        }
    }
    return { matched: false };
}
