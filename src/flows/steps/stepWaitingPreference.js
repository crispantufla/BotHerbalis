const { _formatMessage } = require('../utils/messages');
const { _setStep, _maybeUpsell } = require('../utils/flowHelpers');

async function handleWaitingPreference(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // SCRIPT FIRST: Check if the user is asking for a deferred "postdatado" date early
    const earlyPostdatadoMatch = text.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio|el \d+ de [a-z]+|el \d+)\b/i);
    if (earlyPostdatadoMatch && /\b(recibir|llega|enviar|mandar|cobro|pago|puedo)\b/i.test(normalizedText)) {
        console.log(`[EARLY POSTDATADO] Captured in waiting_preference: ${text}`);
        if (!currentState.postdatado) currentState.postdatado = text; // Save it to output later
        saveState(userId);
    }

    // SCRIPT FIRST: Check keywords for capsulas or semillas
    const isMatch = (keywords, text) => keywords.some(k => new RegExp(`\\b${k}\\b`, 'i').test(text));

    const mentionsCapsulas = isMatch(knowledge.flow.preference_capsulas.match, normalizedText);
    const mentionsSemillas = isMatch(knowledge.flow.preference_semillas.match, normalizedText);
    const mentionsGotas = knowledge.flow.preference_gotas ? isMatch(knowledge.flow.preference_gotas.match, normalizedText) : false;

    const totalMatches = (mentionsCapsulas ? 1 : 0) + (mentionsSemillas ? 1 : 0) + (mentionsGotas ? 1 : 0);

    // If user mentions more than one product (e.g., "capsulas o semillas", "qué diferencia hay")
    // Or if they ask for a recommendation
    const isComparison = totalMatches > 1 || /\b(cual|recomend|mejor|diferencia|que me recomiendas|que me conviene|cual me das|asesorame)\b/i.test(normalizedText);

    if (isComparison) {
        if (/^(capsulas? o gotas?|gotas? o capsulas?|capsulas o gotas porfa(?:vor)?)$/i.test(normalizedText.trim())) {
            console.log(`[HARDCODED-PREF] User asked "capsulas o gotas", sending hardcoded recommendation.`);
            const hardcodedRec1 = "Te recomiendo más las *cápsulas*, las cuales suelen ser más efectivas 💪.";
            const hardcodedRec2 = "Las gotas las recomendamos para cuando son pocos kilos o son gente muy mayor ya que son más suaves.\n\n👉 ¿Avanzamos con cápsulas entonces?";

            currentState.history.push({ role: 'bot', content: hardcodedRec1, timestamp: Date.now() });
            await sendMessageWithDelay(userId, hardcodedRec1);

            currentState.history.push({ role: 'bot', content: hardcodedRec2, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, hardcodedRec2);

            currentState.consultativeSale = true;
            return { matched: true };
        }

        console.log(`[INDICISION] User ${userId} compares products or asks for recommendation.`);

        const aiRecommendation = await aiService.chat(text, {
            step: 'waiting_preference_consultation',
            goal: `El usuario está indeciso entre productos, pide recomendaciones, O está aceptando una recomendación previa ("dale", "bueno"). REGLAS DE RECOMENDACIÓN (CRÍTICO):
            1) Si el usuario YA ESTÁ ACEPTANDO tu recomendación previa (ej: "dale", "bueno", "capsulas"), ¡tu objetivo está cumplido! Respondé con goalMet=true y extractedData="Cápsulas de nuez de la india".
            2) Si pide "lo más efectivo", "lo mejor", "lo más rápido" o "cualquiera": El objetivo está cumplido automáticamente, respondé goalMet=true y extractedData="Cápsulas de nuez de la india".
            3) Si pregunta "cómo están compuestas", "diferencias" o "cómo están hechas", responde brevemente: "Las gotas son la extracción del aceite en clorofila (más suaves) y en las cápsulas extraemos el componente activo puro (más potentes). Solemos recomendar más las cápsulas." Y LUEGO pregunta: "¿Querés que sigamos con las cápsulas?".
            4) Si duda o insiste entre GOTAS y CÁPSULAS: Decile EXACTAMENTE que recomendás más las cápsulas, las cuales suelen ser más efectivas, y que las gotas se recomiendan para cuando son pocos kilos o gente muy mayor. Luego preguntale con cuál prefiere avanzar.
            5) Si pide "info de las 3", "precio de las 3" o "todas": brindá un resumen BREVE con los precios base de 60 días para Cápsulas, Gotas y Semillas (extraídos del knowledge) y preguntá cuál prefiere probar.
            SOLO marcá goalMet=true si el cliente ya eligió o si explícitamente pidió "lo mejor/más rápido" (asumiendo cápsulas).`,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiRecommendation.goalMet && aiRecommendation.extractedData) {
            const ext = aiRecommendation.extractedData.toLowerCase();
            let priceNode;
            if (ext.includes('cápsula') || ext.includes('capsula')) {
                currentState.selectedProduct = 'Cápsulas de nuez de la india';
                priceNode = knowledge.flow.preference_capsulas;
            } else if (ext.includes('gota')) {
                currentState.selectedProduct = 'Gotas de nuez de la india';
                priceNode = knowledge.flow.preference_gotas;
            } else if (ext.includes('semilla')) {
                currentState.selectedProduct = 'Semillas de nuez de la india';
                priceNode = knowledge.flow.preference_semillas;
            }

            if (priceNode) {
                const msg = _formatMessage(priceNode.response, currentState);
                _setStep(currentState, priceNode.nextStep);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, msg);

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
        currentState.selectedProduct = "Cápsulas de nuez de la india";
        const msg = _formatMessage(knowledge.flow.preference_capsulas.response, currentState);
        _setStep(currentState, knowledge.flow.preference_capsulas.nextStep);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
        return { matched: true };
    } else if (mentionsSemillas) {
        currentState.selectedProduct = "Semillas de nuez de la india";
        const msg = _formatMessage(knowledge.flow.preference_semillas.response, currentState);
        _setStep(currentState, knowledge.flow.preference_semillas.nextStep);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
        return { matched: true };
    } else if (knowledge.flow.preference_gotas && mentionsGotas) {
        currentState.selectedProduct = "Gotas de nuez de la india";
        const msg = _formatMessage(knowledge.flow.preference_gotas.response, currentState);
        _setStep(currentState, knowledge.flow.preference_gotas.nextStep);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
        return { matched: true };
    } else {
        console.log(`[AI-FALLBACK] waiting_preference: No keyword match for ${userId}`);
        const aiPref = await aiService.chat(text, {
            step: 'waiting_preference',
            goal: 'Determinar si quiere cápsulas/gotas (opción práctica), semillas (opción natural) o AMBAS. REGLAS CRÍTICAS DE HUMANIZACIÓN: 1) MÁXIMO 35 PALABRAS. 2) Usa muletillas simpáticas al arrancar ("Dale perfecto", "Entiendo bárbaro", "Tranqui te explico"). 3) Si duda o pregunta entre GOTAS y CÁPSULAS: Decile EXACTAMENTE que recomendás más las cápsulas, las cuales suelen ser más efectivas, y que las gotas se recomiendan para cuando son pocos kilos o gente muy mayor ya que son más suaves. Luego preguntale con cuál prefiere avanzar. 4) Si habla en PASADO ("yo tomaba", "antes usé"), decile tipo "Ah mirá que bueno que ya las conoces! Entonces vayamos con las CÁPSULAS". 5) Si pide información o precios de "las 3", "todas", o "los 3", brindá un resumen BREVE de Cápsulas, Semillas y Gotas con sus precios correspondientes de 60 días (usando el knowledge) y luego preguntá cuál prefiere. 6) Si el usuario pregunta si puede recibir el pedido o pagarlo un día concreto, DALE EL OK Y CONFIRMÁ EL PRODUCTO. \n\n🔴 REGLA ABSOLUTA DE CONFIRMACIÓN: Si el usuario ya aceptó tu sugerencia o eligió explícita O implícitamente (ej: "dale", "si", "bueno"), NO DEBES GENERAR RESPUESTA. Debes marcar goalMet=true y extractedData="PRODUCTO: Cápsulas de nuez de la india" inmediatamente.',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiPref.goalMet && aiPref.extractedData) {
            const ext = aiPref.extractedData.toLowerCase();
            let priceNode;
            if (ext.includes('cápsula') || ext.includes('capsula')) {
                currentState.selectedProduct = 'Cápsulas de nuez de la india';
                priceNode = knowledge.flow.price_capsulas || knowledge.flow.preference_capsulas;
            } else if (ext.includes('gota')) {
                currentState.selectedProduct = 'Gotas de nuez de la india';
                priceNode = knowledge.flow.price_gotas || knowledge.flow.preference_gotas;
            } else if (ext.includes('semilla')) {
                currentState.selectedProduct = 'Semillas de nuez de la india';
                priceNode = knowledge.flow.price_semillas || knowledge.flow.preference_semillas;
            }

            if (priceNode) {
                const msg = _formatMessage(priceNode.response, currentState);
                _setStep(currentState, priceNode.nextStep);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, msg);

                await _maybeUpsell(currentState, sendMessageWithDelay, userId, saveState);
                return { matched: true };
            }
        }

        if (aiPref.response) {
            currentState.history.push({ role: 'bot', content: aiPref.response, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, aiPref.response);
            return { matched: true };
        }
    }
    return { matched: false };
}

module.exports = { handleWaitingPreference };
