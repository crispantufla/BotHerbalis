const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Helper: Call Gemini with Retries (for 429 errors)
async function callGeminiWithRetry(prompt, maxRetries = 3) {
    let lastError = null;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const result = await model.generateContent(prompt);
            return result;
        } catch (e) {
            lastError = e;
            if (e.message?.includes('429') || e.status === 429) {
                // If it's the last retry, wait 60s as requested by user
                const wait = (i === maxRetries - 1) ? 60000 : (i + 1) * 5000;
                console.warn(`⚠️ [AI RETRY] Gemini 429. Attempt ${i + 1}/${maxRetries}. Waiting ${wait / 1000}s...`);
                await new Promise(res => setTimeout(res, wait));
                continue;
            }
            throw e;
        }
    }
    throw lastError;
}

const STEP_GOALS = {
    'greeting': 'Saludar amablemente y preguntar en qué puedo ayudar.',
    'waiting_weight': 'El objetivo es que el usuario diga cuántos kilos quiere bajar. Si pregunta otra cosa, respondé y volvé a preguntar los kilos.',
    'waiting_preference': 'El objetivo es que elija entre Cápsulas o Semillas. Explicá la diferencia si pide, pero cerrá preguntando cuál prefiere.',
    'waiting_price_confirmation': 'El objetivo es que confirme si quiere saber el precio. Si dice "sí", "precio", "info", asumí que sí.',
    'waiting_plan_choice': 'El objetivo es que elija explícitamente el Plan de 60 días o el de 120 días. Si solo pide más info o dice "cuéntame", NO es un objetivo cumplido, respondé dudas pero marcá goalMet: false para que NO avance el pedido solo.',
    'waiting_ok': 'El objetivo es que diga "ok" para pasar a pedirle los datos.',
    'waiting_data': 'El objetivo es conseguir Nombre, Calle, Ciudad y CP. Ayudalo si tiene dudas sobre el envío.',
    'waiting_legal_acceptance': 'El objetivo CRÍTICO es que escriba textual: "LEÍ Y ACEPTO LAS CONDICIONES DE ENVÍO". Explicá que es un requisito legal si se queja.',
    'completed': 'El pedido ya está hecho. Agradecé y despedite si saludan.'
};

/**
 * generateSmartResponse
 * Generates a context-aware AI response.
 * 
 * @param {string} text - User message
 * @param {object} currentState - User state object { step, ... }
 */
async function generateSmartResponse(text, currentState) {
    const step = currentState?.step || 'unknown';
    const goal = STEP_GOALS[step] || 'Responder dudas generales sobre Herbalis (Nuez de la India).';

    const prompt = `
    Sos "Herbalis Bot", un asistente virtual de ventas de productos naturales (Nuez de la India).
    Tu tono es: Amable, empático, profesional pero cercano (usá voseo argentino).
    
    CONTEXTO ACTUAL:
    - El usuario está en la etapa: "${step}".
    - TU OBJETIVO PRINCIPAL AHORA ES: ${goal}
    
    MENSAJE DEL USUARIO: "${text}"
    
    INSTRUCCIONES:
    1. Analizá si el mensaje del usuario CUMPLE con el OBJETIVO PRINCIPAL (ej: si se le pidió el peso y lo dio).
    2. Respondé a lo que dice el usuario (duda, comentario, queja).
    3. SIEMPRE intentá guiar la conversación de vuelta hacia TU OBJETIVO PRINCIPAL si no se cumplió.
    4. Devolvé un objeto JSON estrictamente con este formato:
    {
      "response": "Tu respuesta aquí (máx 3 oraciones)",
      "goalMet": true/false (true si el usuario aportó la información que se buscaba en este paso)
    }
    `;

    try {
        const result = await callGeminiWithRetry(prompt);
        const jsonText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(jsonText);
        return data; // Returns { response, goalMet }
    } catch (e) {
        console.error("🔴 AI Generation Error after retries:", e.message);
        return null;
    }
}

module.exports = { generateSmartResponse };
