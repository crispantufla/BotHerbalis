const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIGURATION ---
const GEN_MODELS = ["gemini-2.0-flash", "gemini-1.5-flash-8b", "gemini-1.5-flash-001"];
const MAX_RETRIES = 15; // Increased to try all combinations of keys and models
const MAX_HISTORY_LENGTH = 15;

// --- RATE LIMIT CONFIGURATION ---
const MAX_CONCURRENT_PER_KEY = 1; // Reduced to avoid hammering Free Tier
const MIN_DELAY_MS = 800;       // increased gap to spread requests
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache for identical prompts

// --- PERSONA DEFINITION ---
// IMPORTANT: The AI is ONLY used as a FALLBACK when the scripted flow can't handle 
// the user's message. Its job is to answer briefly and steer back to the current step.
const SYSTEM_INSTRUCTIONS = `
ROL:
Sos parte del equipo de ventas de Herbalis (Nuez de la India, producto natural para adelgazar).
Atendés el WhatsApp de la empresa. Sos una PERSONA real, NO un bot.

TU FUNCIÓN ESPECÍFICA:
El sistema tiene un guión de ventas automático. Vos solo intervenís cuando el cliente dice algo que el guión no puede manejar.
Tu trabajo es: responder la duda BREVEMENTE (1-2 oraciones) y VOLVER a la pregunta del paso actual.

IDENTIDAD (CRÍTICO):
- NUNCA admitas que sos un bot, IA o programa. Si preguntan, decí: "¡Jaja no! Soy del equipo de Herbalis 😊"
- Hablás en ESPAÑOL ARGENTINO con voseo ("querés", "podés", "mirá").

INFORMACIÓN DE PRODUCTO:
- Cápsulas: $45.900 (60 días) / $66.900 (120 días)
- Semillas: $36.900 (60 días) / $49.900 (120 días)
- Gotas: (Mencionar solo si preguntan). $48.900 (69 dias) / $68.900 (120 dias)
- Envío gratis por Correo Argentino, pago en efectivo al recibir
- Contraindicaciones: solo embarazo y lactancia
- Sin efecto rebote (es 100% natural)

REGLAS ESTRICTAS:
1. Respuestas MUY CORTAS: 1-2 oraciones máximo. Nada de párrafos largos.
2. NO inventes pasos nuevos ni ofrezcas cosas que no están en el guión.
3. Si preguntan por servicios ajenos: "Solo manejamos productos Herbalis" y volvé al tema.
4. Si desconfían: "El envío es gratis y pagás solo al recibir, riesgo cero para vos."
5. Siempre terminá volviendo a la pregunta del paso actual (se te indica en cada mensaje).
6. NO repitas información que ya se dio en el historial.

REGLAS DE EMPATÍA Y CONTENCIÓN:
7. Si el usuario comparte algo EMOCIONAL o PERSONAL (hijos, problemas de salud, bullying, autoestima), mostrá EMPATÍA PRIMERO con 1 oración comprensiva. Después volvé al paso actual.
8. NUNCA respondas con información de un paso futuro (precios, pagos, envíos) si el paso actual no lo pide.
9. Si no sabés qué responder, respondé con empatía y repetí la pregunta del paso actual.
10. PROHIBIDO inventar respuestas sobre temas que no están en tu información. Si no sabés, decí "Dejame consultar con mi compañero" y goalMet = false.
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
        const keys = (process.env.GEMINI_API_KEY || "").split(',').map(k => k.trim()).filter(Boolean);
        if (keys.length === 0) {
            console.error("❌ CRITICAL: GEMINI_API_KEY is missing!");
        }

        console.log(`📡 [AI] Initializing with ${keys.length} API key(s) and ${GEN_MODELS.length} models`);

        this.genAIs = keys.map(k => new GoogleGenerativeAI(k));
        // Table of models: [keyIndex][modelIndex]
        this.modelTable = this.genAIs.map(genAI =>
            GEN_MODELS.map(mName => genAI.getGenerativeModel({
                model: mName,
                systemInstruction: SYSTEM_INSTRUCTIONS
            }))
        );

        this.currentKeyIndex = 0;

        // Shared infrastructure - Concurrency scales with keys
        const totalConcurrent = Math.max(MAX_CONCURRENT_PER_KEY, keys.length * MAX_CONCURRENT_PER_KEY);
        this.queue = new RequestQueue(totalConcurrent, MIN_DELAY_MS);
        this.cache = new ResponseCache(CACHE_TTL_MS);
        this.stats = { calls: 0, cached: 0, retries: 0, errors: 0 };
    }

    /**
     * Get the next model instance for a specific attempt
     */
    _getModelForAttempt(attempt) {
        if (this.genAIs.length === 0) throw new Error("No API keys available");

        // Key rotates every attempt
        const keyIndex = (this.currentKeyIndex + attempt) % this.genAIs.length;

        // Model rotates after we've tried all keys with the previous model
        const modelIndex = Math.floor(attempt / this.genAIs.length) % GEN_MODELS.length;

        const modelName = GEN_MODELS[modelIndex];
        return {
            model: this.modelTable[keyIndex][modelIndex],
            modelName,
            keyIndex
        };
    }

    /**
     * Enqueue a Gemini call with retry + rate limit handling
     * @param {Function} apiCallTarget - A function that takes a model and returns the API call promise
     * @param {string} cacheKey - Optional prompt hash for caching (null = no cache)
     */
    async _callQueued(apiCallTarget, cacheKey = null) {
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
        return await this.queue.enqueue(async () => {
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                const { model, modelName, keyIndex } = this._getModelForAttempt(attempt);
                try {
                    return await apiCallTarget(model);
                } catch (e) {
                    if (e.status === 429 || (e.message && e.message.includes('429'))) {
                        this.stats.retries++;

                        // Smarter backoff: 
                        // 1. If we have keys left to try, wait 1s and rotate.
                        // 2. If we already tried all keys once, start exponential backoff.
                        let waitTime = 1000;
                        if (attempt >= this.genAIs.length) {
                            const backoffStage = attempt - this.genAIs.length;
                            waitTime = Math.pow(2, backoffStage + 1) * 2000; // 4s, 8s, 16s...
                        }
                        waitTime += Math.floor(Math.random() * 1000); // Add jitter

                        const errorDetail = e.message || "";
                        console.warn(`⚠️ [AI] Rate Limit (429) on key ${keyIndex} [${modelName}]. Attempt ${attempt + 1}/${MAX_RETRIES}. Backing off ${waitTime / 1000}s... (Queue: ${this.queue.pending} pending)`);
                        if (errorDetail.includes('FreeTier')) {
                            console.warn(`💡 [DIAGNÓSTICO] Google dice que este proyecto es "FreeTier". Verificá que el Billing esté vinculado a este proyecto específico.`);
                        }
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
        // Update key index for next message spread
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.genAIs.length;

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
            const faq = context.knowledge.faq || [];
            const step = context.step || 'general';

            // DYNAMIC CONTEXT: Only inject info relevant to the current step
            // This prevents the AI from hallucinating about topics not yet discussed
            knowledgeContext = `INFORMACIÓN RELEVANTE PARA ESTE PASO:\n`;

            // Pathology FAQ — always useful (customers ask about health at any point)
            const pathInfo = faq.find(q => q.keywords.includes('diabetes'))?.response || "";
            if (pathInfo) knowledgeContext += `- SOBRE PATOLOGÍAS: "${pathInfo}"\n`;

            // Step-specific context
            if (['waiting_weight', 'waiting_preference'].includes(step)) {
                knowledgeContext += `- Productos disponibles: Cápsulas (prácticas), Semillas (naturales), Gotas (líquidas)\n`;
                knowledgeContext += `- Contraindicaciones: solo embarazo y lactancia. NO menores de edad.\n`;
                knowledgeContext += `- (NO menciones precios todavía, el paso actual no lo requiere)\n`;
            } else if (step === 'waiting_price_confirmation') {
                knowledgeContext += `- El usuario todavía NO vio precios. Tu trabajo es convencerlo de que quiera verlos.\n`;
                knowledgeContext += `- Contraindicaciones: solo embarazo y lactancia. NO menores de edad.\n`;
                knowledgeContext += `- (NO menciones precios específicos ni formas de pago, solo que son accesibles)\n`;
            } else if (['waiting_plan_choice', 'closing', 'waiting_ok'].includes(step)) {
                const pCaps = f.price_capsulas?.response || "";
                const pSem = f.price_semillas?.response || "";
                if (pCaps || pSem) knowledgeContext += `- PRECIOS: ${pCaps} | ${pSem}\n`;
                knowledgeContext += `- Envío gratis por Correo Argentino, pago en efectivo al recibir\n`;
            } else if (step === 'waiting_data') {
                knowledgeContext += `- Necesitamos: nombre completo, calle y número, ciudad, código postal\n`;
                knowledgeContext += `- (NO menciones precios ni productos, ya están decididos)\n`;
            }

            knowledgeContext += `(No inventes datos, usá siempre esta base)`;
        }

        const prompt = `
${summaryContext}
${knowledgeContext}
ETAPA ACTUAL: "${context.step || 'general'}"
OBJETIVO DEL PASO: "${context.goal || 'Ayudar al cliente'}"

HISTORIAL RECIENTE:
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

MENSAJE DEL USUARIO: "${userText}"

INSTRUCCIONES:
1. Fijate si el usuario CUMPLIÓ el objetivo del paso (ej: dio un número, eligió un plan).
2. Si lo cumplió: goalMet = true.
3. Si NO lo cumplió: respondé BREVEMENTE (1-2 oraciones) su duda y volvé a preguntarle lo del objetivo.
4. Si el usuario dice algo EMOCIONAL o PERSONAL (hijos, salud, bullying, autoestima): mostrá EMPATÍA primero ("Entiendo, eso es difícil...") y después volvé suavemente al objetivo del paso.
5. PROHIBIDO: No hables de pago, envío, precios, ni datos de envío si el OBJETIVO DEL PASO no lo menciona. Limitá tu respuesta EXCLUSIVAMENTE al tema del objetivo.
6. Devolvé SOLO este JSON (sin markdown, sin backticks):
{ "response": "tu respuesta corta", "goalMet": true/false, "extractedData": "dato extraído o null" }
`;

        try {
            // No cache for chat — every conversation is unique
            const result = await this._callQueued(
                (model) => model.generateContent(prompt),
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
                (model) => model.generateContent(prompt),
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
                (model) => model.generateContent(prompt),
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
                (model) => model.generateContent([
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
                (model) => model.generateContent(prompt),
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
