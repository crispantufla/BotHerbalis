const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const MODEL = "gpt-4o-mini";
const MAX_RETRIES = 5;
const MAX_HISTORY_LENGTH = 15;

// --- RATE LIMIT CONFIGURATION ---
const MAX_CONCURRENT = 3;
const MIN_DELAY_MS = 200;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache

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
- Cápsulas: $46.900 (60 días) / $66.900 (120 días)
- Semillas: $36.900 (60 días) / $49.900 (120 días)
- Gotas: (Mencionar solo si preguntan). $48.900 (60 dias) / $68.900 (120 dias)
- Envío gratis por Correo Argentino, pago en efectivo al recibir
- Contraindicaciones: solo embarazo y lactancia
- Sin efecto rebote (es 100% natural)

MODALIDAD DE PAGO:
- Pago al recibir (Contra Reembolso)
- Plan 120 días: SIN costo adicional
- Plan 60 días: tiene un adicional de $6.000 (Modalidad Contra Reembolso MAX)
- NO aceptamos tarjeta, transferencia ni MercadoPago
- Costo logístico por rechazo o no retiro: $18.000

REGLAS ESTRICTAS:
1. Respuestas MUY CORTAS: 1-2 oraciones máximo. Nada de párrafos largos.
2. NO inventes pasos nuevos ni ofrezcas cosas que no están en el guión.
3. Si preguntan por servicios ajenos: "Solo manejamos productos Herbalis" y volvé al tema.
4. Si desconfían: "El envío es gratis y pagás solo al recibir"
5. Siempre terminá volviendo a la pregunta del paso actual (se te indica en cada mensaje).
6. NO repitas información que ya se dio en el historial.
7. Siempre terminá con una PREGUNTA cuando sea posible.
8. NO insistas más de una vez si el cliente no responde.
9. NO negocies precio. NO ofrezcas descuentos. NO ofrezcas tarjeta.
10. NO discutas con el cliente.

REGLAS DE EMPATÍA Y CONTENCIÓN:
11. Si el usuario comparte algo EMOCIONAL o PERSONAL (hijos, problemas de salud, bullying, autoestima), mostrá EMPATÍA PRIMERO con 1 oración comprensiva. Después volvé al paso actual.
12. NUNCA respondas con información de un paso futuro (precios, pagos, envíos) si el paso actual no lo pide.
13. Si no sabés qué responder, respondé con empatía y repetí la pregunta del paso actual.
14. PROHIBIDO inventar respuestas sobre temas que no están en tu información. Si no sabés, decí "Dejame consultar con mi compañero" y goalMet = false.
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
// AI SERVICE — OpenAI GPT-4o-mini
// ═══════════════════════════════════════════════════════
class AIService {
    constructor() {
        const apiKey = process.env.OPENAI_API_KEY || "";
        if (!apiKey) {
            console.error("❌ CRITICAL: OPENAI_API_KEY is missing!");
        }

        console.log(`📡 [AI] Initializing OpenAI (model: ${MODEL})`);

        this.client = new OpenAI({ apiKey });
        this.model = MODEL;

        this.queue = new RequestQueue(MAX_CONCURRENT, MIN_DELAY_MS);
        this.cache = new ResponseCache(CACHE_TTL_MS);
        this.stats = { calls: 0, cached: 0, retries: 0, errors: 0 };
    }

    /**
     * Core API call with retry + rate limit handling
     */
    async _callQueued(apiCallFn, cacheKey = null) {
        // Check cache first
        if (cacheKey) {
            const cached = this.cache.get(cacheKey);
            if (cached) {
                this.stats.cached++;
                return cached;
            }
        }

        this.stats.calls++;

        const result = await this.queue.enqueue(async () => {
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    return await apiCallFn();
                } catch (e) {
                    const status = e.status || e.statusCode;
                    if (status === 429) {
                        this.stats.retries++;
                        const waitTime = Math.pow(2, attempt + 1) * 1000 + Math.floor(Math.random() * 1000);
                        console.warn(`⚠️ [AI] Rate Limit (429). Attempt ${attempt + 1}/${MAX_RETRIES}. Backing off ${waitTime / 1000}s...`);
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
            const faq = context.knowledge.faq || [];
            const step = context.step || 'general';

            knowledgeContext = `INFORMACIÓN RELEVANTE PARA ESTE PASO:\n`;

            const pathInfo = faq.find(q => q.keywords.includes('diabetes'))?.response || "";
            if (pathInfo) knowledgeContext += `- SOBRE PATOLOGÍAS: "${pathInfo}"\n`;

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
                knowledgeContext += `- Plan 120 días sin adicional. Plan 60 días con Contra Reembolso MAX (+$6.000).\n`;
                knowledgeContext += `- Envío gratis por Correo Argentino, pago en efectivo al recibir\n`;
            } else if (step === 'waiting_data') {
                knowledgeContext += `- Necesitamos: nombre completo, calle y número, ciudad, código postal\n`;
                knowledgeContext += `- (NO menciones precios ni productos, ya están decididos)\n`;
            }

            knowledgeContext += `(No inventes datos, usá siempre esta base)`;
        }

        const userPrompt = `
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
            const result = await this._callQueued(
                () => this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: SYSTEM_INSTRUCTIONS },
                        { role: "user", content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 300
                }),
                null // No cache for chat — every conversation is unique
            );
            const text = result.choices[0].message.content;
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
     * Summarize history through the queue
     */
    async _callQueuedSummarize(history) {
        const conversationText = history.map(msg =>
            `${msg.role === 'user' ? 'Cliente' : 'Vendedor'}: ${msg.content}`
        ).join('\n');

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
                () => this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: "Sos un asistente que resume conversaciones de ventas de forma concisa." },
                        { role: "user", content: prompt }
                    ],
                    temperature: 0.3,
                    max_tokens: 200
                }),
                cacheKey
            );
            return result.choices[0].message.content.trim();
        } catch (e) {
            console.error("🔴 [AI] Summary Error:", e.message);
            return null;
        }
    }

    /**
     * Generate Report (for analyze_day.js)
     */
    async generateReport(prompt) {
        try {
            const result = await this._callQueued(
                () => this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: "Sos un analista de datos de ventas. Generá reportes claros y concisos." },
                        { role: "user", content: prompt }
                    ],
                    temperature: 0.3,
                    max_tokens: 1500
                }),
                null
            );
            return result.choices[0].message.content;
        } catch (e) {
            console.error("🔴 [AI] Report Error:", e.message);
            throw e;
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
                () => this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: "Sos un parser de direcciones postales argentinas. Respondé SOLO con JSON puro." },
                        { role: "user", content: prompt }
                    ],
                    temperature: 0,
                    max_tokens: 200
                }),
                `addr_${text.substring(0, 100)}`
            );
            return this._parseJSON(result.choices[0].message.content);
        } catch (e) {
            return { _error: true };
        }
    }

    /**
     * Transcribe Audio — Uses OpenAI Whisper API
     */
    async transcribeAudio(mediaData, mimeType) {
        try {
            // Convert base64 to buffer and write temp file (Whisper needs a file)
            const buffer = Buffer.from(mediaData, 'base64');
            const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
            const tmpPath = path.join(__dirname, `../../tmp_audio_${Date.now()}.${ext}`);

            fs.writeFileSync(tmpPath, buffer);

            const result = await this._callQueued(
                () => this.client.audio.transcriptions.create({
                    model: "whisper-1",
                    file: fs.createReadStream(tmpPath),
                    language: "es"
                }),
                null
            );

            // Cleanup temp file
            try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }

            return result.text || null;
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
                () => this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: SYSTEM_INSTRUCTIONS },
                        { role: "user", content: prompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 300
                }),
                null
            );
            return result.choices[0].message.content;
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
