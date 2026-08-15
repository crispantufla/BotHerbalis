import { UserState, FlowStep } from '../../types/state';
import { _getPrice } from '../utils/pricing';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import { buildCartFromSelection, calculateTotal } from '../utils/cartHelpers';
import { _isDuplicate } from '../utils/messages';
import { buildPaymentMessage } from '../../utils/messageTemplates';
import { MARKET } from '../../config/market';
import logger from '../../utils/logger';

// Detector de intención de venir en persona a por el pedido.
// La empresa NO tiene tienda física abierta al público — todo sale por
// Correos. Si el cliente quiere "ir a la tienda" o pasar a recogerlo por
// nuestras instalaciones, pausamos para que lo coordine una persona (no es lo
// mismo que la recogida en oficina de Correos, que sí ofrecemos).
const PICKUP_INTENT = /\b(voy\s+(?:yo|a\s+(?:la\s+)?tienda|al?\s+local)|paso\s+por\s+(?:la\s+)?tienda|ir\s+a\s+(?:la\s+)?tienda|ir\s+al?\s+local|ten[ée]is\s+tienda|ten[ée]is\s+local|d[óo]nde\s+est[áa]is|llev[aá]rmelo\s+yo)\b/i;

function _isPickupOrRosarioIntent(text: string): boolean {
    return PICKUP_INTENT.test(text);
}

async function _handlePickupIntent(userId: string, text: string, currentState: UserState, dependencies: any): Promise<boolean> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const reply = `Te comento: no tenemos tienda física de venta al público — todos los pedidos salen por ${MARKET.carrier} con envío gratis 📦\n\nEnseguida te escribe un asesor para buscar la mejor opción (que te lo llevemos a casa o que lo recojas en tu ${MARKET.pickupPointName}) 😊`;
    currentState.history.push({ role: 'bot', content: reply, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, reply);
    await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente quiere venir en persona / pregunta por tienda física. No tenemos tienda abierta al público — coordinar logística (oficina de Correos o domicilio).');
    return true;
}

const _buildPaymentMsg = (state: UserState, knowledge?: any) => buildPaymentMessage(state, knowledge);

function _handleExtractedData(userId: string, extractedData: string, currentState: UserState) {
    if (!extractedData || extractedData === 'null') return;
    logger.info(`[DATA EXTRACTION] User ${userId}: ${extractedData}`);

    if (extractedData.startsWith('PROFILE:')) {
        const profileData = extractedData.replace('PROFILE:', '').trim();
        currentState.profile = currentState.profile ? `${currentState.profile} | ${profileData}` : profileData;
        logger.info(`[PROFILE SAVED] ${currentState.profile}`);
    } else if (extractedData === 'CHANGE_ORDER') { //Logic
        currentState.cart = [];
        currentState.pendingOrder = null;
        currentState.partialAddress = {};
        currentState.selectedProduct = null;
        currentState.selectedPlan = null;
    } else if (extractedData.startsWith('POSTDATADO:')) {
        const fecha = extractedData.replace('POSTDATADO:', '').trim();
        currentState.postdatado = fecha;
        logger.info(`[POSTDATADO SAVED] Fecha: ${fecha}`);
    }
}

export async function handleWaitingPlanChoice(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // ── Check temprano: cliente quiere venir en persona a una tienda ──────
    if (_isPickupOrRosarioIntent(text)) {
        const handled = await _handlePickupIntent(userId, text, currentState, dependencies);
        if (handled) return { matched: true };
    }

    // ── Cliente ya saltó a elegir la ENTREGA junto con (o después de) el plan ──
    // Si menciona recogida/domicilio/pago-al-recibir y tenemos plan (del mensaje o
    // el ya elegido), NO re-preguntamos el menú: fijamos el plan y delegamos a
    // handleWaitingPaymentMethod, que tiene todo el ruteo. Evita el doble mensaje
    // "¿me pasas tu nombre?" + "¿en casa o lo recoges?".
    const SHIPPING_PAY_SIGNAL = /\b(recog(?:er|ida|erlo)|lo recojo|en correos|oficina de correos|contra.?re?embolso|al recibir|cuando (?:lo |la )?reciba|a domicilio|a mi casa|a mi domicilio|en casa)\b/i;
    if (SHIPPING_PAY_SIGNAL.test(normalizedText)) {
        const planInMsg = normalizedText.match(/\b(60|120)\b/);
        const plan = planInMsg ? planInMsg[1] : (currentState.selectedPlan || null);
        if (plan && currentState.selectedProduct) {
            buildCartFromSelection(currentState.selectedProduct, plan, currentState);
            _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
            saveState(userId);
            logger.info(`[PLAN_CHOICE] ${userId} ya indicó envío/pago con plan ${plan} ("${text.slice(0, 40)}") → delego a waiting_payment_method (sin re-preguntar el menú).`);
            const { handleWaitingPaymentMethod } = require('./stepWaitingPaymentMethod');
            return await handleWaitingPaymentMethod(userId, text, normalizedText, currentState, knowledge, dependencies);
        }
    }

    const products = [
        // OJO: se corre sobre normalizedText (sin acentos). El alternante `t[ée]`
        // (para "té"/infusión) matcheaba la palabra ubicua "te" → cualquier
        // "te puedo pagar", "te las encargo", etc. seteaba producto=Semillas. Eso
        // pisó la elección real de Cápsulas y generó links/cobros del producto
        // equivocado (caso 5491131381951: "Con tarjeta te puedo pagar 60" → Semillas
        // $36.900 en vez de Cápsulas $49.900). Sin acentos "té" y "te" son iguales,
        // así que ese alternante es imposible de usar sin falsos positivos: se quita.
        { match: /c[áa]psula|pastilla/i, name: 'Cápsulas' },
        { match: /semilla|infusi[óo]n|yuyo/i, name: 'Semillas' },
        { match: /gota/i, name: 'Gotas' },
        { match: /nuez|nueces/i, name: 'Semillas' }
    ];

    const plans = [
        { match: /60/, id: '60' },
        { match: /120/, id: '120' }
    ];

    let foundItems = [];
    const parts = normalizedText.split(/\b(y|e|con|mas)\b|,|\+/);

    for (const part of parts) {
        if (!part || part.trim().length < 3) continue;
        let p = null;
        let pl = null;

        // Gana el PRIMER match (más específico primero: Cápsulas antes que el
        // catch-all "nuez"→Semillas). Sin el break ganaba el último, así que
        // "cápsulas de nuez" caía a Semillas igual que el bug del `t[ée]`.
        for (const prod of products) if (prod.match.test(part)) { p = prod.name; break; }
        for (const plan of plans) if (plan.match.test(part)) pl = plan.id;

        if (p && pl) {
            foundItems.push({
                product: p,
                plan: pl,
                price: _getPrice(p, pl)
            });
        }
    }

    if (foundItems.length > 0) {
        currentState.cart = foundItems;
        // Setear selectedProduct/Plan + recalcular totalPrice. Sin esta línea
        // el state quedaba con `totalPrice` undefined y al elegir MP el bot
        // tiraba "Monto inválido" en _generateAndSendLink.
        if (foundItems.length === 1) {
            currentState.selectedProduct = foundItems[0].product;
            currentState.selectedPlan = foundItems[0].plan;
        }
        calculateTotal(currentState);

        const paymentMsg = _buildPaymentMsg(currentState, knowledge);
        currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
        _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
        saveState(userId);
        await sendMessageWithDelay(userId, paymentMsg);
        return { matched: true };
    }

    let planSelected = false;
    let selectedPlanId = null;

    // GUARD: Detect any questions OR objections BEFORE interpreting numbers as plan selection blindly
    // e.g. "el de 120 cuánto sale", "quiero el de 60, como se toma?", "el de 60 pero me cuesta tragar", "cuanto bajo en 60 dias?"
    // Also catch objections like "no me conviene por el envio", "es muy caro el de 60"
    // If the user has a question/objection AND a plan, we want the AI to handle it so it answers their concern first.
    const hasQuestionText = /\b(como|cómo|cuando|cuándo|que|qué|donde|dónde|por que|por qué|cual|cuál|duda|consulta|consulto|precio|costo|sale|cuesta|valor|paga|cobr|tarjeta|efectivo|transferencia|diabetes|diabetica|presion|hipertens|salud|enfermedad|tiroides|hipotiroidismo|operada|cirugia|bypass|manga|estomago|gastritis|acidez|contraindicaciones|efectos|mal|dieta|rebote|tragar|ahogar|grandes|cuestan|complicado|dificil|seguridad|garantia|garantía|garantiza|efectiva|efectivo|funciona|seguro|cuanto|cuánto|cuantos|cuántos|kilo|kilos|bajar|bajo|envio|envío|conviene|caro|carisimo|no me conviene|no me sirve|esperar|espera|aguardar|aguanta|bancame|recien|recién|cobro|cobre|sueldo|quincena|depositan|pagan|plata|pensar|pienso|despues|después|luego|mañana|aviso)\b/i.test(normalizedText) || text.includes('?');

    // If text is super long (like a transcription), force AI to handle it so we don't look robotic
    const isVeryLongMessage = text.split(/\s+/).length > 20;

    // PRE-GUARD: If the user says exactly "el de 60", "plan de 60", "quiero el 60", bypass the question guard
    // for the plan selection (we still want AI to answer the question, but we lock the cart first)
    const strictPlanMatch = normalizedText.match(/\b(el de|plan de|quiero el|opcion de|promo de)\s*(60|120|180|240|300|360|420|480|540|600)\b/i);
    const planMatch = normalizedText.match(/\b(60|120|180|240|300|360|420|480|540|600)\b/);

    // Semantic shortcuts — captura formas naturales sin necesidad de IA.
    // El plan "recomendado" en los mensajes es siempre el 120 (envío bonificado).
    // Reglas estrictas:
    // (a) Calificativos solos ("largo", "caro", "barato") deben venir con verbo de
    //     elección ("quiero", "dame", "elijo", "prefiero", "agarro", "voy con") —
    //     evita falsos positivos como "el largo plazo me preocupa".
    // (b) Frases explícitas de plan ("el de 120", "plan 60", "cuatro meses") matchean
    //     directamente.
    const planVerbAnchor = /(?:^|\s)(?:quiero|quisiera|dame|me das|elijo|prefiero|prefiero el|agarro|voy con|voy por|me voy con|me llevo|me quedo con|reservame|tomo|tomate|llevo|me sirve|me conviene|me gusta|le metemos|le doy|dale|empiezo)\b/i;
    const semantic120Strict = /\b(el (de )?(?:120|ciento veinte|cuatro meses|4 meses)|plan (de )?(?:120|cuatro meses|4 meses)|cuatro meses|4 meses|el de cuatro|el de 4|le metemos con (el )?120|dale (al )?(de )?120|tratamiento completo)\b/i;
    const semantic60Strict = /\b(el (de )?(?:60|sesenta|dos meses|2 meses)|plan (de )?(?:60|dos meses|2 meses)|dos meses|2 meses|el de dos|el de 2|el de inicio|arrancamos con (el )?60|empiezo con (el )?60|el corto)\b/i;
    const semantic120Weak = /\b(?:el|al)\s+(?:m[áa]s\s+)?(largo|grande|completo|recomendado|caro|bonificado)\b/i;
    const semantic60Weak = /\b(?:el|al)\s+(?:m[áa]s\s+)?(chico|barato|inicial|peque[ñn]o)\b/i;
    const has120Strict = semantic120Strict.test(normalizedText);
    const has60Strict = semantic60Strict.test(normalizedText);
    // Los "weak" matcheán cuando hay verbo de elección, O cuando el mensaje es
    // corto (≤4 palabras): "el más barato" solo casi siempre es elección de plan.
    const hasVerb = planVerbAnchor.test(normalizedText);
    const wordCount = normalizedText.trim().split(/\s+/).length;
    const isShortReply = wordCount <= 4;
    const has120Weak = (hasVerb || isShortReply) && semantic120Weak.test(normalizedText);
    const has60Weak = (hasVerb || isShortReply) && semantic60Weak.test(normalizedText);
    const has120 = has120Strict || has120Weak;
    const has60 = has60Strict || has60Weak;

    if (strictPlanMatch && !isVeryLongMessage) {
        selectedPlanId = strictPlanMatch[2];
    } else if (has120 && !has60 && !isVeryLongMessage) {
        selectedPlanId = '120';
    } else if (has60 && !has120 && !isVeryLongMessage) {
        selectedPlanId = '60';
    } else if (planMatch && !hasQuestionText && !isVeryLongMessage) {
        selectedPlanId = planMatch[1];
    }

    if (selectedPlanId) {
        const product = currentState.selectedProduct || "Nuez de la India";
        buildCartFromSelection(product, selectedPlanId, currentState);
        planSelected = true;
    }

    if (planSelected) {
        const addr = currentState.partialAddress || {};
        const hasAddress = addr.nombre && addr.calle && addr.ciudad;

        if (hasAddress) {
            logger.info(`[FLOW-SKIP] Address already collected for ${userId}, asking payment method.`);
            const paymentMsg = _buildPaymentMsg(currentState, knowledge);
            currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, paymentMsg);
            _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
        } else {
            const paymentMsg = _buildPaymentMsg(currentState, knowledge);
            currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, paymentMsg);
            _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
        }

        saveState(userId);
        return { matched: true };
    } else {
        const { _isAffirmative } = require('../utils/validation');
        const isAffirmative = _isAffirmative(normalizedText);

        let recentBotMessages = "";
        let botMsgCount = 0;
        for (let i = currentState.history.length - 1; i >= 0; i--) {
            if (currentState.history[i].role === 'bot') {
                recentBotMessages += currentState.history[i].content.toLowerCase() + " ";
                botMsgCount++;
                if (botMsgCount >= 2) break;
            }
        }

        const aiRecommended120 = recentBotMessages.includes('recomendaría el de 120')
            || recentBotMessages.includes('recomendaría el plan de 120')
            || recentBotMessages.includes('te recomendaría el de 120')
            || recentBotMessages.includes('mejor opción para ti es el de 120')
            || (recentBotMessages.includes('120') && !recentBotMessages.includes('60'))
            || (recentBotMessages.includes('120') && recentBotMessages.includes('recomen'));

        if (isAffirmative && aiRecommended120) {
            logger.info(`[FLOW-INTERCEPT] User said OK to 120-day plan upsell/AI recommendation: ${userId}`);

            const product = currentState.selectedProduct || "Nuez de la India";
            buildCartFromSelection(product, '120', currentState);

            const addr = currentState.partialAddress || {};
            const hasAddress = addr.nombre && addr.calle && addr.ciudad;

            if (hasAddress) {
                logger.info(`[FLOW-SKIP] Address already collected for ${userId}, asking payment method after upsell.`);
                const paymentMsg = `¡Genial! 😊 Entonces confirmamos el plan de 120 días. Ya tengo tus datos de envío de antes.\n\n` + _buildPaymentMsg(currentState, knowledge);
                currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, paymentMsg);
                _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
            } else {
                const paymentMsg = `¡Genial! 😊 Entonces confirmamos el plan de 120 días.\n\n` + _buildPaymentMsg(currentState, knowledge);
                currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, paymentMsg);
                _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
            }

            saveState(userId);
            return { matched: true };
        } else {
            logger.info(`[AI-FALLBACK] waiting_plan_choice: No plan number detected for ${userId}`);

            // Anti-repetición de cierre en consulta: el steer genérico no alcanza —
            // Claude a veces repite textual la misma pregunta de plan dos turnos
            // seguidos (queja admin 2026-06-13). Le pasamos su cierre anterior como
            // frase PROHIBIDA explícita, que sí respeta.
            let _antiRepeat = '';
            {
                const _lastBot = [...currentState.history].reverse().find((h) => h.role === 'bot' && typeof h.content === 'string');
                const _m = _lastBot && _lastBot.content.match(/([^?\n]*\b(?:60|120)\b[^?\n]*\?)\s*$/i);
                if (_m) _antiRepeat = `\n\n🚫 ANTI-REPETICIÓN: tu cierre anterior fue exactamente "${_m[1].trim()}". PROHIBIDO cerrar este mensaje con esa misma frase o una casi idéntica — usa una formulación claramente distinta (o, si ya preguntaste el plan hace poco, cierra con una válvula suave sin plan).`;
            }

            const planAI = await aiService.chat(text, {
                step: 'waiting_plan_choice',
                goal: `El usuario debe elegir un plan (60 o 120 días).
RESPONDE CON NATURALIDAD, COMO UNA PERSONA. NO SEAS ROBÓTICA.
1) SI EL USUARIO HACE PREGUNTAS (ej: "cómo se toma", "tiene contraindicaciones", sobre su salud, o pide info de otro producto): TÓMATE TODO EL ESPACIO NECESARIO. Respóndele con párrafos detallados y con muchísima empatía. Puedes extenderte sobre cómo se toma, la composición, la duración de cada plan, el envío gratis, el pago al recibir y el acompañamiento por WhatsApp. PROHIBIDO: es un complemento alimenticio, no un tratamiento — nunca hables de kilos ni de tallas, ni de bajar/perder peso ni de adelgazar, ni de grasa, metabolismo, toxinas o detox, ni des plazos para notar nada, ni prometas o garantices resultados (tampoco "sin efecto rebote" ni "que se mantenga"). Habla siempre de acompañar los hábitos, el bienestar digestivo, el control del peso y la constancia. ETAPA DE CONSULTA — VARÍA EL CIERRE, NO LO REPITAS TEXTUAL: responde la duda con calidez y cierra invitando a elegir plan, PERO cambia la frase en CADA turno. NUNCA repitas palabra por palabra "¿te gustaría seguir con el plan de 60 o de 120 días?" en mensajes seguidos — suena a copiar y pegar. Alterna formas naturales: "entonces, ¿qué plan te convence más, el de 60 o el de 120?", "¿lo preparamos de 60 o de 120?", "¿con cuál te quedas?", y de vez en cuando una válvula suave sin plan ("¿alguna otra duda antes de seguir? 😊"). MIRA TU CIERRE ANTERIOR en el historial: si tu último mensaje ya cerró con una de esas frases, usa una DISTINTA ahora — NUNCA repitas la misma fórmula dos turnos seguidos. Que parezca una conversación, no una insistencia.  goalMet=false.
2) SI PREGUNTA CUÁNTOS KILOS BAJARÁ, cuánto tarda en notarse o pide garantías: NO des cifras, ni tallas, ni plazos, ni garantías de ningún tipo, y NO repitas los kilos que él haya mencionado. Responde textualmente "Te soy sincera: es un complemento alimenticio que acompaña tus hábitos y tu rutina, así que no te voy a prometer un resultado — cada persona es distinta. Lo que sí sé es que la clave está en la constancia, y por eso la mayoría se queda con el plan largo y no se queda a medias. Además me tienes aquí por WhatsApp para lo que necesites durante todo el plan 😊" Luego pregúntale con qué plan quiere seguir. goalMet=false.
3) CAMBIO DE PRODUCTO: Si el usuario dice "quiero semillas" o "gotas", confirma el cambio usando extractedData="CHANGE_PRODUCT: [Producto]" (SIN preguntarle de nuevo) y dale los precios de ese producto para que elija el plan. goalMet=false.
4) Si el usuario confirma explícitamente un plan (ej: "el de 60" o "120") en su mensaje y además pregunta algo: responde su pregunta con todo el detalle necesario, PERO OBLIGATORIAMENTE DEBES PONER el número de plan en "extractedData" (ej: "60" o "120") y poner goalMet=true. NUNCA pongas goalMet=true si en extractedData devuelves null.
5) COBRO/NÓMINA CERCANA ("cobro el viernes", "me ingresan el jueves"): NO es motivo para aplazar el pedido. Es CONTRA REEMBOLSO: no paga nada ahora, paga al recibirlo, y además tarda ${MARKET.deliveryDaysHome} en llegar, así que le da margen de sobra. Tranquilízale y pregúntale con qué plan quiere seguir. goalMet=false, NO extraigas POSTDATADO.
6) EXCUSAS TEMPORALES LEJANAS ("hasta el mes que viene no", "a final de mes", "cobro el 15", "ya te digo"): Si la fecha es a más de 10 días, ofrece APLAZAR el envío directamente. Responde: "¡Sin problema! Te lo dejo anotado para el día que me digas y lo mandamos ese día. ¿A partir de cuándo te viene bien recibirlo?". Si dicen SÍ o dan fecha → extrae POSTDATADO: [fecha] y pregunta con qué plan seguir. Si insisten en que no, entonces sí acéptalo. PROHIBIDO hablar de "congelar el precio" o de ofertas que caducan.
7) OBJECIÓN DE PRECIO O CONVENIENCIA (ej: "el de 60 no me sale a cuenta"): Responde con mucha empatía y recalca que el de 120 es el más elegido porque sale mejor de precio por día y rinde el doble. Intenta que elija el de 120, pero sé amable si insiste en el de 60. goalMet=false.
8) HORARIO DE ENTREGA: Si pregunta cuándo o a qué hora llega, aclara que ${MARKET.carrier} gestiona su propio reparto y no podemos asegurar la hora, pero que si no está en casa se lo dejan en su ${MARKET.pickupPointName}. Luego vuelve al plan. goalMet=false.${_antiRepeat}`,
                history: currentState.history,
                summary: currentState.summary,
                knowledge: knowledge,
                userState: currentState
            });

            if (planAI.extractedData && typeof planAI.extractedData === 'string' && planAI.extractedData.startsWith('CHANGE_PRODUCT:')) {
                const newProd = (planAI.extractedData.split(':')[1] || '').trim();
                logger.info(`[FLOW-UPDATE] User changed product to: ${newProd}`);
                currentState.selectedProduct = newProd;
                saveState(userId);
            }

            if (planAI.goalMet && planAI.extractedData && !planAI.extractedData.startsWith('CHANGE_PRODUCT:')) {
                const extractedStr = String(planAI.extractedData);
                _handleExtractedData(userId, extractedStr, currentState);

                if (extractedStr.startsWith('POSTDATADO:') && currentState.selectedProduct) {
                    // The user might have specified the plan ALONG WITH the postdate
                    // (e.g., "espero al 27 y quiero el de 60")
                    let userChosePlan = extractedStr.match(/\b(60|120|180|240|300|360|420|480|540|600)\b/);
                    if (!userChosePlan) userChosePlan = normalizedText.match(/\b(60|120|180|240|300|360|420|480|540|600)\b/);
                    
                    if (userChosePlan) {
                        const plan = userChosePlan[1];
                        const product = currentState.selectedProduct || "Nuez de la India";
                        buildCartFromSelection(product, plan, currentState);
                        logger.info(`[FLOW-UPDATE] Saved plan ${plan} along with POSTDATADO.`);
                    }

                    if (planAI.response) {
                        currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, planAI.response);
                    }
                    const paymentMsgPost = _buildPaymentMsg(currentState, knowledge);
                    currentState.history.push({ role: 'bot', content: paymentMsgPost, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, paymentMsgPost);
                    _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
                    saveState(userId);
                    return { matched: true };
                }
                else if (/\b(60|120|180|240|300|360|420|480|540|600)\b/.test(extractedStr)) {
                    const planMatchAI = extractedStr.match(/\b(60|120|180|240|300|360|420|480|540|600)\b/);
                    const plan = planMatchAI ? planMatchAI[1] : '60';
                    const product = currentState.selectedProduct || "Nuez de la India";

                    buildCartFromSelection(product, plan, currentState);

                    const addr = currentState.partialAddress || {};
                    const hasAddress = addr.nombre && addr.calle && addr.ciudad;

                    if (hasAddress) {
                        logger.info(`[FLOW-SKIP] Address already collected for ${userId}, asking payment method after AI plan.`);
                        if (planAI.response) {
                            currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                            await sendMessageWithDelay(userId, planAI.response);
                        }
                        const paymentMsg = _buildPaymentMsg(currentState, knowledge);
                        currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, paymentMsg);
                        _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
                    } else {
                        if (planAI.response) {
                            currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                            await sendMessageWithDelay(userId, planAI.response);
                        }
                        const paymentMsgAI = _buildPaymentMsg(currentState, knowledge);
                        currentState.history.push({ role: 'bot', content: paymentMsgAI, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, paymentMsgAI);
                        _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
                    }

                    saveState(userId);
                    return { matched: true };
                } else {
                    logger.warn(`[AI-SAFEGUARD] waiting_plan_choice: AI returned goalMet=true but no 60/120/180/240 etc in extractedData (${extractedStr}). Downgrading to false.`);
                    if (planAI.response) {
                        currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, planAI.response);
                        saveState(userId);
                        return { matched: true };
                    }
                }
            } else if (planAI.response) {
                // Anti-duplicate protection logic
                if (_isDuplicate(planAI.response, currentState.history)) {
                    logger.info(`[ANTI-DUP] Skipping duplicate AI response for ${userId} in plan_choice`);
                    const fallbackMsg = "¡Perfecto! Quedo a tu disposición para cuando me digas 😊";
                    currentState.history.push({ role: 'bot', content: fallbackMsg, timestamp: Date.now() });
                    await sendMessageWithDelay(userId, fallbackMsg);
                    saveState(userId);
                    return { matched: true };
                }

                if (planAI.extractedData) _handleExtractedData(userId, planAI.extractedData, currentState);
                currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                await sendMessageWithDelay(userId, planAI.response);
                saveState(userId);

                // Setup Follow Up check for delayed answers ("despues hablamos")
                if (planAI.response.includes('después hablamos') || planAI.response.includes('cualquier cosa aquí estoy')) {
                    // Just set state as paused or track time, cron cleans up cold leads next day
                    logger.info(`[FLOW] User ${userId} delayed step. Will follow up later.`);
                }

                return { matched: true };
            }
        }
    }
    return { matched: false };
}
