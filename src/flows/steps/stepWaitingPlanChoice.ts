import { UserState, FlowStep } from '../../types/state';
import { _getPrice, _getAdicionalMAX } from '../utils/pricing';
import { _setStep } from '../utils/flowHelpers';
import { buildCartFromSelection, calculateTotal } from '../utils/cartHelpers';
import { _isDuplicate } from '../utils/messages';
import logger from '../../utils/logger';

function _buildPaymentMsg(currentState: UserState): string {
    const plan = currentState.selectedPlan || currentState.cart?.[0]?.plan || '60';
    const adicional = currentState.adicionalMAX || _getAdicionalMAX();
    const adicionalStr = adicional.toLocaleString('es-AR');
    const plan60AdicionalLine = plan === '60'
        ? `\n   ▸ +$${adicionalStr} de adicional en plan 60 días (bonificado en 120)`
        : `\n   ▸ Sin adicional (bonificado en plan 120 días) ✅`;
    return `¿Cómo preferís abonar?\n📦 *En todos los casos el envío es SIN COSTO*\n\n` +
        `1️⃣ *MercadoPago* 💳 — Pagás ahora con tarjeta, débito o saldo MP.\n` +
        `   Podés abonar en *3, 6 o 9 cuotas sin interés* 🎉\n` +
        `   Demora: 4 a 6 días hábiles 🚀\n\n` +
        `2️⃣ *Transferencia bancaria* — Sin recargos.\n` +
        `   Demora: 4 a 6 días hábiles\n\n` +
        `3️⃣ *Contra reembolso* — Pagás al cartero cuando te llega (solo en efectivo).${plan60AdicionalLine}\n` +
        `   Demora: 7 a 10 días hábiles\n\n` +
        `¿Cuál te resulta más cómoda?`;
}

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

    const products = [
        { match: /c[áa]psula|pastilla/i, name: 'Cápsulas' },
        { match: /semilla|infusi[óo]n|t[ée]|yuyo/i, name: 'Semillas' },
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

        for (const prod of products) if (prod.match.test(part)) p = prod.name;
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
        let applyMax = false;
        if (foundItems.length === 1 && foundItems[0].plan === '60') {
            applyMax = true;
        }

        currentState.isContraReembolsoMAX = applyMax;
        currentState.adicionalMAX = applyMax ? _getAdicionalMAX() : 0;
        currentState.cart = foundItems;
        // Setear selectedProduct/Plan + recalcular totalPrice. Sin esta línea
        // el state quedaba con `totalPrice` undefined y al elegir MP el bot
        // tiraba "Monto inválido" en _generateAndSendLink.
        if (foundItems.length === 1) {
            currentState.selectedProduct = foundItems[0].product;
            currentState.selectedPlan = foundItems[0].plan;
        }
        calculateTotal(currentState);

        const paymentMsg = _buildPaymentMsg(currentState);
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
        const closingNode = knowledge.flow.closing;
        const addr = currentState.partialAddress || {};
        const hasAddress = addr.nombre && addr.calle && addr.ciudad;

        if (hasAddress) {
            logger.info(`[FLOW-SKIP] Address already collected for ${userId}, asking payment method.`);
            const paymentMsg = _buildPaymentMsg(currentState);
            currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, paymentMsg);
            _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
        } else {
            const paymentMsg = _buildPaymentMsg(currentState);
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
            || recentBotMessages.includes('mejor opción para vos es el de 120')
            || (recentBotMessages.includes('120') && !recentBotMessages.includes('60'))
            || (recentBotMessages.includes('120') && recentBotMessages.includes('recomen'));

        if (isAffirmative && aiRecommended120) {
            logger.info(`[FLOW-INTERCEPT] User said OK to 120-day plan upsell/AI recommendation: ${userId}`);

            const product = currentState.selectedProduct || "Nuez de la India";
            buildCartFromSelection(product, '120', currentState);

            const closingNode = knowledge.flow.closing;
            const addr = currentState.partialAddress || {};
            const hasAddress = addr.nombre && addr.calle && addr.ciudad;

            if (hasAddress) {
                logger.info(`[FLOW-SKIP] Address already collected for ${userId}, asking payment method after upsell.`);
                const paymentMsg = `¡Genial! 😊 Entonces confirmamos el plan de 120 días. Ya tengo tus datos de envío de antes.\n\n` + _buildPaymentMsg(currentState);
                currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, paymentMsg);
                _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
            } else {
                const paymentMsg = `¡Genial! 😊 Entonces confirmamos el plan de 120 días.\n\n` + _buildPaymentMsg(currentState);
                currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, paymentMsg);
                _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
            }

            saveState(userId);
            return { matched: true };
        } else {
            logger.info(`[AI-FALLBACK] waiting_plan_choice: No plan number detected for ${userId}`);

            const planAI = await aiService.chat(text, {
                step: 'waiting_plan_choice',
                goal: `El usuario debe elegir un plan (60 o 120 días).
RESPONDÉ NATURALMENTE Y COMO HUMANO. NO SEAS ROBÓTICA.
1) SI EL USUARIO HACE PREGUNTAS (ej: "cómo se toma", "tiene contraindicaciones", sobre su salud, o pide info de otro producto): TÓMATE TODO EL ESPACIO NECESARIO. Respóndele con párrafos muy detallados, extensos y con muchísima empatía. Explayate sobre los efectos del producto, dietas o garantías si lo piden. Y después preguntá sutilmente con cuál plan avanzar. goalMet=false.
2) SI PREGUNTA CUÁNTOS KILOS BAJARÁ o pide garantías: Respondé textualmente "Cada cuerpo tiene su ritmo. Quienes tienen más kilos para bajar suelen notar cambios más visibles al inicio, y quienes necesitan bajar menos ven descensos más progresivos. Lo importante es que el descenso sea natural y sostenido." Luego preguntale con cuál plan quiere avanzar. goalMet=false.
3) CAMBIO DE PRODUCTO: Si el usuario dice "quiero semillas" o "gotas", confirmá el cambio usando extractedData="CHANGE_PRODUCT: [Producto]" (SIN preguntarle de nuevo) y dale los precios de ese nuevo producto para que elija el plan. goalMet=false.
4) Si el usuario confirma explícitamente un plan (ej: "el de 60" o "120") en su mensaje y también pregunta algo: respondé su pregunta explayándote todo lo necesario, PERO OBLIGATORIAMENTE DEBES PONER el número de plan en "extractedData" (ej: "60" o "120") y establecer goalMet=true. NUNCA pongas goalMet=true si en extractedData devuelves null.
5) COBRO/SUELDO CERCANO ("cobro el viernes", "cobro el lunes", "me depositan el jueves"): Si el usuario dice que cobra en los próximos días (un día de la semana), NO es excusa para postdatar. El envío tarda de 7 a 10 días hábiles, así que para cuando le llegue ya va a haber cobrado. Tranquilizalo diciéndole eso y preguntale con cuál plan quiere avanzar. goalMet=false, NO extraigas POSTDATADO.
6) EXCUSAS TEMPORALES LEJANAS ("recién el mes que viene", "no tengo ahora", "a fin de mes", "cobro el 15", "después te aviso"): Si la fecha es a más de 10 días, DEBES FRENAR LA OBJECIÓN OFRECIENDO CONGELAR EL PRECIO. Respondé: "¡No hace falta que lo pagues ahora! Podemos dejar el pedido cargado hoy para congelarte la promo actual, y yo te lo envío recién cuando cobres o cuando me digas. ¿A partir de qué fecha te quedaría bien recibirlo?". Si dicen SÍ o dan fecha → extraé POSTDATADO: [fecha] y preguntá con cuál plan avanzar. Si insisten en NO definitivamente, recién ahí aceptá.
7) OBJECCIÓN DE ENVÍO O CONVENIENCIA (ej: "el de 60 no me conviene por el envío", "es caro el envío"): Respondé con mucha empatía explicando que el costo del envío en el plan de 60 es por el servicio de pago en destino que cobra el correo, y recalca que por eso el de 120 es la opción más elegida ya que tiene el ENVÍO GRATIS y rinde el doble. Intentá que elija el de 120 pero sé amable si insiste en el de 60. goalMet=false.
8) HORARIO DE ENVÍO: Si pregunta cuándo o a qué hora llega, aclará que Correo Argentino maneja su propia logística y no podemos asegurar el horario, pero que avisamos si hay que retirar. Luego volvé al plan. goalMet=false.`,
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
                    const closingNode = knowledge.flow.closing;
                    
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
                    const paymentMsgPost = _buildPaymentMsg(currentState);
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

                    const closingNode = knowledge.flow.closing;
                    const addr = currentState.partialAddress || {};
                    const hasAddress = addr.nombre && addr.calle && addr.ciudad;

                    if (hasAddress) {
                        logger.info(`[FLOW-SKIP] Address already collected for ${userId}, asking payment method after AI plan.`);
                        if (planAI.response) {
                            currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                            await sendMessageWithDelay(userId, planAI.response);
                        }
                        const paymentMsg = _buildPaymentMsg(currentState);
                        currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
                        await sendMessageWithDelay(userId, paymentMsg);
                        _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
                    } else {
                        if (planAI.response) {
                            currentState.history.push({ role: 'bot', content: planAI.response, timestamp: Date.now() });
                            await sendMessageWithDelay(userId, planAI.response);
                        }
                        const paymentMsgAI = _buildPaymentMsg(currentState);
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
                    const fallbackMsg = "¡Dale! Quedo a tu disposición para cuando puedas avisarme. 😊";
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
                if (planAI.response.includes('después hablamos') || planAI.response.includes('cualquier cosa acá estoy')) {
                    // Just set state as paused or track time, cron cleans up cold leads next day
                    logger.info(`[FLOW] User ${userId} delayed step. Will follow up later.`);
                }

                return { matched: true };
            }
        }
    }
    return { matched: false };
}
