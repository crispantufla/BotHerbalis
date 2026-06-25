import { UserState, FlowStep } from '../../types/state';
import { _formatMessage } from '../utils/messages';
import { _setStep, _maybeUpsell, _pauseAndAlert, _assignProductAndPlanByTier, _maybeSendPaymentMenuV7 } from '../utils/flowHelpers';
import logger from '../../utils/logger';

/**
 * Determina el tier (1/2/3) según los kilos del state y el script.
 * V7 (2 tiers): >10 → tier 2. V5/V6 (3 tiers): >20 → tier 3.
 */
function _resolveTier(weightGoal: number, knowledge: any): '1' | '2' | '3' {
    const w = typeof weightGoal === 'number' ? weightGoal : parseInt(String(weightGoal), 10) || 0;
    const hasRec3 = !!knowledge?.flow?.recommendation_3;
    if (!hasRec3) return w <= 10 ? '1' : '2';
    if (w <= 10) return '1';
    if (w <= 20) return '2';
    return '3';
}

/**
 * Envía el `recommendation_X` correspondiente al tier + (V7) `prices_X` como
 * segundo mensaje automático. Centralizado para que TODOS los entrypoints
 * (main flow, dual-goal, AI fallback) usen el mismo routing y no caigan al
 * `knowledge.flow.recommendation` genérico — bug detectado en review V7:
 * dual-goal y AI fallback mandaban el rec genérico sin tier ni auto-prices.
 */
async function _sendTierRecommendation(
    userId: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any,
    userText: string = ''
): Promise<void> {
    const { sendMessageWithDelay, saveState, aiService } = dependencies;
    const wRaw = currentState.weightGoal;
    const wNum = typeof wRaw === 'number' ? wRaw : parseInt(String(wRaw || 0), 10) || 0;
    const tier = _resolveTier(wNum, knowledge);
    const tierNode = knowledge?.flow?.[`recommendation_${tier}`] || knowledge?.flow?.recommendation;
    if (!tierNode) return;
    const planDays = tier === '1' ? '60' : '120';

    // Recomendación AI-led (rev 2026-05-30 — "darle más libertad a la IA"):
    // en vez de la plantilla cruda, la IA REDACTA la recomendación respondiendo a lo
    // que dijo el cliente, con el plan y las 3 opciones inyectadas (datos exactos).
    // Si la IA falla, cae a la plantilla scripted. Los PRECIOS NO los toca la IA —
    // van en el segundo mensaje scripted con los números reales de pricing.
    let tierMsg: string | null = null;
    if (aiService && typeof aiService.chat === 'function') {
        try {
            // Si el cliente eligió por NÚMERO DE OPCIÓN del menú ("1️⃣ Hasta 10 kg /
            // 2️⃣ Más de 10 kg"), ese número NO es una cantidad de kilos. Sin esto, la
            // IA leía "2" como "2 kilos" y respondía "Con 2 kilos…" (caso 5493436463086,
            // 25-jun). Le pasamos la CATEGORÍA del tier y se lo aclaramos explícito.
            const isTwoTierRec = !!(knowledge?.flow?.recommendation_1 && !knowledge?.flow?.recommendation_3);
            const bareMenuPick = /^\s*[123]\s*(?:️?⃣)?\s*$/.test((userText || '').trim());
            const tierCategoria = tier === '1' ? 'hasta 10 kg' : tier === '2' ? (isTwoTierRec ? 'más de 10 kg' : 'entre 10 y 20 kg') : 'más de 20 kg';
            const clienteDijo = bareMenuPick
                ? `eligió la opción "${(userText || '').trim()}" del menú de kilos — o sea quiere bajar ${tierCategoria}. ⚠️ Ese número es la OPCIÓN del menú, NO una cantidad de kilos: NUNCA digas "con ${(userText || '').trim()} kilos" ni lo interpretes como kilos`
                : `acaba de decirte cuánto quiere bajar (último mensaje: "${userText}")`;
            const recGoal = `El cliente ${clienteDijo}. Tu tarea: recomendarle el plan de *${planDays} días* y presentarle las TRES presentaciones para que elija. REGLAS:\n(1) Arrancá reaccionando con calidez y de forma NATURAL a lo que dijo (sin asumir ni mencionar un número exacto de kilos si no lo dio).\n(2) Recomendá el plan de *${planDays} días*.\n(3) Listá las 3 opciones EXACTAS, una por línea con su número:\n"1️⃣ *Cápsulas* — 1 al día, 30 min antes del almuerzo o la cena.\n2️⃣ *Gotas* — 10 gotas al día, 30 min antes del almuerzo o la cena.\n3️⃣ *Semillas* — una infusión antes de dormir (lleva una preparación simple)."\n(4) Aclarar que las tres son 100% naturales y funcionan igual para bajar de peso.\n(5) 🛑 PROHIBIDO mencionar precios o cualquier monto de plata (van en el mensaje siguiente, aparte).\n(6) NO inventes nada fuera de esto. Cerrá con la pregunta EXACTA: *¿Qué opción preferís?* — NO uses "¿cuál te llama más?", "¿cuál te gusta más?" ni otras variantes. goalMet=true.`;
            const aiRec = await aiService.chat(userText || 'dale', {
                step: FlowStep.WAITING_WEIGHT,
                goal: recGoal,
                history: currentState.history,
                summary: currentState.summary,
                knowledge,
                userState: currentState
            });
            if (aiRec.response) tierMsg = aiRec.response;
        } catch (e: any) {
            logger.warn(`[REC-AI] Recomendación AI falló para ${userId}: ${e.message} — uso plantilla scripted.`);
        }
    }
    if (!tierMsg) tierMsg = _formatMessage(tierNode.response, currentState); // fallback scripted

    _setStep(currentState, tierNode.nextStep || FlowStep.WAITING_PREFERENCE);
    currentState.history.push({ role: 'bot', content: tierMsg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, tierMsg);

    // NO auto-enviamos precios acá (rev 2026-06-03). Antes este step disparaba
    // prices_both como segundo mensaje automático → el cliente recibía la
    // recomendación + la grilla de los 3 precios JUNTAS, sin elegir nada. El admin
    // pidió cortar eso: mandar SOLO la recomendación (elegí 1/2/3) y recién mostrar
    // el precio de la presentación elegida en waiting_preference (preference_X →
    // muestra el Total del producto que el cliente pidió). Un precio por turno,
    // solo lo que pidió.
}

export async function handleWaitingWeight(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // No confundir el número de un descuento/porcentaje con kilos: "haceme 50% de
    // descuento" NO es "bajar 50 kg" (bug del test off-script 2026-05-30). Sacamos
    // los "\d+%" antes de detectar/extraer peso.
    const _weightText = text.replace(/\d+\s*%/g, ' ');
    const hasNumber = /\d+/.test(_weightText.trim());
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
        if (noNumberInLex && lex.length <= 50) {
            // Orden importa: mucho/muchísimo antes que poco para evitar overlap.
            if (/\b(much[oa]s?|much[ií]simo[as]?|un mont[oó]n|demasiado[as]?|bocha|banda)\b/i.test(lex)) vagueWeightTier = '3';
            else if (/\b(bastante[s]?|varios?|regular|algunos?|m[aá]s o menos|masomenos)\b/i.test(lex)) vagueWeightTier = '2';
            else if (/\b(poc[oa]s?|poquit[oa]s?|un poco|kilit[oa]s?)\b/i.test(lex)) vagueWeightTier = '1';
            // Números escritos (reporte 2026-05-28 5491162654840: "Más de diez" caía
            // al AI fallback y la IA alucinaba el flow).
            //   "diez" / "10" sueltos → tier 1 (≤10 kg, plan 60d).
            //   "más de diez" o cualquier número 11+ → tier 2 (+10 kg, plan 120d).
            else if (/\bm[aá]s\s+de\s+(diez|10)\b/i.test(lex)) vagueWeightTier = '2';
            else if (/\bm[aá]s\s+de\s+(once|doce|trece|catorce|quince|diecis[ée]is|diecisiete|dieciocho|diecinueve|veinte|veintic|treinta|cuarenta|cincuenta)\b/i.test(lex)) vagueWeightTier = '2';
            else if (/\b(once|doce|trece|catorce|quince|diecis[ée]is|diecisiete|dieciocho|diecinueve|veinte|veintic|treinta|cuarenta|cincuenta)\b/i.test(lex)) vagueWeightTier = '2';
            else if (/\b(diez)\b/i.test(lex)) vagueWeightTier = '1';
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

    // Declinación cordial: "por ahora no puedo comprar / solo pregunté el precio,
    // gracias". NO es negarse a dar el peso (eso es isRefusal → skip a preferencia);
    // es CERRAR la consulta (estaba averiguando precio). Tratarlo como weight-refusal
    // hace que el bot empuje productos y la clienta se frustre (reporte 5491136769277:
    // "Por ahora no puedo comprar, yo pregunté precio, gracias" → el bot mostró
    // productos en vez de soltar). Back-off cordial + pausa.
    const isPriceCheckDecline =
        /\bno (puedo|voy a|podr[ií]a|pienso) (comprar|comprarlo|adquirir|seguir|avanzar)\b/i.test(normalizedText)
        || /\bpor ahora no (puedo|compro|voy|quiero comprar)\b/i.test(normalizedText)
        || /\bno (compro|comprar[ée]|voy a comprar)(\s+(ahora|por ahora|nada))?\b/i.test(normalizedText)
        || /\b(solo|solamente|yo|nomas|nom[áa]s|[úu]nicamente)\s+(pregunt[ée]|preguntaba|consult\w*|quer[ií]a)\b.{0,20}(precio|saber|info|averiguar)/i.test(normalizedText)
        || /\b(era|fue)\s+(solo\s+)?(una\s+)?(consulta|pregunta|para\s+(saber|averiguar))\b/i.test(normalizedText);

    // Hard rejection = not interested in the product at all → pause & alert admin
    const isHardRejection = /\b(no (quiero|me interesa)\s*(nada|comprar|saber)?|callate|callate|dejame|basta|no molest|spam)\b/i.test(normalizedText)
        && /\b(nada|comprar|saber|callate|dejame|basta|molest|spam|paz)\b/i.test(normalizedText);
    // Soft refusal = doesn't want to answer weight specifically → skip to preference.
    // Excluye la declinación de compra de arriba (esa NO empuja productos).
    const isRefusal = !isHardRejection && !isPriceCheckDecline && /\b(no (voy|puedo)|prefiero no|que tenes|mostrame)\b/i.test(normalizedText);

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
        const allNums = (_weightText.match(/\d{1,3}/g) || []).map(s => parseInt(s, 10));
        const inRangeNums = allNums.filter(n => n >= 3 && n <= 50);
        // PISO: el cliente da una cota inferior. Tomamos el MAYOR número en rango
        // para que caiga en el tier correcto (ej: "más de 10 … mínimo 25" → 25,
        // no 10). "más de N" es ESTRICTAMENTE mayor → usamos al menos N+1 (así
        // "más de 10" cae en tier 2, no en 10/tier 1). Sólo con cue de piso, para
        // no romper "bajar 8, tengo 45 años" (sin cue → primer número). Reporte
        // real 5491168816042 (01-jun-2026).
        const moreThan = _weightText.match(/\b(?:mas de|m[áa]s de|arriba de|mas que|m[áa]s que)\s+(\d{1,3})/i);
        const hasFloorCue = !!moreThan || /\b(m[ií]nimo|minino|por lo menos|al menos|mucho mas)\b/i.test(_weightText);
        if (hasFloorCue) {
            const candidates = [...inRangeNums];
            if (moreThan) {
                const n = parseInt(moreThan[1], 10) + 1; // estrictamente mayor
                if (n >= 3 && n <= 50) candidates.push(n);
            }
            if (candidates.length) return Math.max(...candidates);
        }
        if (inRangeNums.length) return inRangeNums[0];
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
            // Mandamos primero la respuesta empática del AI a la pregunta, después
            // disparamos el tier-routing (rec_X + prices_X auto V7) para no perder
            // ese paso. Antes este branch caía a knowledge.flow.recommendation
            // genérico, sin auto-prices ni tier — bug detectado en review V7.
            currentState.history.push({ role: 'bot', content: aiDual.response, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, aiDual.response);
            await _sendTierRecommendation(userId, currentState, knowledge, dependencies, text);
            return { matched: true };
        }
        // AI failed but we already extracted weight — proceed via tier routing.
        logger.warn(`[AI-FALLBACK] Dual-goal AI failed for ${userId}, but weight (${currentState.weightGoal}kg) was extracted. Proceeding via tier routing.`);
        await _sendTierRecommendation(userId, currentState, knowledge, dependencies);
        return { matched: true };
    }

    if ((hasNumber || vagueWeightTier) && !hasQuestion && !treatAsLong) {
        // V7 guard: si el cliente responde "3" pelado (sin "kilos"/"kg"), es muy
        // probable que esté eligiendo "opción 3" pensando que existía como en V5.
        // En V7 solo hay opciones 1 y 2. Re-preguntamos sin interpretarlo como 3 kg
        // (que caería en tier 1 y le mandaría el plan equivocado).
        const isTwoTierScriptForGuard = !!(knowledge?.flow?.recommendation_1 && !knowledge?.flow?.recommendation_3);
        const bareThree = /^\s*3\s*[\.\)°]?\s*$/.test(text);
        if (isTwoTierScriptForGuard && bareThree) {
            const reaskMsg = 'Mmm, solo tengo 2 opciones acá 😅\n\n1️⃣ Hasta 10 kg\n2️⃣ Más de 10 kg\n\n¿Cuál es lo tuyo?';
            currentState.history.push({ role: 'bot', content: reaskMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, reaskMsg);
            logger.info(`[V7-GUARD] User ${userId} respondió "3" en script de 2 tiers — re-preguntando opciones válidas.`);
            return { matched: true };
        }

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
            const trimmed = text.trim();
            // En V7 sólo aceptamos "1" o "2" como opción explícita.
            const isOptionPick = isTwoTierScript
                ? trimmed.length <= 3 && (trimmed === '1' || trimmed === '2')
                : trimmed.length <= 3 && (trimmed === '1' || trimmed === '2' || trimmed === '3');

            // Determinar weightGoal por opción/vague antes de delegar al helper.
            // El helper _resolveTier decide el tier según weightGoal + script.
            if (vagueWeightTier && !isOptionPick && !hasExplicitGoal) {
                // En V7 colapsamos vague-tier 3 → tier 2 (no hay tier 3).
                const t = isTwoTierScript && vagueWeightTier === '3' ? '2' : vagueWeightTier;
                if (t === '1') currentState.weightGoal = 8;
                else if (t === '2') currentState.weightGoal = 15;
                else currentState.weightGoal = 25;
                logger.info(`[VAGUE-WEIGHT] User ${userId} respondió "${text.trim()}" → tier ${t} (default weightGoal=${currentState.weightGoal}kg, twoTier=${isTwoTierScript}).`);
            } else if (isOptionPick) {
                if (trimmed === '1') currentState.weightGoal = 8;
                else if (trimmed === '2') currentState.weightGoal = 15;
                else currentState.weightGoal = 25;
            }

            // Si el cliente YA eligió producto (lo mencionó antes de dar los kilos),
            // NO le re-mostramos las 3 opciones: le asignamos ese producto + el plan
            // del tier (la dosis), le pasamos el precio de ESE producto y seguimos al
            // pago. Sin esto, alguien que dijo "cápsulas" y después "mínimo 25 kilos"
            // recibía igual el menú genérico (reporte 5491168816042, 01-jun-2026).
            const _suggested = (currentState as any).suggestedProduct;
            if (_suggested) {
                _assignProductAndPlanByTier(currentState, _suggested);
                const cp = currentState.selectedProduct || '';
                const priceNode = cp.includes('Cápsulas') ? knowledge.flow.preference_capsulas
                    : cp.includes('Gotas') ? knowledge.flow.preference_gotas
                    : knowledge.flow.preference_semillas;
                const pmsg = _formatMessage(priceNode.response, currentState);
                _setStep(currentState, priceNode.nextStep);
                currentState.history.push({ role: 'bot', content: pmsg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, pmsg);
                await _maybeSendPaymentMenuV7(userId, priceNode.nextStep, currentState, knowledge, dependencies);
                logger.info(`[TIER] User ${userId} ya eligió ${_suggested}; weightGoal=${currentState.weightGoal}kg → plan ${currentState.selectedPlan}; salto recomendación genérica.`);
                return { matched: true };
            }

            // NO asignamos producto/plan acá. El nuevo modelo (V5+/V7) ofrece las 3
            // opciones en recommendation_X y deja al cliente elegir producto en
            // waiting_preference. La dosis (plan 60 o 120) se asigna ahí según el
            // tier preservado en weightGoal.
            await _sendTierRecommendation(userId, currentState, knowledge, dependencies, text);
            logger.info(`[TIER] User ${userId} (script=${currentState.assignedScript}) → weightGoal=${currentState.weightGoal}kg, twoTier=${isTwoTierScript}; product/plan se asigna en waiting_preference.`);
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

            // V7: si preference_X.nextStep es waiting_payment_method, mandamos
            // el payment_menu como segundo mensaje (sin esto el cliente leía
            // "Te paso las formas de pago 👇" pero no llegaban).
            await _maybeSendPaymentMenuV7(userId, priceNode.nextStep, currentState, knowledge, dependencies);
            await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
            return { matched: true };
        } else {
            // Sin suggestedProduct: ruta por tier (V7 manda rec_X + prices_X).
            // En scripts legacy sin recommendation_X cae al recommendation genérico.
            await _sendTierRecommendation(userId, currentState, knowledge, dependencies, text);
            return { matched: true };
        }
    } else {
        if (!hasQuestion) {
            (currentState as any).weightRefusals = ((currentState as any).weightRefusals || 0) + 1;
        }

        if (isHardRejection || isPriceCheckDecline) {
            logger.info(`[REJECTION] User ${userId} ${isPriceCheckDecline ? 'declinó la compra (solo preguntaba precio / por ahora no)' : 'rechazó la conversación'} en waiting_weight. Back-off + pausa.`);
            const rejectMsg = isPriceCheckDecline
                ? '¡Dale, sin problema! 😊 Cualquier cosa que necesites, acá estoy. ¡Que tengas un lindo día! 🌿'
                : '¡Disculpá la molestia! Si en algún momento necesitás algo, acá estamos 😊';
            currentState.history.push({ role: 'bot', content: rejectMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, rejectMsg);
            await _pauseAndAlert(userId, currentState, dependencies, text, isPriceCheckDecline
                ? 'El cliente declinó la compra (estaba averiguando precio / "por ahora no"). Bot soltó cordialmente.'
                : 'El cliente rechazó la conversación explícitamente.');
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
                goal: 'El usuario NO te dijo cuántos kilos quiere bajar. Tu único objetivo: re-preguntar el rango de kilos de forma natural y BREVE. REGLAS DURAS: (a) Máx 1-2 frases cortas, total ~150 caracteres. (b) PROHIBIDO repetir info ya dada (que enviamos a todo el país, que las cápsulas son efectivas, etc). (c) Una sola pregunta al final, NUNCA dos. (d) PROHIBIDO comentar sobre la provincia/ciudad del cliente ("qué lindo X", "tengo familia ahí", etc.) — son comentarios obsecuentes que el admin reportó. Ignorá el dato de ubicación y andá directo a la pregunta. (e) Si dijo no saberlo, ofrecé estimación rápida. (f) Terminá con: "¿Cuántos kilos querés bajar?" o variante natural — UNA pregunta sola.',
                history: currentState.history,
                summary: currentState.summary,
                knowledge: knowledge,
                userState: currentState
            });

            // Guard anti-alucinación (reporte 2026-05-27 horacio): clientes que
            // entran con "¡Hola! Quiero más información" SIN números ni indicios
            // de peso terminaban en tier 1 porque la IA inventaba goalMet=true
            // con un weightGoal alucinado. Solo confiamos en goalMet si el texto
            // del cliente contiene palabras asociadas a peso o un número en rango.
            const hasWeightSignal = /\d|kilo|kg|peso|bajar|perder|adelgazar|mucho|bastante|poco|much[ií]simo|grande|chico|enorme/i.test(normalizedText);
            if (aiWeight.goalMet && aiWeight.extractedData && hasWeightSignal) {
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

                    await _maybeSendPaymentMenuV7(userId, priceNode.nextStep, currentState, knowledge, dependencies);
                    await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
                    return { matched: true };
                } else {
                    // V7: tier routing + auto prices_X. Antes caía al recommendation
                    // genérico — bug detectado en review V7.
                    await _sendTierRecommendation(userId, currentState, knowledge, dependencies, text);
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
