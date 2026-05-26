import { UserState, FlowStep } from '../../types/state';
import { _formatMessage } from '../utils/messages';
import { _setStep, _maybeUpsell, _pauseAndAlert, _assignProductAndPlanByTier } from '../utils/flowHelpers';
import logger from '../../utils/logger';

export async function handleWaitingWeight(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    const hasNumber = /\d+/.test(text.trim());
    const hasQuestion = /\b(como|cómo|cuando|cuándo|que|qué|donde|dónde|por que|por qué|cual|cuál|duda|consulta|precio|costo|sale|cuesta|valor|paga|cobr|tarjeta|efectivo|transferencia|contraindicaciones|contraindicacion|efectos|mal|dieta|rebote|salud|dañin|riñon|riñón|higado|hígado|corazon|corazón|diabetes|diabetico|diabética|diabético|presion|presión|hipertens|operad|cirugía|cirugia|enferm|tiroides|medicamento|medica|pastillas para)\b/i.test(normalizedText) || normalizedText.includes('?');
    // If text is super long (like a transcription), force AI to handle it so we don't look robotic
    const isVeryLongMessage = text.split(/\s+/).length > 20;

    // Extraemos un objetivo de bajar EXPLÍCITO incluso en mensajes largos —
    // si el cliente dijo claramente "bajar X kilos" / "perder X kilos" / "X de
    // menos", ignoramos isVeryLongMessage y aplicamos el tier routing.
    // Sin esto, audios transcritos largos con peso claro caían al AI fallback
    // y el bot respondía "dame un segundo y te recomiendo" sin nunca recomendar.
    const explicitGoalMatch = text.match(/\b(?:bajar|perder|sacarme|adelgazar)\s+(?:unos?\s+)?(\d{1,3})\s*(?:kg|kilos?|kilogramos?)?\b/i)
        || text.match(/\b(\d{1,3})\s*(?:kg|kilos?|kilogramos?)\s+(?:de\s+)?(?:menos|m[áa]s|aproximadamente|m[áa]s\s+o\s+menos)\b/i)
        || text.match(/\b(?:quiero|quisiera|necesito|me\s+gustar[ií]a)\s+bajar\s+(?:unos?\s+)?(\d{1,3})/i);
    const hasExplicitGoal = !!explicitGoalMatch;
    // El mensaje largo "se trata como largo" SOLO si NO encontramos goal explícito.
    // Con goal explícito, aplicamos tier routing igual.
    const treatAsLong = isVeryLongMessage && !hasExplicitGoal;

    // Empty affirmative ("Sii", "si", "ok", "dale") sin contexto previo: re-preguntar el rango
    // en vez de dejar que el AI invente una recomendación. Solo aplica si AÚN no hay weightGoal
    // ni producto sugerido y el último mensaje del bot fue la pregunta del rango.
    const isEmptyAffirmative = /^(s+i+|si+|sip|sii+|dale|ok|okey|okis|listo|bueno|claro|obvio|perfecto|genial)\s*[!.]*\s*$/i.test(text.trim());
    if (isEmptyAffirmative && !currentState.weightGoal && !(currentState as any).suggestedProduct) {
        // V7 (sin rec_3): 2 tiers. V5/V6: 3 tiers. Adaptamos el reask al script.
        const isTwoTier = !!(knowledge?.flow?.recommendation_1 && !knowledge?.flow?.recommendation_3);
        const reaskMsg = isTwoTier
            ? '¡Genial! 😊 ¿Cuántos kilos querés bajar?\n\n1️⃣ Hasta 10 kg\n2️⃣ Más de 10 kg'
            : '¡Genial! 😊 ¿Cuántos kilos querés bajar?\n\n1️⃣ Pocos (hasta 10 kg)\n2️⃣ Bastante (10 a 20)\n3️⃣ Mucho (más de 20)';
        currentState.history.push({ role: 'bot', content: reaskMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, reaskMsg);
        return { matched: true };
    }

    // Respuestas léxicas vagas: el greeting muestra "Pocos / Bastante / Mucho"
    // como labels de 1/2/3, así que muchos clientes responden con esas palabras
    // en lugar del número o los kilos. Sin este shortcut, "bastante" cae al AI
    // fallback que re-pregunta y el cliente abandona (datos research 2026-05-26:
    // 21% de drop en waiting_weight). Mapeamos al tier correspondiente con un
    // weightGoal default conservador (8 / 15 / 25 kg) para que stepWaitingPreference
    // pueda asignar plan después.
    let vagueWeightTier: '1' | '2' | '3' | null = null;
    if (!currentState.weightGoal) {
        // Mensaje corto y sin número: matchear keyword vago. Mensajes largos van
        // al AI fallback (puede haber contexto que cambia la interpretación).
        const lex = normalizedText.trim();
        const noNumberInLex = !/\d/.test(lex);
        if (noNumberInLex && lex.length <= 35) {
            // Orden importa: mucho/muchísimo antes que poco para evitar overlap.
            if (/\b(much[oa]s?|much[ií]simo[as]?|un mont[oó]n|demasiado[as]?|bocha|banda)\b/i.test(lex)) vagueWeightTier = '3';
            else if (/\b(bastante[s]?|varios?|regular|algunos?|m[aá]s o menos|masomenos)\b/i.test(lex)) vagueWeightTier = '2';
            else if (/\b(poc[oa]s?|poquit[oa]s?|un poco|kilit[oa]s?)\b/i.test(lex)) vagueWeightTier = '1';
        }
    }

    const tLow = text.toLowerCase();
    let implicitProduct = null;

    if (tLow.includes('cápsula') || tLow.includes('capsula') || tLow.includes('pastilla') || tLow.includes('pastillas')) implicitProduct = "Cápsulas de nuez de la india";
    else if (tLow.includes('gota')) implicitProduct = "Gotas de nuez de la india";
    else if (tLow.includes('semilla')) implicitProduct = "Semillas de nuez de la india";

    if (implicitProduct) {
        (currentState as any).suggestedProduct = implicitProduct;
        logger.info(`[LOGIC] Implicitly detected product: ${implicitProduct}`);
    }

    // Hard rejection = not interested in the product at all → pause & alert admin
    const isHardRejection = /\b(no (quiero|me interesa)\s*(nada|comprar|saber)?|callate|callate|dejame|basta|no molest|spam)\b/i.test(normalizedText)
        && /\b(nada|comprar|saber|callate|dejame|basta|molest|spam|paz)\b/i.test(normalizedText);
    // Soft refusal = doesn't want to answer weight specifically → skip to preference
    const isRefusal = !isHardRejection && /\b(no (voy|puedo)|prefiero no|que tenes|mostrame)\b/i.test(normalizedText);

    // Extracción robusta del objetivo de bajar: si tenemos goal explícito
    // (regex que matchea "bajar X kilos"), lo usamos. Sino, buscamos el primer
    // número en rango razonable (3-50 kg para "kilos a bajar").
    //
    // CASO RANGOS: si el cliente dice "10 a 20" / "entre 10 y 20" / "10-20",
    // usamos el MÁXIMO del rango. El cliente está expresando un objetivo
    // máximo, no un mínimo. Sin esto, "10 a 20" extraía 10 → tier 1 (gotas)
    // cuando claramente debe ser tier 2 (cápsulas).
    function _extractWeightGoal(): number | null {
        const rangeMatch = text.match(/\b(\d{1,3})\s*(?:a|-|hasta|y)\s*(\d{1,3})\s*(?:kg|kilos?)?\b/i)
            || text.match(/\bentre\s+(\d{1,3})\s+(?:a|y|-)\s+(\d{1,3})/i);
        if (rangeMatch) {
            const lo = parseInt(rangeMatch[1], 10);
            const hi = parseInt(rangeMatch[2], 10);
            if (hi > lo && hi >= 3 && hi <= 50) return hi;
            if (lo >= 3 && lo <= 50) return lo;
        }
        if (explicitGoalMatch) {
            const n = parseInt(explicitGoalMatch[1], 10);
            if (n >= 3 && n <= 50) return n;
        }
        const allNums = (text.match(/\d{1,3}/g) || []).map(s => parseInt(s, 10));
        const inRange = allNums.find(n => n >= 3 && n <= 50);
        if (inRange != null) return inRange;
        return allNums[0] ?? null;
    }

    if (hasNumber && hasQuestion && !treatAsLong) {
        // User gave weight AND asked a health/product question — extract weight but respond to the concern
        const extracted = _extractWeightGoal();
        if (extracted != null) currentState.weightGoal = extracted;
        logger.info(`[LOGIC] User ${userId} gave weight (${currentState.weightGoal}kg) AND asked a question. Responding to both.`);
        const dualGoal = `El usuario dijo cuántos kilos quiere bajar (${currentState.weightGoal} kg) PERO TAMBIÉN hizo una pregunta sobre salud, contraindicaciones o el producto. DEBES responder su pregunta con MUCHA empatía y detalle PRIMERO. Si pregunta si es dañino/seguro para alguna condición de salud (riñón, presión, diabetes, etc.): "No hay ninguna contraindicación para tu condición. Es un producto 100% natural, las únicas contraindicaciones son embarazo y lactancia." Después confirmá su objetivo de peso y preguntá qué formato prefiere: "Perfecto, ${currentState.weightGoal} kg es un objetivo totalmente alcanzable 👌 ¿Preferís algo súper práctico (cápsulas o gotas) o más natural (semillas)?"."`;
        const aiDual = await aiService.chat(text, {
            step: FlowStep.WAITING_WEIGHT,
            goal: dualGoal,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });
        if (aiDual.response) {
            const recNode = knowledge.flow.recommendation;
            _setStep(currentState, recNode.nextStep);
            currentState.history.push({ role: 'bot', content: aiDual.response, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, aiDual.response);
            return { matched: true };
        }
        // AI failed but we already extracted weight — proceed to next step with the weight we have
        logger.warn(`[AI-FALLBACK] Dual-goal AI failed for ${userId}, but weight (${currentState.weightGoal}kg) was extracted. Proceeding.`);
        const recNode = knowledge.flow.recommendation;
        const { _formatMessage: fmtMsg } = require('../utils/messages');
        const recMsg = fmtMsg(recNode.response, currentState);
        _setStep(currentState, recNode.nextStep);
        currentState.history.push({ role: 'bot', content: recMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, recMsg);
        return { matched: true };
    }

    if ((hasNumber || vagueWeightTier) && !hasQuestion && !treatAsLong) {
        const extracted = _extractWeightGoal();
        if (extracted != null) currentState.weightGoal = extracted;

        // ── Ruta consultiva (V5/V6/V7): tier-based routing ─────────────────
        // V7 (may-2026): SOLO 2 tiers (recommendation_1=≤10kg→60d, recommendation_2=+10kg→120d).
        //   Si el knowledge tiene SOLO rec_1 + rec_2 (sin rec_3), asumimos V7 y mapeamos
        //   cualquier kilo > 10 a tier 2. Además, tras mandar recommendation_X enviamos
        //   prices_X automáticamente como segundo mensaje.
        // V5/V6 legacy: 3 tiers (rec_1/2/3). Sin auto-followup de precios.
        const hasTierResponses = !!(knowledge?.flow?.recommendation_1 || knowledge?.flow?.recommendation_2 || knowledge?.flow?.recommendation_3);
        const isTwoTierScript = hasTierResponses && !knowledge?.flow?.recommendation_3;
        if (hasTierResponses) {
            const w = currentState.weightGoal || 0;
            const trimmed = text.trim();
            // En V7 sólo aceptamos "1" o "2" como opción explícita.
            const isOptionPick = isTwoTierScript
                ? trimmed.length <= 3 && (trimmed === '1' || trimmed === '2')
                : trimmed.length <= 3 && (trimmed === '1' || trimmed === '2' || trimmed === '3');
            let tier: '1' | '2' | '3';
            if (vagueWeightTier && !isOptionPick && !hasExplicitGoal) {
                // En V7 colapsamos vague-tier 3 → 2 (no hay tier 3).
                tier = isTwoTierScript && vagueWeightTier === '3' ? '2' : vagueWeightTier;
                if (tier === '1') currentState.weightGoal = 8;
                else if (tier === '2') currentState.weightGoal = 15;
                else currentState.weightGoal = 25;
                logger.info(`[VAGUE-WEIGHT] User ${userId} respondió "${text.trim()}" → tier ${tier} (default weightGoal=${currentState.weightGoal}kg, twoTier=${isTwoTierScript}).`);
            } else if (isOptionPick) {
                tier = trimmed as '1' | '2' | '3';
                if (tier === '1') currentState.weightGoal = 8;
                else if (tier === '2') currentState.weightGoal = 15;
                else currentState.weightGoal = 25;
            } else {
                const wNum = typeof w === 'number' ? w : parseInt(String(w), 10) || 0;
                if (isTwoTierScript) {
                    // V7: ≤10 → tier 1, +10 → tier 2
                    tier = wNum <= 10 ? '1' : '2';
                } else {
                    if (wNum <= 10) tier = '1';
                    else if (wNum <= 20) tier = '2';
                    else tier = '3';
                }
            }

            // NO asignamos producto/plan acá. El nuevo modelo (V5+/V7) ofrece las 3
            // opciones en recommendation_X y deja al cliente elegir producto en
            // waiting_preference. La dosis (plan 60 o 120) se asigna ahí según el
            // tier preservado en weightGoal:
            //   - V7: tier 1 (≤10) → 60d, tier 2 (+10) → 120d
            //   - V5/V6: tier 1 → 60d, tier 2/3 → 120d

            const tierKey = `recommendation_${tier}`;
            const tierNode = knowledge.flow[tierKey] || knowledge.flow.recommendation;
            const tierMsg = _formatMessage(tierNode.response, currentState);

            _setStep(currentState, tierNode.nextStep || FlowStep.WAITING_PREFERENCE);
            currentState.history.push({ role: 'bot', content: tierMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, tierMsg);
            logger.info(`[TIER] User ${userId} (script=${currentState.assignedScript}) → tier ${tier} (weightGoal=${currentState.weightGoal}kg, twoTier=${isTwoTierScript}); product/plan se asigna en waiting_preference.`);

            // V7: auto-followup con prices_60 (tier 1) o prices_120 (tier 2). Es el
            // "segundo mensaje" del guión nuevo — los precios llegan sin que el
            // cliente tenga que pedirlos. Lo mandamos solo si existe la entry en
            // el knowledge (V5/V6 no la tienen y siguen el flujo viejo).
            const planDays = tier === '1' ? '60' : '120';
            const pricesKey = `prices_${planDays}`;
            const pricesNode = knowledge?.flow?.[pricesKey];
            if (pricesNode?.response) {
                const pricesMsg = _formatMessage(pricesNode.response, currentState);
                currentState.history.push({ role: 'bot', content: pricesMsg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, pricesMsg);
                logger.info(`[V7-AUTO-PRICES] User ${userId} → enviado ${pricesKey} tras tier ${tier}.`);
            }
            return { matched: true };
        }

        if ((currentState as any).suggestedProduct) {
            logger.info(`[LOGIC] User ${userId} already suggested ${(currentState as any).suggestedProduct}, skipping preference question.`);
            // Rev. 2026-05-26: el cliente ya había mencionado producto antes
            // de dar los kilos. Asignamos producto + plan por tier para que
            // preference_X resuelva {{PLAN_MONTHS}} y {{DOSAGE_REASON}}.
            _assignProductAndPlanByTier(currentState, (currentState as any).suggestedProduct);

            let priceNode;
            const currentProduct = currentState.selectedProduct || "";
            if (currentProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
            else if (currentProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
            else priceNode = knowledge.flow.preference_semillas;

            const msg = _formatMessage(priceNode.response, currentState);
            _setStep(currentState, priceNode.nextStep);
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);

            await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
            return { matched: true };
        } else {
            const recNode = knowledge.flow.recommendation;
            const recMsg = _formatMessage(recNode.response, currentState);

            _setStep(currentState, recNode.nextStep);
            currentState.history.push({ role: 'bot', content: recMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, recMsg);
            return { matched: true };
        }
    } else {
        if (!hasQuestion) {
            (currentState as any).weightRefusals = ((currentState as any).weightRefusals || 0) + 1;
        }

        if (isHardRejection) {
            logger.info(`[REJECTION] User ${userId} explicitly rejected at weight step. Pausing.`);
            const rejectMsg = '¡Disculpá la molestia! Si en algún momento necesitás algo, acá estamos 😊';
            currentState.history.push({ role: 'bot', content: rejectMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, rejectMsg);
            await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente rechazó la conversación explícitamente.');
            return { matched: true };
        }

        if (isRefusal || (currentState as any).weightRefusals > 2) {
            logger.info(`[LOGIC] User ${userId} refused/failed weight question too many times (${(currentState as any).weightRefusals}). Skipping to preference.`);
            const skipMsg = "¡Entiendo, no hay problema! 👌 Pasemos directo a ver qué forma del producto preferís.\n\nTenemos 3 opciones:\n1️⃣ *Cápsulas* (forma práctica — una al día)\n2️⃣ *Gotas* (forma líquida — suave al estómago)\n3️⃣ *Semillas* (100% natural — ritual de infusión nocturna)\n\n¿Con cuál vas?";

            _setStep(currentState, FlowStep.WAITING_PREFERENCE);
            currentState.history.push({ role: 'bot', content: skipMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, skipMsg);
            return { matched: true };
        } else {
            logger.info(`[AI-FALLBACK] waiting_weight: No number detected for ${userId}`);
            const aiWeight = await aiService.chat(text, {
                step: FlowStep.WAITING_WEIGHT,
                goal: 'El usuario NO te dijo cuántos kilos quiere bajar. Tu único objetivo: re-preguntar el rango de kilos de forma natural y BREVE. REGLAS DURAS: (a) Máx 1-2 frases cortas, total ~150 caracteres. (b) PROHIBIDO repetir info ya dada (que enviamos a todo el país, que las cápsulas son efectivas, etc). (c) Una sola pregunta al final, NUNCA dos. (d) Si dijo de qué provincia es, una reacción humana corta ("Ay qué lindo [lugar]!" o similar) y directo a la pregunta. (e) Si dijo no saberlo, ofrecé estimación rápida. (f) Terminá con: "¿Cuántos kilos querés bajar?" o variante natural — UNA pregunta sola.',
                history: currentState.history,
                summary: currentState.summary,
                knowledge: knowledge,
                userState: currentState
            });

            if (aiWeight.goalMet && aiWeight.extractedData) {
                const extNum = aiWeight.extractedData.match(/\d+/);
                if (extNum) currentState.weightGoal = parseInt(extNum[0], 10);

                if ((currentState as any).suggestedProduct) {
                    logger.info(`[LOGIC] AI goalMet weight, user already suggested ${(currentState as any).suggestedProduct}, skipping preference.`);
                    _assignProductAndPlanByTier(currentState, (currentState as any).suggestedProduct);

                    let priceNode;
                    const currentProduct = currentState.selectedProduct || "";
                    if (currentProduct.includes('Cápsulas')) priceNode = knowledge.flow.preference_capsulas;
                    else if (currentProduct.includes('Gotas')) priceNode = knowledge.flow.preference_gotas;
                    else priceNode = knowledge.flow.preference_semillas;

                    const msg = _formatMessage(priceNode.response, currentState);
                    _setStep(currentState, priceNode.nextStep);
                    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                    saveState(userId);
                    await sendMessageWithDelay(userId, msg);

                    await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
                    return { matched: true };
                } else {
                    const recNode = knowledge.flow.recommendation;
                    const recMsg = _formatMessage(recNode.response, currentState);

                    _setStep(currentState, recNode.nextStep);
                    currentState.history.push({ role: 'bot', content: recMsg, timestamp: Date.now() });
                    saveState(userId);
                    await sendMessageWithDelay(userId, recMsg);
                    return { matched: true };
                }
            } else if (aiWeight.response) {
                currentState.history.push({ role: 'bot', content: aiWeight.response, timestamp: Date.now() });
                await sendMessageWithDelay(userId, aiWeight.response);
                saveState(userId);
                return { matched: true };
            }
        }
    }
    return { matched: false };
}
