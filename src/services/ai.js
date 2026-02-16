const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const STEP_GOALS = {
    'greeting': 'Saludar amablemente y preguntar en qué puedo ayudar.',
    'waiting_weight': 'El objetivo es que el usuario diga cuántos kilos quiere bajar. Si pregunta otra cosa, respondé y volvé a preguntar los kilos.',
    'waiting_preference': 'El objetivo es que elija entre Cápsulas o Semillas. Explicá la diferencia si pide, pero cerrá preguntando cuál prefiere.',
    'waiting_price_confirmation': 'El objetivo es que confirme si quiere saber el precio. Si dice "sí", "precio", "info", asumí que sí.',
    'waiting_plan_choice': 'El objetivo es que elija el Plan de 60 días o el de 120 días.',
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
    1. Respondé a lo que dice el usuario (duda, comentario, queja).
    2. SIEMPRE intentá guiar la conversación de vuelta hacia TU OBJETIVO PRINCIPAL.
    3. Si el usuario se desvía, respondé corto y volvé a preguntar lo que necesitás.
    4. NO inventes precios ni productos que no conocés.
    5. Sé conciso (máximo 2 o 3 oraciones).
    
    Respuesta:
    `;

    try {
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) {
        console.error("🔴 AI Generation Error:", e.message);
        return null; // Fallback will handle it (or nothing happens)
    }
}

module.exports = { generateSmartResponse };
