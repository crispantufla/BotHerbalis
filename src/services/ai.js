const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIGURATION ---
const GEN_MODEL = "gemini-2.0-flash";
const MAX_RETRIES = 3;

// --- PERSONA DEFINITION ---
const SYSTEM_INSTRUCTIONS = `
CONTEXTO:
Sos "Herbalis Bot", un asistente virtual de ventas de Nuez de la India (producto natural para adelgazar).
Tu objetivo es guiar al cliente hasta la compra, despejando dudas y recolectando sus datos de envío.

PERSONALIDAD:
- Sos amable, empático y paciente.
- Hablás en ESPAÑOL ARGENTINO (usás "voseo": "querés", "podés", "mirá").
- Sos profesional pero cercano. No sos un robot frío.
- Si el cliente desconfía (dice "estafa", "miedo"), NO te ofendas. Explicá con seguridad: "El envío es gratis y pagás SOLO al recibir el producto en tu casa. Es 100% seguro."

PRODUCTOS:
1. Cápsulas: $45.900 (60 días) / $82.600 (120 días). Prácticas, 1 por día.
2. Semillas: $34.900 (60 días) / $61.900 (120 días). Opción natural tradicional.
3. Gotas: (Mencionar solo si preguntan).

REGLAS DE INTERACCIÓN:
1. Respuestas CORTAS y al pie. En WhatsApp la gente no lee textos largos.
2. Si el usuario ya dio un dato (ej: "quiero capsulas"), NO vuelvas a preguntar "¿qué producto querés?". Confirmalo y avanzá.
3. Si el usuario cambia de tema, seguile la corriente pero intentá volver suavemente a la venta.
`;

class AIService {
    constructor() {
        if (!process.env.GEMINI_API_KEY) {
            console.error("❌ CRITICAL: GEMINI_API_KEY is missing!");
        }
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model = this.genAI.getGenerativeModel({
            model: GEN_MODEL,
            systemInstruction: SYSTEM_INSTRUCTIONS
        });
        this.status = { rateLimited: false, retryAfter: 0 };
    }

    /**
     * Helper to handle 429 Rate Limits with exponential backoff
     */
    async _callWithRetry(fn) {
        for (let i = 0; i < MAX_RETRIES; i++) {
            try {
                if (this.status.rateLimited && Date.now() < this.status.retryAfter) {
                    await new Promise(r => setTimeout(r, this.status.retryAfter - Date.now()));
                }
                const result = await fn();
                this.status.rateLimited = false;
                return result;
            } catch (e) {
                if (e.status === 429 || (e.message && e.message.includes('429'))) {
                    const waitTime = (i + 1) * 2000 + 1000; // 3s, 5s...
                    console.warn(`⚠️ [AI] Rate Limit (429). Retrying in ${waitTime}ms...`);
                    this.status.rateLimited = true;
                    this.status.retryAfter = Date.now() + waitTime;
                    await new Promise(r => setTimeout(r, waitTime));
                } else {
                    throw e;
                }
            }
        }
        throw new Error("AI Service Unavailable (Max Retries)");
    }

    /**
     * Main Chat Function
     * @param {string} userText 
     * @param {object} context - { step, history, goal }
     */
    async chat(userText, context = {}) {
        const prompt = `
        ETAPA ACTUAL: "${context.step || 'general'}"
        OBJETIVO INMEDIATO: "${context.goal || 'Ayudar al cliente'}"
        
        HISTORIAL RECIENTE:
        ${(context.history || []).map(m => `${m.role}: ${m.content}`).join('\n')}
        
        USUARIO: "${userText}"
        
        INSTRUCCIONES DE RESPUESTA:
        1. Analizá si el usuario CUMPLIÓ el objetivo (ej: dio el dato, eligió el plan).
        2. Generá una respuesta acorde.
        3. Devolvé JSON: { "response": "texto", "goalMet": boolean, "extractedData": "si hay datos relevantes (ej: selecciono capsulas) ponelo acá, sino null" }
        `;

        try {
            const result = await this._callWithRetry(() => this.model.generateContent(prompt));
            const text = result.response.text();
            return this._parseJSON(text);
        } catch (e) {
            console.error("🔴 [AI] Chat Error:", e.message);
            return { response: "Estoy teniendo un pequeño problema técnico, ¿me repetís?", goalMet: false };
        }
    }

    /**
     * Parse Address from Text
     */
    async parseAddress(text) {
        const prompt = `
        Extraé una dirección postal de Argentina de este texto: "${text}".
        Devolver JSON:
        {
          "nombre": "nombre completo o null",
          "calle": "calle y altura o null",
          "ciudad": "ciudad/localidad o null",
          "cp": "código postal o null",
          "direccion_valida": boolean,
          "comentario": "razón si es invalida"
        }
        `;
        try {
            const result = await this._callWithRetry(() => this.model.generateContent(prompt));
            return this._parseJSON(result.response.text());
        } catch (e) {
            return { _error: true };
        }
    }

    /**
     * Transcribe Audio
     */
    async transcribeAudio(mediaData, mimeType) {
        try {
            const result = await this._callWithRetry(() => this.model.generateContent([
                { inlineData: { data: mediaData, mimeType: mimeType } },
                { text: "Transcribí este audio literalmente en español. Si no se entiende, respondé [INDESCIFRABLE]." }
            ]));
            return result.response.text();
        } catch (e) {
            console.error("🔴 [AI] Transcribe Error:", e.message);
            return null;
        }
    }

    /**
     * Helper for Admin Suggestions ("Yo me encargo")
     */
    async generateSuggestion(instruction, conversationContext) {
        const prompt = `
        SITUACION: El vendedor humano quiere que respondas esto al cliente, pero redactado profesionalmente por el bot.
        INSTRUCCION: "${instruction}"
        CONTEXTO CHAT: "${conversationContext}"
        
        Generá la respuesta exacta para enviar.
        `;
        try {
            const result = await this._callWithRetry(() => this.model.generateContent(prompt));
            return result.response.text();
        } catch (e) {
            return instruction; // Fallback to raw instruction
        }
    }

    _parseJSON(text) {
        try {
            const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonStr);
        } catch (e) {
            // Fallback if AI didn't return strict JSON (sometimes happens)
            return { response: text, goalMet: false };
        }
    }
}

// Singleton Instance
const aiService = new AIService();
module.exports = { aiService };
