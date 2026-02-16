const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

/**
 * Summarizes a list of chat messages into a concise paragraph.
 * @param {Array} history - Array of { role: 'user'|'model', content: string }
 * @returns {Promise<string>} - The summary text.
 */
async function summarizeHistory(history) {
    if (!history || history.length < 5) return null;

    const conversationText = history.map(msg =>
        `${msg.role === 'user' ? 'Cliente' : 'Vendedor'}: ${msg.content}`
    ).join('\n');

    const prompt = `
    Analizá la siguiente conversación de venta de productos naturales (Nuez de la India).
    Generá un RESUMEN CONCISO (máximo 3 oraciones) que capture:
    1. Qué productos le interesan al cliente.
    2. Datos personales ya proporcionados (nombre, dirección, dudas).
    3. En qué estado quedó la negociación (¿está dudando? ¿ya compró? ¿espera envío?).

    CONVERSACIÓN:
    ${conversationText}

    RESUMEN:
    `;

    try {
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        console.error("Error generating summary:", error);
        return null;
    }
}

module.exports = { summarizeHistory };
