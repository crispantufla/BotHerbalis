import logger from '../utils/logger';
import { differenceInDays } from 'date-fns';
import NodeCache from 'node-cache';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { UserState, HistoryMessage } from '../types/state';
import { lookupSemanticCache, storeSemanticCache } from './semanticCache';
import { buildHistoryTurns, ChatTurn } from './historyTurns';
import { _buildSystemBlocks, _buildSystemPrompt, RESPONSE_INSTRUCTIONS, _getPrices } from './aiPrompts';

// WhatsApp usa "*" para negrita, no "**" (markdown estándar). Si la IA devuelve
// **bold** o ## heading, en WhatsApp se renderiza con los asteriscos literales:
// queda feo ("- **Cápsulas**: $46.900"). Sanitizamos al borde para no depender
// de que el modelo recuerde la regla en cada turno.
function sanitizeForWhatsApp(text: string | null | undefined): string | null {
    if (!text) return text || null;
    return text
        .replace(/\*\*([^*\n]+?)\*\*/g, '*$1*')   // **bold** → *bold*
        .replace(/__([^_\n]+?)__/g, '*$1*')        // __bold__ → *bold*
        .replace(/^#{1,6}\s+(.+?)\s*$/gm, '*$1*'); // # heading → *heading*
}


// Interfaces locales
export interface APIContext {
    history?: HistoryMessage[];
    summary?: string;
    knowledge?: any;
    step?: string;
    goal?: string;
    userState?: UserState;
    // Analytics: si el caller pasa esto, logueamos una llamada a AI contra el
    // FunnelEvent abierto del (seller, phone). Fire-and-forget, no bloquea.
    sellerId?: string;
    phone?: string;
    // Override de modelo (lo usa el playground "Probar bot"): true fuerza Claude,
    // false fuerza GPT-4o, undefined deja decidir al A/B por seller/%.
    forceClaude?: boolean;
    // Interruptor de Mercado Pago del seller (config.mpEnabled). Lo inyecta el
    // proxy de salesFlow en TODAS las llamadas, así ningún step se olvida. En
    // false, el prompt se arma sin la opción de tarjeta. Default: encendido.
    mpEnabled?: boolean;
}

export interface AIParsedResponse {
    response?: string;
    goalMet?: boolean;
    extractedData?: string | null;
    _error?: boolean;
    nombre?: string | null;
    calle?: string | null;
    ciudad?: string | null;
    provincia?: string | null;
    cp?: string | null;
    postdatado?: string | null;
    aiUnavailable?: boolean;
}

// --- CONFIGURATION ---
// MODEL = pasos simples (greeting, waiting_weight, post_sale, completed) →
//   gpt-4o-mini es ~5× más rápido (2-3s vs 10-15s) y suficiente para detectar
//   intent básico, hacer un saludo o un acuse.
// MODEL_PREMIUM = pasos críticos del embudo (preference, plan_choice, data,
//   final_confirmation, etc.) — ahí sí queremos el razonamiento de gpt-4o
//   completo porque hay objeciones, empatía, manejo de precios.
const MODEL = "gpt-4o-mini";
const MODEL_PREMIUM = "gpt-4o";
const MAX_RETRIES = 3;

// ── A/B Claude (may-2026) ──────────────────────────────────────────────────
// Experimento: los sellers listados en CLAUDE_AB_SELLERS corren el chat() sobre
// Claude (Sonnet en pasos premium, Haiku en el resto) en vez de GPT-4o, para
// comparar conversión y tasa de errores de IA. Si la env está vacía o falta
// ANTHROPIC_API_KEY, el experimento queda OFF y todo corre igual que siempre.
// El resto de las llamadas (whisper, embeddings, visión, summary, parseAddress)
// se mantienen en OpenAI — Anthropic no tiene audio ni embeddings.
// Excepción: parseAddress cae a Claude si OpenAI falla (ver _claudeParseAddress).
const CLAUDE_MODEL_PREMIUM = process.env.CLAUDE_MODEL_PREMIUM || "claude-sonnet-4-6";
const CLAUDE_MODEL_SIMPLE = process.env.CLAUDE_MODEL_SIMPLE || "claude-haiku-4-5-20251001";
const CLAUDE_AB_SELLERS = new Set(
    (process.env.CLAUDE_AB_SELLERS || "").split(",").map(s => s.trim()).filter(Boolean)
);
// % de las conversaciones del seller que van a Claude (split DENTRO del seller,
// determinista y estable por teléfono). Default 50/50. Sirve cuando un solo seller
// concentra el tráfico y el A/B debe correr entre sus propios clientes (no entre
// sellers). Mantener fijo durante el experimento: cambiarlo re-asigna los brazos.
const CLAUDE_AB_PERCENT = Math.max(0, Math.min(100, parseInt(process.env.CLAUDE_AB_PERCENT || "50", 10) || 0));
// Solo path Claude: pasar el historial como TURNOS user/assistant reales en
// messages[] en vez de aplanado como texto, y cachear el system estable
// (cache_control ephemeral). Sigue mucho mejor el hilo de la conversación.
// ACTIVO por defecto; kill-switch sin redeploy: WA_STRUCTURED_TURNS=0 lo apaga.
// Seguro porque (a) solo afecta el brazo Claude del A/B, y (b) si Claude falla por
// cualquier motivo (incl. un 400 por turnos mal formados), _claudeChat devuelve null
// y el caller cae automáticamente a OpenAI con el blob clásico — peor caso = hoy.
const WA_STRUCTURED_TURNS = process.env.WA_STRUCTURED_TURNS !== '0' && process.env.WA_STRUCTURED_TURNS !== 'false';
// TTL del prompt cache de Anthropic para los bloques del system (path Claude).
// Medido sobre 14 días de prod (sep-2026): las llamadas que comparten prefijo llegan
// con gaps de 10-40 min, así que con el TTL default (5 min) el hit-rate era 3-39% y
// en los steps Sonnet la escritura a 1.25x salía MÁS cara que no cachear. Con 1h
// (escritura 2x, lectura 0.1x) el bloque CORE compartido pega ~96% en Haiku y ~74%
// en Sonnet. Verificable en logs: `[AI][usage] ... cache_w=… cache_r=…`.
const CLAUDE_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;

// Tool que obliga la respuesta estructurada del chat (path Claude). Va ANTES del
// system en el prefijo cacheado, así que también tiene que ser byte-estable.
const CLAUDE_DIALOG_TOOL = {
    name: "control_dialog_flow",
    description: "Emite la respuesta al cliente y gestiona el embudo de ventas",
    input_schema: {
        type: "object",
        properties: {
            response: { type: "string", description: "Tu respuesta para el cliente. Proporcional al mensaje: corta si es una pregunta rápida, extensa y empática solo en momentos emocionales/objeciones." },
            goalMet: { type: "boolean", description: "Si el cliente cumplió el objetivo del paso actual" },
            extractedData: { type: "string", description: "Datos extraídos de la intención del usuario (producto, quejas, edad, tags), o vacío" }
        },
        required: ["response", "goalMet"]
    }
};
// History window (ENTRADAS de array, no turnos: ~2 entradas por turno, así que
// 60 ≈ 25-30 turnos reales). Subido de 30→60 (jun-2026) junto con los turnos
// estructurados + system cacheado (ver WA_STRUCTURED_TURNS): con el system
// servido de cache, mandar una ventana más grande es barato y "hace 3 mensajes"
// queda holgadamente dentro de la ventana viva. Sonnet 4.6 (1M ctx) no es el límite.
const MAX_HISTORY_LENGTH = 60;
// Trigger rolling summary una vez que el history supera la ventana viva. Igual a
// MAX_HISTORY_LENGTH: el summary comprime SOLO lo que SALE de los últimos
// MAX_HISTORY_LENGTH (olderSlice = slice(0, -MAX_HISTORY_LENGTH)), no lo que sigue
// dentro de la ventana. checkAndSummarize se auto-protege con un cooldown.
const SUMMARIZE_TRIGGER = 60;
// Don't re-summarize more often than this (in ms). Prevents burning tokens
// when a user sends many messages in quick succession.
const SUMMARIZE_COOLDOWN_MS = 10 * 60 * 1000;

// Steps that use the premium model (high-conversion, complex reasoning)
const PREMIUM_STEPS = new Set([
    'waiting_preference',
    'waiting_preference_consultation',
    'waiting_plan_choice',
    'waiting_price_confirmation',
    'waiting_ok',
    'waiting_data',
    'waiting_final_confirmation',
    'closing'
]);

function _getModelForStep(step: string): string {
    return PREMIUM_STEPS.has(step) ? MODEL_PREMIUM : MODEL;
}

// --- RATE LIMIT CONFIGURATION ---
// Process-wide concurrency cap for OpenAI calls (shared across all sellers).
// With 8 sellers × 3 workers = 24 potential concurrent calls → cap at 8.
const pLimit = require('p-limit');
const _aiConcurrencyLimit = pLimit(8);
const MIN_DELAY_MS = 200;
const CACHE_TTL_SECONDS = 45 * 60; // 45 min cache for node-cache

// --- CIRCUIT BREAKER ---
const CIRCUIT_BREAKER_THRESHOLD = 3;   // consecutive failures to open circuit
const CIRCUIT_BREAKER_RESET_MS = 30_000; // 30s cooldown before retrying




// ═══════════════════════════════════════════════════════
// AI SERVICE — OpenAI GPT-4o-mini
// ═══════════════════════════════════════════════════════
class AIService {
    client: OpenAI;
    model: string;
    cache: NodeCache;
    stats: { calls: number, cached: number, retries: number, errors: number, promptTokens: number, completionTokens: number, estimatedCostUSD: number };
    // Per-seller circuit breakers — prevents one seller's OpenAI failures from blocking all others
    _circuitBreakers: Map<string, { failures: number, openUntil: number }>;
    _disabled: boolean;
    // A/B Claude — cliente Anthropic (lazy, solo si el experimento está activo)
    anthropic: any;
    _claudeDisabled: boolean;
    // Marca de cuánto costo ya se "flusheó" al contador mensual en disco
    // (ver getCostDeltaUSD + el guardián de presupuesto del scheduler).
    _costFlushedUSD: number;

    constructor() {
        const apiKey = process.env.OPENAI_API_KEY || "";
        if (!apiKey) {
            logger.error("❌ CRITICAL: OPENAI_API_KEY is missing!");
        }
        this._disabled = !apiKey;

        logger.info(`📡[AI] Initializing OpenAI(base: ${MODEL}, premium: ${MODEL_PREMIUM})`);

        this.client = new OpenAI({ apiKey, timeout: 15_000 });
        this.model = MODEL;
        this.cache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS, checkperiod: 120, maxKeys: 1000 });
        this.stats = { calls: 0, cached: 0, retries: 0, errors: 0, promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 };
        this._costFlushedUSD = 0;
        this._circuitBreakers = new Map();

        // Claude: el cliente se inicializa SIEMPRE que haya ANTHROPIC_API_KEY,
        // independientemente del A/B — así el playground "Probar bot" puede forzar
        // Claude aunque no haya ningún seller en el experimento. El A/B (por seller
        // y %) se decide aparte en _useClaudeFor.
        const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
        this.anthropic = null;
        if (anthropicKey) {
            try {
                const Anthropic = require('@anthropic-ai/sdk');
                this.anthropic = new (Anthropic.default || Anthropic)({ apiKey: anthropicKey, timeout: 20_000 });
                if (CLAUDE_AB_SELLERS.size > 0) {
                    logger.info(`📡[AI] Claude A/B ON para [${[...CLAUDE_AB_SELLERS].join(', ')}] @ ${CLAUDE_AB_PERCENT}% — premium=${CLAUDE_MODEL_PREMIUM}, simple=${CLAUDE_MODEL_SIMPLE}`);
                } else {
                    logger.info(`📡[AI] Anthropic listo (Claude disponible para playground; A/B OFF)`);
                }
            } catch (e: any) {
                logger.error(`[AI] No se pudo iniciar Anthropic SDK: ${e.message}`);
                this.anthropic = null;
            }
        }
        this._claudeDisabled = !this.anthropic;
    }

    /** A/B: ¿esta conversación (seller + teléfono) debe correr sobre Claude?
     * Split determinista y estable por teléfono: el mismo cliente cae siempre en
     * el mismo brazo (no flipea a mitad de conversación). Así el A/B corre DENTRO
     * de un seller, sobre el mismo tráfico, en vez de comparar sellers distintos. */
    _useClaudeFor(sellerId?: string, phone?: string): boolean {
        if (this._claudeDisabled || !this.anthropic || !sellerId) return false;
        // '*' en CLAUDE_AB_SELLERS = TODOS los sellers (migración full a Claude,
        // incluye sellers futuros). Si no, solo los listados.
        if (!CLAUDE_AB_SELLERS.has('*') && !CLAUDE_AB_SELLERS.has(sellerId)) return false;
        if (CLAUDE_AB_PERCENT >= 100) return true;
        if (CLAUDE_AB_PERCENT <= 0 || !phone) return false;
        const h = parseInt(crypto.createHash('md5').update(String(phone)).digest('hex').slice(0, 8), 16);
        return (h % 100) < CLAUDE_AB_PERCENT;
    }

    /**
     * Llamada de chat sobre Claude (Anthropic Messages API + tool use).
     * Devuelve los args del tool control_dialog_flow ({response, goalMet, extractedData})
     * o null si falla (el caller cae a OpenAI como fallback).
     */
    async _claudeChat(systemPrompt: string | string[], userPrompt: string, step: string, sellerId: string, historyTurns?: ChatTurn[]): Promise<{ response?: string; goalMet?: boolean; extractedData?: string | null } | null> {
        try {
            const model = PREMIUM_STEPS.has(step) ? CLAUDE_MODEL_PREMIUM : CLAUDE_MODEL_SIMPLE;
            // Modo turnos estructurados (flag WA_STRUCTURED_TURNS): el historial va
            // como turnos user/assistant reales antes del mensaje actual, y el system
            // (estable por step) se cachea. Si no, comportamiento clásico (blob aplanado).
            const structured = Array.isArray(historyTurns);
            const messages = structured
                ? [...historyTurns!, { role: "user", content: userPrompt }]
                : [{ role: "user", content: userPrompt }];
            // Un bloque por nivel de estabilidad, cada uno con su breakpoint de caché (ver
            // _buildSystemBlocks). Si llega un string (playground, tests) va como bloque único.
            const sysBlocks = Array.isArray(systemPrompt) ? systemPrompt : [systemPrompt];
            const system: any = structured
                ? sysBlocks.map(text => ({ type: "text", text, cache_control: CLAUDE_CACHE_CONTROL }))
                : sysBlocks.join('\n\n');
            // El cache exact-match debe incluir el historial: en modo estructurado
            // userPrompt ya NO lo contiene, así que dos charlas distintas con el mismo
            // mensaje actual + step colisionarían si no lo metemos en la key.
            const cacheKey = structured
                ? `claude_chat_${step}_${JSON.stringify(historyTurns)}_${userPrompt}`
                : `claude_chat_${step}_${userPrompt}`;
            const result: any = await this._callQueued(
                () => this.anthropic.messages.create({
                    model,
                    max_tokens: 800,
                    temperature: 0.6,
                    system,
                    messages,
                    tools: [CLAUDE_DIALOG_TOOL],
                    tool_choice: { type: "tool", name: "control_dialog_flow" }
                }),
                cacheKey, // namespace de caché distinto al de OpenAI (incluye historial en modo estructurado)
                undefined,
                sellerId
            );
            const toolUse = (result?.content || []).find((c: any) => c.type === 'tool_use');
            if (toolUse && toolUse.input) {
                return { response: toolUse.input.response, goalMet: toolUse.input.goalMet, extractedData: toolUse.input.extractedData || null };
            }
            logger.warn(`[AI][CLAUDE-AB] respuesta sin tool_use para ${sellerId} (step ${step})`);
            return null;
        } catch (e: any) {
            logger.error(`[AI][CLAUDE-AB] error para ${sellerId} (step ${step}): ${e.message}`);
            return null;
        }
    }

    _getCircuitBreaker(sellerId: string = 'global'): { failures: number, openUntil: number } {
        if (!this._circuitBreakers.has(sellerId)) {
            this._circuitBreakers.set(sellerId, { failures: 0, openUntil: 0 });
        }
        return this._circuitBreakers.get(sellerId)!;
    }

    /**
     * Hash string utility for Keys
     */
    _hashKey(str: string): string {
        return 'ai_' + crypto.createHash('sha256').update(str).digest('hex').substring(0, 24);
    }

    /**
     * Core API call with retry + rate limit handling
     */
    async _callQueued<T>(apiCallFn: () => Promise<T>, rawCacheKey: string | null = null, customTTL: number | undefined = undefined, sellerId: string = 'global'): Promise<T> {
        if (this._disabled) throw new Error('AI Service disabled: missing API key');
        // Check cache first
        let cacheKey = null;
        if (rawCacheKey) {
            cacheKey = this._hashKey(rawCacheKey);
            const cached: T | undefined = this.cache.get(cacheKey);
            if (cached !== undefined) {
                this.stats.cached++;
                return cached;
            }
        }
        this.stats.calls++;

        // Per-seller circuit breaker: if open, fail fast for THIS seller only
        const cb = this._getCircuitBreaker(sellerId);
        const now = Date.now();
        if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD && now < cb.openUntil) {
            this.stats.errors++;
            throw new Error(`AI Service Unavailable (Circuit Breaker Open for ${sellerId})`);
        }

        let result: T | undefined;
        let success = false;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                result = await _aiConcurrencyLimit(apiCallFn);
                success = true;
                cb.failures = 0; // Reset on success
                break;
            } catch (e: any) {
                const status = e.status || e.statusCode;
                const isRetryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 529 || e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET';
                if (isRetryable) {
                    this.stats.retries++;
                    // No dormir tras el ÚLTIMO intento: no hay reintento después,
                    // solo sumaba ~9s de latencia antes de tirar Max Retries.
                    if (attempt < MAX_RETRIES - 1) {
                        const waitTime = Math.pow(2, attempt + 1) * 1000 + Math.floor(Math.random() * 1000);
                        logger.warn(`⚠️[AI] Retryable error (${status || e.code}). Attempt ${attempt + 1}/${MAX_RETRIES}. Backing off ${waitTime / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitTime));
                    } else {
                        logger.warn(`⚠️[AI] Retryable error (${status || e.code}). Attempt ${attempt + 1}/${MAX_RETRIES} — no more retries.`);
                    }
                } else {
                    this.stats.errors++;
                    throw e;
                }
            }
        }

        if (!success || result === undefined) {
            this.stats.errors++;
            cb.failures++;
            if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
                cb.openUntil = Date.now() + CIRCUIT_BREAKER_RESET_MS;
                logger.warn(`⚠️[AI] Circuit breaker OPEN for ${sellerId} — ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures. Cooling down ${CIRCUIT_BREAKER_RESET_MS / 1000}s.`);
            }
            throw new Error("AI Service Unavailable (Max Retries Exceeded)");
        }

        // Track token usage — pricing per model
        // gpt-4o-mini: $0.15/1M input, $0.60/1M output
        // gpt-4o:      $2.50/1M input, $10.00/1M output
        const usage = (result as any)?.usage;
        if (usage) {
            const model = (result as any)?.model || '';
            if (model.startsWith('claude')) {
                // Anthropic: input_tokens son SOLO los no cacheados; los de caché vienen
                // aparte. Tarifas: Sonnet 4.6 $3/$15 por M, Haiku 4.5 $1/$5. Escritura de
                // caché = 2x input (TTL 1h) o 1.25x (5m); lectura = 0.1x. Antes se ignoraban
                // los tokens de caché y el costo estimado quedaba por debajo del real.
                const inTok = usage.input_tokens || 0;
                const outTok = usage.output_tokens || 0;
                const cacheR = usage.cache_read_input_tokens || 0;
                const cacheW = usage.cache_creation_input_tokens || 0;
                const cacheW1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? cacheW;
                const cacheW5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
                const isBig = model.includes('sonnet') || model.includes('opus');
                const inputRate  = isBig ? 0.000003 : 0.000001;
                const outputRate = isBig ? 0.000015 : 0.000005;
                const cost = (inTok + cacheW1h * 2 + cacheW5m * 1.25 + cacheR * 0.1) * inputRate + outTok * outputRate;
                this.stats.promptTokens += inTok + cacheW + cacheR;
                this.stats.completionTokens += outTok;
                this.stats.estimatedCostUSD += cost;
                // Una línea por llamada: es la única forma de ver el hit-rate real del
                // prompt cache en prod (railway logs | grep "\[AI\]\[usage\]").
                logger.info(`[AI][usage] ${model} in=${inTok} cache_w=${cacheW} cache_r=${cacheR} out=${outTok} ≈$${cost.toFixed(4)} seller=${sellerId}`);
            } else {
                // OpenAI: prompt_tokens/completion_tokens
                const isPremium = model.startsWith('gpt-4o') && !model.includes('mini');
                const inputRate  = isPremium ? 0.0000025 : 0.00000015;
                const outputRate = isPremium ? 0.00001   : 0.0000006;
                this.stats.promptTokens += usage.prompt_tokens || 0;
                this.stats.completionTokens += usage.completion_tokens || 0;
                this.stats.estimatedCostUSD += ((usage.prompt_tokens || 0) * inputRate) + ((usage.completion_tokens || 0) * outputRate);
            }
        }

        // Cache the result. El `set` de node-cache TIRA ECACHEFULL al tocar maxKeys
        // (no desaloja), y acá estaría tirando DESPUÉS de que la llamada al proveedor
        // ya salió bien: sin este catch, el cache lleno convertía una respuesta válida
        // en un error del step. Guardar en cache es best-effort — el TTL de 45min lo
        // vacía solo.
        if (cacheKey && result) {
            try {
                if (customTTL) {
                    this.cache.set(cacheKey, result, customTTL);
                } else {
                    this.cache.set(cacheKey, result);
                }
            } catch (e: any) {
                logger.warn(`[AI] No se pudo cachear la respuesta: ${e?.message || e}`);
            }
        }

        return result;
    }

    /**
     * Main Chat Function
     */
    async chat(userText: string, context: APIContext): Promise<AIParsedResponse> {
        // Interruptor de Mercado Pago del seller (lo inyecta el proxy de salesFlow).
        // Default encendido: si un caller no lo pasa, el prompt queda como siempre.
        const mpOn = context.mpEnabled !== false;

        // Build dynamic history. MAX_HISTORY_LENGTH = 30 cubre conversación viva;
        // el rolling summary cubre lo anterior sin inflar el prompt.
        let conversationHistory = (context.history || []).slice(-MAX_HISTORY_LENGTH);
        let summaryContext = "";

        if (context.summary) {
            summaryContext = `RESUMEN PREVIO: \n"${context.summary}"\n\n`;
        }

        let knowledgeContext = "";
        if (context.knowledge && context.knowledge.flow) {
            const faq = context.knowledge.faq || [];
            const step = context.step || 'general';

            const priceData = await _getPrices();
            // Política mayo 2026 (rev 2): ya no hay adicional $6.000 ni seña/anticipo.
            // Contrarrembolso = retiro en sucursal, paga total al retirar (sin anticipo previo).
            const priceCaps60 = priceData['Cápsulas']?.['60'] || '54.900';
            const priceCaps120 = priceData['Cápsulas']?.['120'] || '68.900';
            const priceSem60 = priceData['Semillas']?.['60'] || '36.900';
            const priceSem120 = priceData['Semillas']?.['120'] || '49.900';
            const priceGotas60 = priceData['Gotas']?.['60'] || '54.900';
            const priceGotas120 = priceData['Gotas']?.['120'] || '68.900';

            const priceString = `Cápsulas($${priceCaps60}/60d, $${priceCaps120}/120d) | Semillas($${priceSem60}/60d, $${priceSem120}/120d) | Gotas($${priceGotas60}/60d, $${priceGotas120}/120d)`;

            knowledgeContext = `INFORMACIÓN RELEVANTE PARA ESTE PASO: \n`;

            const pathInfo = faq.find((q: any) => q.keywords.includes('diabetes'))?.response || "";
            if (pathInfo) knowledgeContext += `- SOBRE PATOLOGÍAS: "${pathInfo}"\n`;

            if (['waiting_weight', 'waiting_preference'].includes(step)) {
                knowledgeContext += `- 3 OPCIONES DE PRODUCTO: Cápsulas (forma práctica), Gotas (forma líquida, suave al estómago), Semillas (forma 100% natural, ritual de infusión nocturna). Las 3 son igual de efectivas; si el cliente pide recomendación, andá con cápsulas por practicidad/popularidad (sin afirmar que es más efectiva).\n`;
                knowledgeContext += `- DOSIS por kilos: hasta 10 kg → 60 días; 10-20 kg → 120 días (sobra un poco, sirve mantenimiento); más de 20 kg → 120 días (lo que el cuerpo necesita).\n`;
                knowledgeContext += `- Gastritis/úlcera/acidez: cápsulas o gotas (semillas pueden irritar). Es la única razón médica para descartar una forma.\n`;
                knowledgeContext += `- Contraindicaciones: solo embarazo y lactancia.NO menores de edad.\n`;
                knowledgeContext += `- PRECIOS (COTIZÁ EN CONTEXTO): Si YA recomendaste un producto o el cliente ya mostró interés/eligió uno (ej cápsulas) y pregunta el precio, dale SOLO los 2 planes (60 y 120 días) de ESE producto — NO la lista de los 3. La lista completa SOLO si todavía no hay un producto en foco, o si piden "precio de todos"/"lista de precios". Si no hay foco y preguntan "precio" a secas, decí el rango "$${priceSem60} a $${priceGotas120}". Datos de precios (elegí el producto que corresponda): ${priceString}.\n`;
                knowledgeContext += `- ENVÍO Y PAGO: Envío gratis por Correo Argentino. 2 opciones: retiro en sucursal (paga en efectivo al retirar, 7 a 10 días hábiles) o envío a domicilio prepago con ${mpOn ? 'tarjeta de crédito o transferencia' : 'transferencia bancaria (el pago con tarjeta está fuera de servicio: NO lo menciones)'} (más rápido, 4 días hábiles). NUNCA menciones cuotas ni anticipo.\n`;
            } else if (step === 'waiting_price_confirmation') {
                knowledgeContext += `- El usuario todavía NO vio precios.Tu trabajo es convencerlo de que quiera verlos.\n`;
                knowledgeContext += `- Contraindicaciones: solo embarazo y lactancia.NO menores de edad.\n`;
                knowledgeContext += `- (NO menciones precios específicos ni formas de pago, solo que son accesibles) \n`;
            } else if (['waiting_plan_choice', 'closing', 'waiting_ok'].includes(step)) {
                knowledgeContext += `- PRECIOS: ${priceString} \n`;
                knowledgeContext += mpOn
                    ? `- POLÍTICA DE ENVÍO Y PAGO (modelo jun-2026): 2 opciones — (1) *Retiro en sucursal* → contrarrembolso, paga el TOTAL en efectivo al retirar en una sucursal de Correo Argentino (sin anticipo); (2) *Envío a domicilio* → prepago con *tarjeta de crédito* (link de pago) o *transferencia bancaria* al alias HERBALIS.TIENDA (BIO ORIGEN S.A.S.). De cara al cliente el medio online se llama "Tarjeta de crédito" (NUNCA "Mercado Pago", débito, Pago Fácil ni Rapipago). Aplica a TODOS los planes. NUNCA menciones cuotas ni anticipo de $10.000.\n`
                    : `- POLÍTICA DE ENVÍO Y PAGO: 2 opciones — (1) *Retiro en sucursal* → contrarrembolso, paga el TOTAL en efectivo al retirar en una sucursal de Correo Argentino (sin anticipo); (2) *Envío a domicilio* → prepago por *transferencia bancaria* al alias HERBALIS.TIENDA (BIO ORIGEN S.A.S.). 🛑 El pago con TARJETA está fuera de servicio en estos días: NO lo ofrezcas ni lo menciones (ni "tarjeta", ni "link de pago", ni "Mercado Pago"). Aplica a TODOS los planes. NUNCA menciones cuotas ni anticipo de $10.000.\n`;
                knowledgeContext += `- NO mencionar 'adicional de $6.000' (esa política ya no existe). NO decir 'envío gratis solo en plan 120'.\n`;
                knowledgeContext += `- Envío gratis por Correo Argentino. *Retiro en sucursal* (paga al retirar): *7 a 10 días hábiles*. *Envío a domicilio PREPAGO* (${mpOn ? 'tarjeta de crédito/transferencia' : 'transferencia'}): más rápido, *4 días hábiles* — usalo como argumento para cerrar el prepago.\n`;
            } else if (step === 'waiting_data') {
                knowledgeContext += `- Necesitamos: nombre completo, calle y número, ciudad, código postal\n`;
                knowledgeContext += `- PROHIBIDO PEDIR NÚMERO DE TELÉFONO.Ya estamos hablando por WhatsApp, ¡ya tenemos su número! Nunca pidas este dato.\n`;
                knowledgeContext += `- (NO ofrezcas ni menciones precios ni productos a menos que el cliente pregunte explícitamente por ellos. Si preguntan, los precios son: ${priceString}) \n`;
            }

            knowledgeContext += `(No inventes datos, usá siempre esta base)`;
        }

        // P2 #1: Add user state context (cart, product, address, authoritative total)
        let stateContext = "";
        if (context.userState) {
            const s = context.userState;
            if (s.selectedProduct) stateContext += `- Producto elegido: ${s.selectedProduct} \n`;
            if (s.cart && s.cart.length > 0) {
                stateContext += `- Carrito (precios base por ítem, NO son el total a pagar): ${s.cart.map(i => `${i.product} (${i.plan} días) $${i.price}`).join(', ')} \n`;
            }
            // Authoritative total — already includes adicional MAX / descuentos si aplican.
            // Si el AI necesita cotizarle al cliente, DEBE usar este número y NO reconstruirlo.
            if (s.totalPrice) {
                stateContext += `- TOTAL AUTORITATIVO A PAGAR: $${s.totalPrice} (este es el ÚNICO total que podés cotizarle al cliente)\n`;
            }
            if (s.paymentMethod) {
                const pmLabel = s.paymentMethod === 'mercadopago' ? 'Tarjeta de crédito (ya pagó online)'
                    : s.paymentMethod === 'transferencia' ? 'Transferencia bancaria'
                    : s.paymentMethod === 'contrarembolso' || s.paymentMethod === 'efectivo'
                        ? (s.shippingChoice === 'retiro'
                            ? 'Contrarrembolso — retiro en sucursal (paga total en efectivo al retirar)'
                            // Legacy: state con senaAmount/senaPaid del flujo viejo. Solo se usa
                            // para conversaciones pre-may-2026 que todavía estén abiertas.
                            : (s.senaPaid && s.senaAmount
                                ? `[Legacy] Contra reembolso con seña pagada ($${(s.senaAmount || 0).toLocaleString('es-AR').replace(/,/g, '.')} por MP, saldo al cartero)`
                                : (s.senaAmount && s.senaAmount > 0
                                    ? `[Legacy] Contra reembolso (esperando seña de $${s.senaAmount.toLocaleString('es-AR').replace(/,/g, '.')})`
                                    : 'Contrarrembolso — retiro en sucursal (paga total en efectivo al retirar)')))
                    : s.paymentMethod;
                stateContext += `- Método de pago elegido: ${pmLabel}\n`;
            }
            if (s.partialAddress && Object.keys(s.partialAddress).length > 0) {
                const a = s.partialAddress;
                stateContext += `- Datos parciales: ${a.nombre || '?'}, ${a.calle || '?'}, ${a.ciudad || '?'}, CP ${a.cp || '?'} \n`;
            }
        }
        if (stateContext) {
            stateContext = `\nESTADO DEL CLIENTE: \n${stateContext} `;
        }

        // El historial va embebido como texto (modo clásico, path OpenAI y Claude
        // no-estructurado). En modo estructurado (flag, solo Claude) se omite acá y
        // viaja como turnos user/assistant reales en messages[] (ver branch de Claude).
        const historyText = conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n');
        // Anti-repetición explícita: Claude respeta mucho mejor "no repitas ESTA frase"
        // que el steer genérico (el replay de sep-2026 mostró calcos casi textuales del
        // mensaje anterior en envío/pago y en cierres de plan). Va en el turno user
        // (contenido dinámico), así no toca el prefijo cacheado del system.
        const lastBotMsg = [...conversationHistory].reverse().find(m => m.role !== 'user' && typeof m.content === 'string' && m.content.trim());
        const lastBotContext = lastBotMsg
            ? `TU ÚLTIMO MENSAJE (PROHIBIDO repetirlo textual o casi textual — si tenés que volver a decir lo mismo, reformulalo con otras palabras y sumá algo nuevo): "${lastBotMsg.content.replace(/\s+/g, ' ').slice(0, 400)}"
`
            : '';
        const buildUserPrompt = (historySection: string, withInstructions: boolean) => `
${summaryContext}
${knowledgeContext}
${stateContext}
ETAPA ACTUAL: "${context.step || 'general'}"
OBJETIVO DEL PASO: "${context.goal || 'Ayudar al cliente'}"
${historySection}
${lastBotContext}MENSAJE DEL USUARIO: "${userText}"
${withInstructions ? '\n' + RESPONSE_INSTRUCTIONS + '\n' : '\nAplicá las INSTRUCCIONES DE RESPUESTA del system.\n'}`;

        // Con historial embebido (path OpenAI + Claude no-estructurado): idéntico a antes.
        // Sin historial embebido (Claude estructurado): el hilo va como turnos en messages[].
        const userPrompt = buildUserPrompt(`\nHISTORIAL RECIENTE:\n${historyText}\n`, true);
        const userPromptNoHistory = buildUserPrompt('', false);

        try {
            const step = context.step || 'general';

            // Decisión de modelo ADELANTADA (antes la calculábamos después del
            // lookup): la necesitamos para namespacear el semantic cache por
            // engine. El playground puede forzar (context.forceClaude); si no,
            // aplica el A/B por seller/%. Si Claude falla, caemos a OpenAI abajo.
            let useClaudeNow: boolean;
            if (context.forceClaude === true) useClaudeNow = !!this.anthropic;
            else if (context.forceClaude === false) useClaudeNow = false;
            else useClaudeNow = this._useClaudeFor(context.sellerId, context.phone);
            // El namespace del semantic cache separa por engine Y por interruptor de
            // MP: las respuestas cacheadas de los steps tempranos suelen incluir los
            // medios de pago, así que una guardada con tarjeta no puede servirse
            // cuando la tarjeta está apagada (ni al revés cuando vuelve).
            const cacheEngine = (useClaudeNow ? 'claude' : 'openai') + (mpOn ? '' : ':nomp');

            // ── Semantic cache lookup (FAQs / paraphrased questions) ──
            // Only hits cacheable steps; skipped automatically otherwise.
            // Respects conversation-specific state: if totalPrice, cart items,
            // or a postdatado are present, we skip the cache because a cached
            // reply could leak the wrong numbers/context into another chat.
            const userStateSnap = context.userState;
            const hasOrderContext = !!(
                userStateSnap?.totalPrice ||
                (userStateSnap?.cart && userStateSnap.cart.length > 0) ||
                userStateSnap?.postdatado ||
                (userStateSnap?.partialAddress && Object.keys(userStateSnap.partialAddress).length > 0)
            );
            // En el playground (context.forceClaude definido) NO usamos el semantic
            // cache: si no, GPT y Claude devolverían la MISMA respuesta cacheada y no
            // se podrían comparar. Tampoco queremos contaminar el cache de prod con
            // respuestas de prueba (el store de abajo también se saltea en ese caso).
            if (!hasOrderContext && context.forceClaude === undefined) {
                try {
                    const cached = await lookupSemanticCache(this.client, step, userText, cacheEngine);
                    if (cached) {
                        this.stats.cached++;
                        return { response: sanitizeForWhatsApp(cached.response), goalMet: false, extractedData: null };
                    }
                } catch (e: any) {
                    logger.warn(`[AI] Semantic cache lookup errored: ${e.message}`);
                }
            }

            // Analytics: fire-and-forget — marca que este turn usó AI.
            if (context.sellerId && context.phone) {
                try {
                    const { incrementAiCallCount } = require('./funnelLogger');
                    incrementAiCallCount(context.sellerId, context.phone).catch(() => {});
                } catch (e) { /* module not loaded — fine */ }
            }

            const chatModel = _getModelForStep(step);
            const systemPrompt = await _buildSystemPrompt(step, userText, false, mpOn);

            // useClaudeNow ya se calculó arriba (lo necesitábamos para el cache).
            if (useClaudeNow) {
                // Modo estructurado (solo Claude, detrás de flag): historial como turnos
                // user/assistant reales + system estable cacheado. El path OpenAI de
                // abajo NO se toca (sigue con userPrompt + systemPrompt clásicos).
                const structured = WA_STRUCTURED_TURNS;
                const sysForClaude = structured ? await _buildSystemBlocks(step, mpOn) : systemPrompt;
                const turns = structured ? buildHistoryTurns(conversationHistory, userText) : undefined;
                const promptForClaude = structured ? userPromptNoHistory : userPrompt;
                const cArgs = await this._claudeChat(sysForClaude, promptForClaude, step, context.sellerId!, turns);
                if (cArgs && cArgs.response) {
                    if (!cArgs.goalMet && !cArgs.extractedData && !hasOrderContext && context.forceClaude === undefined) {
                        storeSemanticCache(this.client, step, userText, cArgs.response, cacheEngine).catch(() => { /* best effort */ });
                    }
                    return {
                        response: sanitizeForWhatsApp(cArgs.response),
                        goalMet: cArgs.goalMet,
                        extractedData: cArgs.extractedData || null
                    };
                }
                logger.warn(`[AI][CLAUDE-AB] fallback a OpenAI para ${context.sellerId} (step ${step})`);
            }

            const result: any = await this._callQueued(
                () => this.client.chat.completions.create({
                    model: chatModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    tools: [{
                        type: "function",
                        function: {
                            name: "control_dialog_flow",
                            description: "Emite la respuesta al usuario y gestiona el embudo de ventas",
                            parameters: {
                                type: "object",
                                properties: {
                                    response: { type: "string", description: "Tu respuesta para el cliente. DEBE SER PROPORCIONAL al mensaje del usuario. Si el usuario escribe mucho o se nota vulnerable, tu respuesta debe ser extensa, de varios párrafos si es necesario, súper empática. Si solo hace una pregunta rápida, responde rápido." },
                                    goalMet: { type: "boolean", description: "Si el usuario o cliente cumplió el objetivo del paso actual" },
                                    extractedData: { type: "string", description: "Datos extraidos de la intencion del usuario (ej: producto, quejas, edad), o vacio" }
                                },
                                required: ["response", "goalMet"]
                            }
                        }
                    }],
                    tool_choice: { type: "function", function: { name: "control_dialog_flow" } },
                    temperature: 0.6,
                    // Cap a 800 — WhatsApp responses son cortas (~3 párrafos max).
                    // Antes teníamos 1500, deja la puerta abierta a respuestas
                    // innecesariamente largas que tardan más en generarse.
                    max_tokens: 800
                }),
                // Caché exact-match: la key DEBE incluir historial+estado (userPrompt
                // los embebe), igual que el path Claude. Con solo step+userText, dos
                // clientes que escriben lo mismo en el mismo step se cruzaban la
                // respuesta cacheada (total/nombre del otro).
                // El sufijo de MP evita servir una respuesta cacheada con tarjeta
                // después de apagar el interruptor (el userPrompt no siempre cambia:
                // la política de pago vive en el system, no en el user).
                `chat_${step}_${mpOn ? 'mp' : 'nomp'}_${userPrompt}`,
                undefined,
                context.sellerId || 'global'
            );

            const toolCalls = result.choices[0].message?.tool_calls;
            if (toolCalls && toolCalls.length > 0) {
                const args = JSON.parse(toolCalls[0].function.arguments);
                // Persist FAQ-style responses into the semantic cache. We only
                // store when the turn did not advance the flow and no data was
                // extracted — that's the clearest signal the AI was just
                // answering a question rather than taking action on the order.
                if (
                    args.response &&
                    !args.goalMet &&
                    !args.extractedData &&
                    !hasOrderContext &&
                    context.forceClaude === undefined
                ) {
                    storeSemanticCache(this.client, step, userText, args.response, cacheEngine)
                        .catch(() => { /* best effort */ });
                }
                return {
                    response: sanitizeForWhatsApp(args.response),
                    goalMet: args.goalMet,
                    extractedData: args.extractedData || null
                };
            }
            logger.warn("⚠️[AI] No tool_calls in response. Returning aiUnavailable.");
            return { response: null, goalMet: false, aiUnavailable: true };
        } catch (e: any) {
            logger.error("🔴 [AI] Chat Error:", e.message);
            return { response: null, goalMet: false, aiUnavailable: true };
        }
    }

    /**
     * Rolling history summary.
     *
     * Called from the global flow after each user turn. If the active history
     * is long enough AND enough time has passed since the last summary, we
     * take everything older than the last MAX_HISTORY_LENGTH messages, merge
     * it with the previous rolling summary (so context is never lost), and
     * prune those messages out of state.
     *
     * Returns null when there's nothing to do — either the history is still
     * short, or we're inside the cooldown window. Non-null results are the
     * caller's responsibility to persist.
     *
     * Params:
     *   - history: full history array (will NOT be mutated)
     *   - previousSummary: existing state.summary, or null/empty on first run
     *   - lastSummarizedAt: state.lastSummarizedAt (ms epoch), for rate limit
     */
    async checkAndSummarize(
        history: HistoryMessage[],
        previousSummary?: string | null,
        lastSummarizedAt?: number | null,
        sellerId?: string
    ): Promise<{ summary: string; prunedHistory: HistoryMessage[]; lastSummarizedAt: number } | null> {
        if (!history || history.length <= SUMMARIZE_TRIGGER) return null;

        // Cooldown: don't thrash the summarizer for chatty users
        const now = Date.now();
        if (lastSummarizedAt && (now - lastSummarizedAt) < SUMMARIZE_COOLDOWN_MS) {
            return null;
        }

        const olderSlice = history.slice(0, -MAX_HISTORY_LENGTH);
        if (olderSlice.length === 0) return null;

        logger.info(`[AI] Rolling summary: ${history.length} msgs → pruning ${olderSlice.length}, keeping ${MAX_HISTORY_LENGTH} tail`);

        const newSummary = await this._callQueuedSummarize(olderSlice, previousSummary || '', sellerId);
        if (!newSummary) return null;

        logger.info(`[AI] Summary updated: "${newSummary.substring(0, 60)}..."`);
        return {
            summary: newSummary,
            prunedHistory: history.slice(-MAX_HISTORY_LENGTH),
            lastSummarizedAt: now,
        };
    }

    /**
     * Manual Summary Trigger (for API)
     */
    async generateManualSummary(history: HistoryMessage[], sellerId?: string): Promise<string | null> {
        return await this._callQueuedSummarize(history, '', sellerId);
    }

    /**
     * Summarize history through the queue.
     *
     * If a previousSummary is provided, the prompt asks the model to MERGE
     * the existing summary with the new chunk so context from the start of
     * the conversation isn't lost across rolling summarizations.
     */
    async _callQueuedSummarize(history: HistoryMessage[], previousSummary: string = '', sellerId?: string): Promise<string | null> {
        const conversationText = history.map(msg =>
            `${msg.role === 'user' ? 'Cliente' : 'Vendedor'}: ${msg.content} `
        ).join('\n');

        const cacheKey = `summary_${history.length}_${(previousSummary || '').substring(0, 20)}_${history.slice(-3).map(m => m.content).join('|')} `;

        const prompt = previousSummary
            ? `
Estás manteniendo un RESUMEN ROLLING de una conversación larga de venta de Nuez de la India.
Ya tenés un resumen previo del inicio de la conversación. Ahora te paso los MENSAJES NUEVOS
que ocurrieron después. Tu tarea es producir UN NUEVO RESUMEN ACTUALIZADO (máximo 4 oraciones)
que combine el resumen previo con lo que pasó en los mensajes nuevos, capturando:
1. Qué productos le interesan al cliente.
2. Datos personales ya proporcionados (nombre, dirección, dudas).
3. En qué estado quedó la negociación (¿está dudando? ¿ya compró? ¿espera envío?).
4. Cualquier objeción ya respondida para no repetirnos.

RESUMEN PREVIO:
${previousSummary}

MENSAJES NUEVOS:
${conversationText}

RESUMEN ACTUALIZADO:
`
            : `
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
                    max_tokens: 250
                }),
                cacheKey,
                undefined,
                sellerId
            );
            return result.choices[0].message?.content || "";
        } catch (e: any) {
            logger.error("🔴 [AI] Summary Error:", e.message);
            return null;
        }
    }

    /**
     * Generate Report (for analyze_day.js)
     */
    async generateReport(prompt: string): Promise<string> {
        const cacheKey = `report_${prompt.substring(0, 100)} `;
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
                cacheKey, // Clave de caché
                60 * 60 // 1 hora de caché TTL para reportes diarios
            );
            return result.choices[0].message?.content || "";
        } catch (e: any) {
            logger.error("🔴 [AI] Report Error:", e.message);
            throw e;
        }
    }

    /**
     * Parse Address from Text
     */
    async parseAddress(text: string, sellerId?: string): Promise<AIParsedResponse> {
        const prompt = `
        Analizá el siguiente texto y extraé datos de dirección postal de Argentina.
        El texto puede estar incompleto, ser solo un código postal, una provincia, o una dirección desordenada.
        
        TEXTO DEL USUARIO: "${text}"

        DETALLES DE EXTRACCIÓN(Si no está, devolver null):
- nombre: Nombre COMPLETO de persona, SIEMPRE incluir apellido si lo dice(ej: "Laura Aguirre", "Marta Pastor").NUNCA omitas el apellido.
        - calle: Calle y altura(ej: "Av. Santa Fe 1234", "Barrio 140 viv casa 16").
        - ciudad: Localidad o ciudad(ej: "Valle Viejo", "El Bañado", "Gualeguay").
        - provincia: Provincia de Argentina(ej: "Catamarca", "Córdoba", "Entre Ríos").
        - cp: Código postal numérico(ej: "4707", "5000").
        
        FECHA ACTUAL DE LA CONSULTA: ${new Date().toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
- postdatado: SOLO si el cliente EXPLÍCITAMENTE pide enviar o recibir el pedido en una fecha futura (ej: "mandamelo el 10", "cobro a principio de mes", "para el jueves que me depositan el sueldo").
CRÍTICO: Usá la "Fecha Actual" provista arriba para calcular el día exacto y retorná la fecha en formato "dd/MM" (ej: "10/05", "15/12"). Si es "a principio de mes", asume el día 05 del mes siguiente. Si el texto es solo datos de dirección/nombre, SIEMPRE devolver null. NO inventes si no lo pidieron.
        
        REGLAS Y CONTEXTO GEOGRÁFICO:
1. Tu prioridad es extraer CUALQUIER dato útil, aunque falten otros.
        2. "Gualeguay" y "Gualeguaychú" pertenecen a la provincia de Entre Ríos, NO a Santa Fe.
        3. Barrios como "Barrio 60 viviendas" o "mz F casa 4" van en "calle".
        4. CRÍTICO: Separa correctamente el NOMBRE DE PERSONA del NOMBRE DE LA CALLE. 
           Si te dicen "marta pastor bengas 77", "marta pastor" es el nombre y "bengas 77" es la calle.No pongas apellidos como parte de la calle ni calles como parte del apellido.EXTRAE SIEMPRE el nombre Y apellido completo de la persona.
        5. Si el usuario envía SOLO SU NOMBRE(ej: "Juan", "Pedro Pablo"), extraelo como "nombre", y devuelve los demás como null.
        6. Si el texto dice claramente de qué provincia es, respetalo aunque no coincida con el código postal.
        7. Las Avenidas o calles a veces están abreviadas(ej: "av belgrano 45D").
        8. Si el usuario da una dirección sumamente vaga que un correo rechazaría(ej: "cerca del kiosco", "al lado de la plaza", "frente al tacho"), IGNORA esa calle cruzada y devuelve calle: null.
        9. Si el usuario da datos geográficamente imposibles o contradictorios(ej: calle en Mendoza pero dice estar en Rosario, Santa Fe), devuelve provincia: "CONFLICT".
        10. CRÍTICO — FORMATO LISTA: si el texto viene en líneas separadas (respondiendo a un formulario tipo "Calle:\\nNúmero:\\nLocalidad:\\nCP:"), uní las líneas adyacentes que correspondan al mismo campo. En particular: si una línea contiene SOLO un nombre de calle SIN altura, y la línea SIGUIENTE contiene SOLO un número (1-5 dígitos sin texto adicional), interpretá ambas como una sola dirección "<calle> <número>". Ejemplo: "Alumine\\n1101\\nNeuquen\\n8300" → calle: "Alumine 1101", ciudad: "Neuquen", cp: "8300". NUNCA dejes la calle sin altura si la altura aparece en la línea siguiente.
        11. AMBIGÜEDAD CALLE vs LOCALIDAD: si el nombre de la "calle" coincide con el nombre de una localidad argentina conocida (ej: "Aluminé", "Tigre", "Pilar", "Salta") PERO el usuario también dio una ciudad/localidad distinta en otra línea, asumí que ese nombre es CALLE de la ciudad indicada (no localidad). Solo tratá ese nombre como localidad si NO hay otra ciudad explícita en el texto.
        `;
        try {
            // Parser de dirección — usamos GPT-4o full porque mini falla con
            // direcciones desordenadas tipo "San Martín 865, Comte. Luis Piedra
            // Buena, Sta. Cruz, CP 9303" (caso real may-2026). Los 6 pause-by-
            // parser-fail vistos en producción venían todos de mini.
            const result: any = await this._callQueued(
                () => this.client.chat.completions.create({
                    model: MODEL_PREMIUM,
                    messages: [
                        { role: "system", content: "Sos un parser de datos de envío experto en geografía argentina." },
                        { role: "user", content: prompt }
                    ],
                    tools: [{
                        type: "function",
                        function: {
                            name: "extract_address",
                            description: "Extrae los datos de direccion y nombre de la persona",
                            parameters: {
                                type: "object",
                                properties: {
                                    nombre: { type: "string", description: "Nombre y apellido de la persona, o null si no se proporcionó" },
                                    calle: { type: "string", description: "Calle, altura, vivienda, manzana, o null si no se proporcionó" },
                                    ciudad: { type: "string", description: "Ciudad o localidad, o null si no se proporcionó" },
                                    provincia: { type: "string", description: "Provincia argentina, o null si no se proporcionó" },
                                    cp: { type: "string", description: "Codigo postal, o null si no se proporcionó" },
                                    postdatado: { type: "string", description: "Fecha de postergacion futura, o null si no se proporcionó" }
                                }
                            }
                        }
                    }],
                    tool_choice: { type: "function", function: { name: "extract_address" } },
                    temperature: 0,
                    max_tokens: 200
                }),
                `addr_${crypto.createHash('sha256').update(text).digest('hex').substring(0, 24)}`, // Hashed cache key for full text deduplication
                5 * 60, // 5 MINUTOS DE TTL para extracciones
                sellerId
            );

            const toolCalls = result.choices[0].message?.tool_calls;
            if (toolCalls && toolCalls.length > 0) {
                const args = JSON.parse(toolCalls[0].function.arguments);
                return {
                    nombre: args.nombre || null,
                    calle: args.calle || null,
                    ciudad: args.ciudad || null,
                    provincia: args.provincia || null,
                    cp: args.cp || null,
                    postdatado: args.postdatado || null
                };
            }
            return { _error: true };
        } catch (e: any) {
            logger.error("🔴 [AI] parseAddress Error:", e.message);
            // OpenAI caído (429/outage): probamos Claude antes de rendirnos. Sin esto,
            // el rescate de datos del manual-complete queda ciego justo cuando más se
            // lo necesita (caso Pablo Martinez 23-jul: 429 x3 → modal vacío).
            const viaClaude = await this._claudeParseAddress(prompt);
            if (viaClaude) return viaClaude;
            return { _error: true };
        }
    }

    /**
     * Fallback de parseAddress sobre Claude (Anthropic Messages API + tool use).
     * Llamada directa SIN _callQueued a propósito: el circuit breaker es por
     * seller, no por proveedor, y cuando corre este fallback ya está abierto por
     * los fallos de OpenAI — pasar por la cola lo haría fallar en seco.
     */
    async _claudeParseAddress(prompt: string): Promise<AIParsedResponse | null> {
        if (!this.anthropic) return null;
        try {
            const result: any = await this.anthropic.messages.create({
                model: CLAUDE_MODEL_PREMIUM,
                max_tokens: 300,
                temperature: 0,
                system: "Sos un parser de datos de envío experto en geografía argentina. Extraé cada valor TAL CUAL lo escribió el cliente: no reformatees, no agregues puntuación ni abreviaturas, no recortes palabras (ej: 'av belgrano 45D' queda 'av belgrano 45D', no 'Av. Belgrano 45D'; 'cordoba capital' queda 'cordoba capital', no 'Córdoba').",
                messages: [{ role: "user", content: prompt }],
                tools: [{
                    name: "extract_address",
                    description: "Extrae los datos de direccion y nombre de la persona",
                    input_schema: {
                        type: "object",
                        properties: {
                            nombre: { type: "string", description: "Nombre y apellido de la persona, o null si no se proporcionó" },
                            calle: { type: "string", description: "Calle, altura, vivienda, manzana, o null si no se proporcionó" },
                            ciudad: { type: "string", description: "Ciudad o localidad, o null si no se proporcionó" },
                            provincia: { type: "string", description: "Provincia argentina, o null si no se proporcionó" },
                            cp: { type: "string", description: "Codigo postal, o null si no se proporcionó" },
                            postdatado: { type: "string", description: "Fecha de postergacion futura, o null si no se proporcionó" }
                        }
                    }
                }],
                tool_choice: { type: "tool", name: "extract_address" }
            });
            const toolUse = (result?.content || []).find((c: any) => c.type === 'tool_use');
            if (!toolUse?.input) return null;
            // El schema declara strings, así que Claude puede emitir el literal "null".
            const norm = (v: any) => (!v || v === 'null') ? null : v;
            const args = toolUse.input;
            logger.info("🟢 [AI] parseAddress rescatado vía Claude");
            return {
                nombre: norm(args.nombre),
                calle: norm(args.calle),
                ciudad: norm(args.ciudad),
                provincia: norm(args.provincia),
                cp: norm(args.cp),
                postdatado: norm(args.postdatado)
            };
        } catch (e: any) {
            logger.error("🔴 [AI] parseAddress fallback Claude también falló:", e.message);
            return null;
        }
    }

    /**
     * Transcribe Audio — Uses OpenAI Whisper API
     */
    async transcribeAudio(mediaData: string, mimeType: string, sellerId?: string): Promise<string | null> {
        const buffer = Buffer.from(mediaData, 'base64');
        const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
        const tmpPath = path.join(os.tmpdir(), `herbalis_audio_${Date.now()}.${ext}`);

        try {
            await fs.promises.writeFile(tmpPath, buffer);

            const result = await this._callQueued(
                () => this.client.audio.transcriptions.create({
                    model: "whisper-1",
                    file: fs.createReadStream(tmpPath),
                    language: "es"
                }),
                null,
                undefined,
                sellerId
            );

            return result.text || null;
        } catch (e: any) {
            logger.error("🔴 [AI] Transcribe Error:", e.message);
            return null;
        } finally {
            try { await fs.promises.unlink(tmpPath); } catch (e) { /* ignore */ }
        }
    }

    /**
     * Analyze Image — Uses OpenAI Vision to extract text or describe an image
     */
    async analyzeImage(mediaData: string, mimeType: string, prompt: string, sellerId?: string): Promise<string | null> {
        try {
            const result = await this._callQueued(
                () => this.client.chat.completions.create({
                    model: "gpt-4o-mini", // Vision is supported in gpt-4o-mini
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: `data:${mimeType};base64,${mediaData}`,
                                        detail: "low"
                                    }
                                }
                            ]
                        }
                    ],
                    max_tokens: 300
                }),
                null,
                undefined,
                sellerId
            );
            return result.choices[0].message?.content?.trim() || null;
        } catch (e: any) {
            logger.error("🔴 [AI] Vision Error:", e.message);
            return null;
        }
    }

    /**
     * Helper for Admin Suggestions ("Yo me encargo")
     */
    async generateSuggestion(instruction: string, conversationContext: string, sellerId?: string): Promise<string> {
        const prompt = `
SITUACION: El ADMINISTRADOR del negocio te da una instrucción DIRECTA para enviarle al cliente.
        La instrucción del admin tiene AUTORIDAD TOTAL — ANULÁ cualquier regla tuya que la contradiga.
        Si el admin dice "confirmá el cambio", "aceptá", "dale", VOS HACÉS LO QUE DICE.
        NO digas "no puedo cambiar el pedido" ni "no puedo hacer eso".El admin PUEDE y VOS OBEDECÉS.

        INSTRUCCIÓN DEL ADMIN: "${instruction}"
        CONTEXTO DEL CHAT CON EL CLIENTE: "${conversationContext}"

        Generá la respuesta exacta para enviar al cliente, redactada profesionalmente como el bot.
        Si el admin quiere confirmar un cambio, aceptar algo, o modificar un pedido, HACELO.
        Respondé en tono amable y profesional directo al cliente.
        NO devuelvas JSON — solo el texto del mensaje.
        `;
        try {
            const result = await this._callQueued(
                () => this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: "Sos un asistente de ventas de Herbalis que OBEDECE las instrucciones del administrador. El admin tiene autoridad total. Respondé al cliente en tono amable y argentino." },
                        { role: "user", content: prompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 300
                }),
                null,
                undefined,
                sellerId
            );
            return result.choices[0].message?.content || instruction;
        } catch (e: any) {
            return instruction; // Fallback to raw instruction
        }
    }

    /**
     * Get queue/cache stats for monitoring
     */
    getStats() {
        return {
            ...this.stats,
            cacheSize: this.cache.keys().length
        };
    }

    /**
     * Costo (USD) acumulado desde la última vez que se llamó a este método.
     * Lo usa el guardián de presupuesto del scheduler para acumular el gasto
     * mensual en disco de forma incremental, sobreviviendo a los restarts
     * (estimatedCostUSD es per-proceso y se resetea al reiniciar). En un
     * restart se pierde, como mucho, el delta del último intervalo (~30 min).
     */
    getCostDeltaUSD(): number {
        const total = this.stats.estimatedCostUSD || 0;
        const delta = total - this._costFlushedUSD;
        this._costFlushedUSD = total;
        return delta > 0 ? delta : 0;
    }

}

// Singleton Instance
const aiService = new AIService();
export { aiService };

// Exportados para tests y para scripts/ai-cache-probe.ts. El runtime no los usa desde afuera.
export { _buildSystemBlocks, _buildSystemPrompt, CLAUDE_CACHE_CONTROL, CLAUDE_DIALOG_TOOL };
