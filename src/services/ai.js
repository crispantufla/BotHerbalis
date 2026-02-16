const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIGURATION ---
const GEN_MODEL = "gemini-2.0-flash";
const MAX_RETRIES = 4;
const MAX_HISTORY_LENGTH = 15;

// --- RATE LIMIT CONFIGURATION ---
const MAX_CONCURRENT = 2;       // Max parallel Gemini calls
const MIN_DELAY_MS = 500;       // Min gap between requests
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache for identical prompts

// --- PERSONA DEFINITION ---
const SYSTEM_INSTRUCTIONS = `
CONTEXTO:
Sos un VENDEDOR DE ELITE de Herbalis, especialistas en Nuez de la India (producto natural para adelgazar). 
Tu misión UNICA y EXCLUSIVA es cerrar la venta. No sos un asistente de salud ni un buscador de servicios ajenos.

REGLAS DE ORO DE VENTA:
1. COMPORTAMIENTO: Actuá siempre como un vendedor profesional con hambre de cierre, no como un asistente servicial. 
2. FOCO TOTAL: Si el cliente pregunta por servicios ajenos (psicología, medicina, gimnasios, etc.), NO des recomendaciones ni intentes ayudar con eso. Respondé: "Por ahora solo manejamos nuestros productos Herbalis para adelgazar" y volvé AL INSTANTE a la venta.
3. PERSONALIDAD ARGENTINA: Hablás en ESPAÑOL ARGENTINO (usás "voseo": "querés", "podés", "mirá"). Cercano pero enfocado en el negocio.
4. MANEJO DE OBJECIONES: Si desconfían ("estafa", "miedo"), explicá: "Entiendo perfectamente, por eso el envío es gratis y pagás SOLO al recibir el producto. Riesgo cero para vos."

PRODUCTOS:
1. Cápsulas: $45.900 (60 días) / $82.600 (120 días). Prácticas, 1 por día.
2. Semillas: $34.900 (60 días) / $61.900 (120 días). Opción natural tradicional.
3. Gotas: (Mencionar solo si preguntan).

REGLAS DE INTERACCIÓN:
1. Respuestas CORTAS y al pie. 
2. Sin redundancia: Si ya sabés qué producto quiere, no lo vuelvas a preguntar. 
3. Cierre imperativo: Siempre terminá con una pregunta que empuje la venta hacia el siguiente paso.
4. No divagar: Si el cliente cambia de tema, no lo sigas. Volvé a la venta de inmediato.
`;

// ═══════════════════════════════════════════════════════
// GLOBAL REQUEST QUEUE — Prevents rate limit floods
// ═══════════════════════════════════════════════════════
class RequestQueue {
    constructor(maxConcurrent, minDelayMs) {
        this.maxConcurrent = maxConcurrent;
        this.minDelayMs = minDelayMs;
        this.running = 0;
        this.queue = [];
        this.lastRequestTime = 0;
    }

    enqueue(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this._process();
        });
    }

    async _process() {
        if (this.running >= this.maxConcurrent || this.queue.length === 0) return;

        this.running++;
        const { fn, resolve, reject } = this.queue.shift();

        try {
            // Enforce minimum delay between requests
            const now = Date.now();
            const elapsed = now - this.lastRequestTime;
            if (elapsed < this.minDelayMs) {
                await new Promise(r => setTimeout(r, this.minDelayMs - elapsed));
            }
            this.lastRequestTime = Date.now();

            const result = await fn();
            resolve(result);
        } catch (e) {
            reject(e);
        } finally {
            this.running--;
            this._process();
        }
    }

    get pending() { return this.queue.length; }
    get active() { return this.running; }
}

// ═══════════════════════════════════════════════════════
// SIMPLE RESPONSE CACHE — Avoids duplicate API calls
// ═══════════════════════════════════════════════════════
class ResponseCache {
    constructor(ttlMs) {
        this.ttl = ttlMs;
        this.cache = new Map();
    }

    _hash(str) {
        // Simple fast hash for cache keys
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash.toString(36);
    }

    get(prompt) {
        const key = this._hash(prompt);
        const entry = this.cache.get(key);
        if (entry && Date.now() - entry.time < this.ttl) {
            return entry.value;
        }
        if (entry) this.cache.delete(key);
        return null;
    }

    set(prompt, value) {
        const key = this._hash(prompt);
        this.cache.set(key, { value, time: Date.now() });
        // Evict old entries periodically
        if (this.cache.size > 200) {
            const now = Date.now();
            for (const [k, v] of this.cache) {
                if (now - v.time > this.ttl) this.cache.delete(k);
            }
        }
    }

    get size() { return this.cache.size; }
}

// ═══════════════════════════════════════════════════════
// AI SERVICE — with queue, cache, and smart retry
// ═══════════════════════════════════════════════════════
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

        // Shared infrastructure
        this.queue = new RequestQueue(MAX_CONCURRENT, MIN_DELAY_MS);
        this.cache = new ResponseCache(CACHE_TTL_MS);
        this.stats = { calls: 0, cached: 0, retries: 0, errors: 0 };
    }

    /**
     * Enqueue a Gemini call with retry + rate limit handling
     * @param {Function} fn - The actual API call
     * @param {string} cacheKey - Optional prompt hash for caching (null = no cache)
     */
    async _callQueued(fn, cacheKey = null) {
        // Check cache first
        if (cacheKey) {
            const cached = this.cache.get(cacheKey);
            if (cached) {
                this.stats.cached++;
                return cached;
            }
        }

        this.stats.calls++;

        // Enqueue with retry logic
        const result = await this.queue.enqueue(async () => {
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    return await fn();
                } catch (e) {
                    if (e.status === 429 || (e.message && e.message.includes('429'))) {
                        this.stats.retries++;
                        // Exponential backoff: 4s, 8s, 16s, 32s
                        const waitTime = Math.pow(2, attempt + 2) * 1000;
                        console.warn(`⚠️ [AI] Rate Limit (429). Attempt ${attempt + 1}/${MAX_RETRIES}. Waiting ${waitTime / 1000}s... (Queue: ${this.queue.pending} pending)`);
                        await new Promise(r => setTimeout(r, waitTime));
                    } else {
                        this.stats.errors++;
                        throw e;
                    }
                }
            }
            this.stats.errors++;
            throw new Error("AI Service Unavailable (Max Retries Exceeded)");
        });

        // Cache the result
        if (cacheKey && result) {
            this.cache.set(cacheKey, result);
        }

        return result;
    }

    /**
     * Main Chat Function
     */
    async chat(userText, context = {}) {
        let conversationHistory = context.history || [];
        let summaryContext = "";

        if (context.summary) {
            summaryContext = `RESUMEN PREVIO:\n"${context.summary}"\n\n`;
            if (conversationHistory.length > 5) {
                conversationHistory = conversationHistory.slice(-5);
            }
        }

        let knowledgeContext = "";
        if (context.knowledge && context.knowledge.flow) {
            const f = context.knowledge.flow;
            const pCaps = f.price_capsulas?.response || "";
            const pSem = f.price_semillas?.response || "";
            if (pCaps || pSem) {
                knowledgeContext = `INFORMACIÓN ACTUALIZADA DE PRECIOS:\n${pCaps}\n${pSem}\n(Usar estos valores sobre cualquier otro)`;
            }
        }

        const prompt = `
        ${summaryContext}
        ${knowledgeContext}
        ETAPA ACTUAL: "${context.step || 'general'}"
        OBJETIVO INMEDIATO: "${context.goal || 'Ayudar al cliente'}"
        
        HISTORIAL RECIENTE:
        ${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}
        
        USUARIO: "${userText}"
        
        INSTRUCCIONES DE RESPUESTA:
        1. Analizá si el usuario CUMPLIÓ el objetivo (ej: dio el dato, eligió el plan).
        2. Generá una respuesta acorde.
        3. Devolvé JSON: { "response": "texto", "goalMet": boolean, "extractedData": "si hay datos relevantes (ej: selecciono capsulas) ponelo acá, sino null" }
        `;

        try {
            // No cache for chat — every conversation is unique
            const result = await this._callQueued(
                () => this.model.generateContent(prompt),
                null
            );
            const text = result.response.text();
            return this._parseJSON(text);
        } catch (e) {
            console.error("🔴 [AI] Chat Error:", e.message);
            return { response: "Estoy teniendo un pequeño problema técnico, ¿me repetís?", goalMet: false };
        }
    }

    /**
     * Check if history needs summarization
     */
    async checkAndSummarize(history) {
        if (history.length > MAX_HISTORY_LENGTH) {
            console.log(`[AI] Summarizing history (${history.length} messages)...`);
            // Use the queued summarizer instead of direct call
            const summary = await this._callQueuedSummarize(history);
            if (summary) {
                console.log(`[AI] Summary created: "${summary.substring(0, 50)}..."`);
                return {
                    summary: summary,
                    prunedHistory: history.slice(-5)
                };
            }
        }
        return null;
    }

    /**
     * Manual Summary Trigger (for API)
     */
    async generateManualSummary(history) {
        return await this._callQueuedSummarize(history);
    }

    /**
     * Summarize history through the queue (avoids raw unthrottled calls)
     */
    async _callQueuedSummarize(history) {
        const conversationText = history.map(msg =>
            `${msg.role === 'user' ? 'Cliente' : 'Vendedor'}: ${msg.content}`
        ).join('\n');

        // Cache key based on last few messages
        const cacheKey = `summary_${history.length}_${history.slice(-3).map(m => m.content).join('|')}`;

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
            const result = await this._callQueued(
                () => this.model.generateContent(prompt),
                cacheKey
            );
            return result.response.text().trim();
        } catch (e) {
            console.error("🔴 [AI] Summary Error:", e.message);
            return null;
        }
    }

    /**
     * Parse Address from Text
     */
    async parseAddress(text) {
        const prompt = `
        Analizá el siguiente texto y extraé una dirección postal de Argentina.
        El texto puede estar desordenado o sin etiquetas (ej: "juan perez av libertador 1234 caba 1425").
        
        TEXTO DEL USUARIO: "${text}"

        DETALLES DE EXTRACCIÓN:
        - nombre: Si hay un nombre de persona al inicio, extraelo.
        - calle: La calle y la altura (ej: "Benegas 77", "Av. Santa Fe 1234").
        - ciudad: La localidad o ciudad (ej: "Rosario", "CABA").
        - cp: El código postal numérico (ej: "2000", "1414").
        
        Devolver JSON PURO:
        {
          "nombre": "nombre detectado o null",
          "calle": "calle y altura o null",
          "ciudad": "ciudad/localidad o null",
          "cp": "código postal o null",
          "direccion_valida": boolean (true si hay al menos calle y altura),
          "comentario": "razón si es invalida o falta algo"
        }
        `;
        try {
            const result = await this._callQueued(
                () => this.model.generateContent(prompt),
                `addr_${text.substring(0, 100)}`
            );
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
            // No cache for audio — always unique
            const result = await this._callQueued(
                () => this.model.generateContent([
                    { inlineData: { data: mediaData, mimeType: mimeType } },
                    { text: "Transcribí este audio literalmente en español. Si no se entiende, respondé [INDESCIFRABLE]." }
                ]),
                null
            );
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
            const result = await this._callQueued(
                () => this.model.generateContent(prompt),
                null
            );
            return result.response.text();
        } catch (e) {
            return instruction; // Fallback to raw instruction
        }
    }

    /**
     * Get queue/cache stats for monitoring
     */
    getStats() {
        return {
            ...this.stats,
            queuePending: this.queue.pending,
            queueActive: this.queue.active,
            cacheSize: this.cache.size
        };
    }

    _parseJSON(text) {
        try {
            const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(jsonStr);
            if (typeof parsed.response !== 'string') {
                parsed.response = String(parsed.response || "");
            }
            return parsed;
        } catch (e) {
            return { response: text.replace(/```/g, ''), goalMet: false };
        }
    }
}

// Singleton Instance
const aiService = new AIService();
module.exports = { aiService };
