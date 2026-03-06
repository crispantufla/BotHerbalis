import { UserState, FlowStep } from '../../types/state';
const { _formatMessage } = require('../utils/messages');
const { _setStep, _maybeUpsell } = require('../utils/flowHelpers');

export async function handleWaitingPreference(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // SCRIPT FIRST: Check if the user is asking for a deferred "postdatado" date early
    const earlyPostdatadoMatch = text.match(/\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|semana|mes|cobro|mañana|despues|después|principio|el \d+ de [a-z]+|el \d+)\b/i);
    if (earlyPostdatadoMatch && /\b(recibir|llega|enviar|mandar|cobro|pago|puedo)\b/i.test(normalizedText)) {
        console.log(`[EARLY POSTDATADO] Captured in waiting_preference: ${text}`);
        if (!currentState.postdatado) currentState.postdatado = text; // Save it to output later
        saveState(userId);
    }

    // SCRIPT FIRST: Check keywords for capsulas or semillas
    const isMatch = (keywords: string[], text: string) => keywords.some((k: string) => new RegExp(`\\b${k}\\b`, 'i').test(text));

    const mentionsCapsulas = isMatch(knowledge.flow.preference_capsulas.match, normalizedText);
    const mentionsSemillas = isMatch(knowledge.flow.preference_semillas.match, normalizedText);
    const mentionsGotas = knowledge.flow.preference_gotas ? isMatch(knowledge.flow.preference_gotas.match, normalizedText) : false;

    const totalMatches = (mentionsCapsulas ? 1 : 0) + (mentionsSemillas ? 1 : 0) + (mentionsGotas ? 1 : 0);

    // Or if they ask for a recommendation or express a physical objection (e.g., hard to swallow)
    // FIX: Only treat as comparison if they ACTUALLY mention more than one, or explicitly ask for comparison.
    // Answering "Capsulas" to "con cual preferis avanzar, capsulas o semillas?" should NOT be a comparison.
    const hasObjection = /\b(tragar|ahogar|grandes|cuestan|complicado|dificil|miedo a ahogarme)\b/i.test(normalizedText);
    const isComparison = totalMatches > 1 || hasObjection || (totalMatches === 0 && /\b(cual|recomend|mejor|diferencia|que me recomiendas|que me conviene|cual me das|asesorame|efectiv|rapido)\b/i.test(normalizedText));

    const adaptResponsePrefix = (rawResponse: string, userText: string, extString: string) => {
        if (/\b(cual|recomend|mejor|efectiv|rapido|diferencia)\b/i.test(userText)) {
            if (extString.includes('capsula')) {
                return rawResponse.replace(/Dale, buenísimo 👍 Excelente elección\./i, "Lo más efectivo sin duda son las cápsulas 💪.");
            } else if (extString.includes('semilla')) {
                return rawResponse.replace(/Dale, buenísimo 🌿 La semilla natural es la clásica, súper potente\./i, "Si buscás lo más natural, te recomiendo las semillas 🌿.");
            } else if (extString.includes('gota')) {
                return rawResponse.replace(/Dale, buenísimo 🌿 Las gotas son discretas y se absorben rápido\./i, "En tu caso, lo mejor y más suave van a ser las gotas 🌿.");
            }
        }
        return rawResponse;
    };

    if (isComparison) {
        if (/^(capsulas? o gotas?|gotas? o capsulas?|capsulas o gotas porfa(?:vor)?)$/i.test(normalizedText.trim())) {
            console.log(`[HARDCODED-PREF] User asked "capsulas o gotas", sending hardcoded recommendation.`);
            const hardcodedRec1 = "Personalmente te recomiendo las cápsulas, suelen ser más efectivas 💪.";
            const hardcodedRec2 = "Las gotas las recomendamos ya para gente mayor o con problemas digestivos.\n\n👉 ¿Avanzamos con cápsulas entonces?";

            currentState.history.push({ role: 'bot', content: hardcodedRec1, timestamp: Date.now() });
            await sendMessageWithDelay(userId, hardcodedRec1);

            currentState.history.push({ role: 'bot', content: hardcodedRec2, timestamp: Date.now() });
            _setStep(currentState, FlowStep.WAITING_PREFERENCE);
            currentState.consultativeSale = true;
            saveState(userId);
            await sendMessageWithDelay(userId, hardcodedRec2);

            return { matched: true };
        }

        console.log(`[INDICISION] User ${userId} compares products or asks for recommendation.`);

        const aiRecommendation = await aiService.chat(text, {
            step: FlowStep.WAITING_PREF_CONSULT,
            goal: `El usuario está indeciso entre productos, pide recomendaciones, O está aceptando una recomendación previa ("dale", "bueno"). REGLAS DE RECOMENDACIÓN (CRÍTICO):
            1) Si el usuario YA ESTÁ ACEPTANDO tu recomendación previa (ej: "dale", "bueno", "capsulas"), ¡tu objetivo está cumplido! Respondé con goalMet=true y extractedData="Cápsulas de nuez de la india".
            2) Si pide "lo más efectivo", "lo mejor", "lo más rápido" o "cualquiera": El objetivo está cumplido automáticamente, respondé goalMet=true y extractedData="Cápsulas de nuez de la india".
            3) EMOCIÓN Y SALUD: Si cuenta su historia de peso, problemas médicos (tiroides, operaciones) o inseguridades, REDACTA UN PÁRRAFO EXTENSO Y PROFUNDAMENTE EMPÁTICO validando sus sentimientos ANTES de recomendar nada.
            4) Si duda o insiste entre GOTAS y CÁPSULAS o te pide recomendación: Decile con mucha calidez y detalle "Personalmente te recomiendo las cápsulas, suelen ser más efectivas. Las gotas las recomendamos ya para gente mayor o con problemas digestivos." Luego preguntale con cuál prefiere avanzar.
            5) Si pide "info de las 3", "precio de las 3" o "todas": brindá un resumen explicativo detallado con los precios base de 60 días para Cápsulas, Gotas y Semillas (extraídos del knowledge) y luego preguntá cuál prefiere probar.
            6) Si pregunta por envío o medios de pago, aclara con amabilidad que el envío es gratis y que el pago se puede realizar con tarjeta o transferencia al momento del pedido, o en efectivo al recibir. Luego preguntale con cuál producto prefiere avanzar.
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
                const adaptedResponse = adaptResponsePrefix(priceNode.response, normalizedText, ext);
                const msg = _formatMessage(adaptedResponse, currentState);
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
            step: FlowStep.WAITING_PREFERENCE,
            goal: `Determinar si quiere cápsulas/gotas (opción práctica), semillas (opción natural) o AMBAS. REGLAS CRÍTICAS DE HUMANIZACIÓN: 
1) EMOCIÓN Y SALUD: Si hace un descargo sobre su peso, operaciones o inseguridades médicas, REDACTÁ MÚLTIPLES PÁRRAFOS demostrando altísima empatía y contención. Usa un tono explayado y compasivo antes de darle la recomendación del producto. NO SEAS ROBÓTICA NI BREVE ante temas sensibles.
2) Usa muletillas simpáticas al conversar ("Dale perfecto", "Entiendo bárbaro", "Tranqui te explico super detallado"). 
3) Si duda o pregunta entre GOTAS y CÁPSULAS o te pide recomendación: Decile "Personalmente te recomiendo las cápsulas, suelen ser más efectivas. Las gotas las recomendamos ya para gente mayor o con problemas digestivos." Luego preguntale con cuál prefiere avanzar. 
4) Si habla en PASADO ("yo tomaba", "antes usé"), decile tipo "Ah mirá que bueno que ya las conoces y pudiste sacarles provecho! Entonces vayamos con las CÁPSULAS directamente". 
5) Si pide información o precios de "las 3", "todas", o "los 3", brindá una explicación extensa y amable de Cápsulas, Semillas y Gotas con sus precios correspondientes de 60 días (usando el knowledge) y luego preguntá cuál prefiere. 
6) Si el usuario pregunta si puede recibir el pedido o pagarlo un día concreto, DALE EL OK Y CONFIRMÁ EL PRODUCTO. 
7) Si pregunta por envío o medios de pago, aclará de forma cálida que el envío es gratis a todo el país y que el pago se puede realizar con tarjeta o transferencia al momento del pedido, o en efectivo al recibir. Luego preguntale con cuál producto prefiere avanzar. 

🔴 REGLA ABSOLUTA DE CONFIRMACIÓN: Si el usuario ya aceptó tu sugerencia o eligió explícita O implícitamente (ej: "dale", "si", "bueno"), NO DEBES GENERAR RESPUESTA. Debes marcar goalMet=true y extractedData="PRODUCTO: Cápsulas de nuez de la india" inmediatamente.`,
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
                const adaptedResponse = adaptResponsePrefix(priceNode.response, normalizedText, ext);
                const msg = _formatMessage(adaptedResponse, currentState);
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
            await sendMessageWithDelay(userId, aiPref.response);
            saveState(userId);
            return { matched: true };
        }
    }
    return { matched: false };
}
