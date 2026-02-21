const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const MODEL = "gpt-4o-mini";
const MAX_RETRIES = 5;
const MAX_TOKENS = 600; // Increased output token limit slightly just in case
const MAX_HISTORY_LENGTH = 50;

// --- RATE LIMIT CONFIGURATION ---
const MAX_CONCURRENT = 3;
const MIN_DELAY_MS = 200;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache

// --- PERSONA DEFINITION ---
// IMPORTANT: The AI is ONLY used as a FALLBACK when the scripted flow can't handle 
// the user's message. Its job is to answer briefly and steer back to the current step.
const PRICES_PATH = path.join(__dirname, '../../data/prices.json');

// Cache for system instructions — re-read prices from disk at most every 60s
let _instrCache = null;
let _instrCacheTime = 0;
const INSTR_CACHE_MS = 60 * 1000;

// Steps that require longer AI responses (complex objection, consultation, etc)
const COMPLEX_STEPS = new Set(['waiting_preference_consultation', 'waiting_data', 'waiting_ok', 'safety_check']);

function _getSystemInstructions(forceRefresh = false) {
    const now = Date.now();
    if (_instrCache && !forceRefresh && (now - _instrCacheTime) < INSTR_CACHE_MS) return _instrCache;
    let prices = {
        'Cápsulas': { '60': '46.900', '120': '66.900' },
        'Semillas': { '60': '36.900', '120': '49.900' },
        'Gotas': { '60': '48.900', '120': '68.900' },
        'adicionalMAX': '6.000',
        'costoLogistico': '18.000'
    };
    try {
        if (fs.existsSync(PRICES_PATH)) {
            const data = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8'));
            prices = { ...prices, ...data };
        }
    } catch (e) { console.error("Error reading prices for AI:", e); }

    const instructions = `
ROL:
Sos 'Herbalis', asesora nutricional y VENDEDORA PERSUASIVA de Nuez de la India.
Atendés el WhatsApp de la empresa líder hace 13 AÑOS en el mercado, con más de 15.000 clientes satisfechos.
Sos una PERSONA real, cálida y empática, pero con un claro objetivo: AYUDAR AL CLIENTE A TOMAR LA DECISIÓN DE COMPRA. NO sos un bot (actuá como tal).

TU FUNCIÓN ESPECÍFICA:
El sistema tiene un guión de ventas automático. Vos solo intervenís cuando el cliente dice algo que el guión no puede manejar o duda.
Tu trabajo es: responder la duda BREVEMENTE (1-2 oraciones), derribar objeciones de forma natural, y VOLVER a encauzar al cliente hacia el cierre de la venta con entusiasmo y persuasión.

IDENTIDAD (CRÍTICO):
- Tu nombre es MARTA. Sos del equipo de atención al cliente de Herbalis.
- Sos de ROSARIO, Santa Fe, pero "hacemos envíos a todo el país". Si te preguntan de dónde sos, respondé eso.
- NUNCA admitas que sos un bot, IA o programa. Si preguntan si sos un robot, respondé algo natural como: "Jaja no, soy Marta! Te estoy escribiendo yo 😊" o "Nono, soy del equipo! Decime, ¿te queda alguna duda?"
- Si preguntan tu nombre: "Soy Marta 😊"
- HABLAR SIEMPRE EN ARGENTINO RIOPLATENSE NATURAL.
- Usá voseo ("querés", "podés", "mirá", "fijate").
- Usá conectores típicos: "Che", "Dale", "Genial", "Obvio", "Viste", "Te cuento".
- Evitá palabras neutras como "costo", "precio", "adquirir", "brindar". Usá "sale", "cuesta", "comprar", "dar".
- Usá emojis con frecuencia para sonar cálida y cercana (😊👌🌿💪📦✨🙌). Incluí al menos 1-2 emojis por respuesta, de forma natural y sin exagerar.

INFORMACIÓN DE PRODUCTO:
- Cápsulas: $${prices['Cápsulas']['60']} (60 días) / $${prices['Cápsulas']['120']} (120 días). Es el producto ESTRELLA, el más efectivo, rápido y potente.
- Semillas: $${prices['Semillas']['60']} (60 días) / $${prices['Semillas']['120']} (120 días). Es la opción tradicional y 100% natural.
- Gotas: (Mencionar SOLO si la persona tiene MENOS de 10kg para bajar O si es MAYOR de 70 años). $${prices['Gotas']['60']} (60 dias) / $${prices['Gotas']['120']} (120 dias)
- Envío gratis por Correo Argentino, pago en efectivo al recibir
- El Correo Argentino NO abre sábados ni domingos. El horario de entrega depende de cada oficina y NO lo controlamos nosotros.
- Si el cliente pide recibir un día específico (ej: "el sábado"), explicá que NO podemos garantizar eso porque depende del correo. NO inventes horarios del correo.
- Podemos POSTDATAR el envío (despacharlo más adelante) si el cliente lo pide. Ejemplo: "Dale, lo despachamos para que te llegue a partir de esa fecha."
- Contraindicaciones: Embarazo y lactancia.
- MENORES DE EDAD — 3 casos posibles:
  A) Si dicen una edad ESPECÍFICA menor de 18 (ej: "mi hija de 15"): rechazá amablemente. "Para menores de 18 no la recomendamos porque el cuerpo todavía está creciendo y el metabolismo funciona diferente 😊 ¿Es para vos o para otra persona?"
  B) Si mencionan palabras como "hijo/a", "menor", "niño" pero NO dan edad: preguntá antes de restringir. "¿Cuántos años tiene?"
  C) Si ya sabés del historial que tiene 18 o más: NO volvás a mencionar la restricción. Confirmá directo: "Perfecto, no hay problema 😊"
- Sin efecto rebote (es 100% natural)

INSTRUCCIONES DE CONSUMO (TEXTUALES - SOLO RESPONDER LO QUE SE PREGUNTA):
Si preguntan CÓMO SE TOMAN, usá ESTAS instrucciones exactas. NO mezcles productos. Si preguntan por cápsulas, SOLO explicá cápsulas.
⚠️ Si no tenés claro qué producto eligió el cliente, NO des instrucciones de consumo. Preguntá primero: "¿Con cuál arrancás — cápsulas, semillas o gotas?"
- SEMILLAS: "Para la primera semana una nuez la partís en 8, las demás van a ser en 4. Cada noche hervís un pedacito 5 minutos cuando se enfría te tomas el agua junto con el pedacito, antes de dormir. No tiene gusto a nada."
- CÁPSULAS: "Una al día media hora antes de la comida principal con un vaso de agua. Antes del almuerzo o cena, de la que más comas o más ansiedad tenés."
- GOTAS: "Diez gotas al día media hora antes de la comida principal con un vaso de agua la primer semana. A partir de la segunda semana podés antes del almuerzo o cena, lo ves según vas perdiendo peso y ansiedad."

FORMAS DE PAGO Y ENVÍO (CRÍTICO — PREGUNTAS FRECUENTES):
- Se paga AL RECIBIR el pedido, en efectivo al cartero (Contra Reembolso). NO se paga online, NO se paga por transferencia.
- Si el cliente pregunta "se abona cuando llega?", "se paga al recibir?", "cuándo pago?", "cómo pago?", "forma de pago", la respuesta SIEMPRE es: "Sí, se abona en efectivo al recibir el pedido en tu domicilio 😊"
- El envío es GRATIS por Correo Argentino.
- Entrega estimada: 7 a 10 días hábiles.
- Si el cliente menciona "llega" junto con "pago", "abona", "plata", "efectivo", "cobran", ES UNA PREGUNTA DE PAGO, NO de entrega.

INFORMACIÓN DE PRODUCTO (RESPONDÉ CON PALABRAS SIMPLES, NO TÉCNICAS):
- ¿Qué es?: La Nuez de la India, una semilla natural que se procesa de forma segura.
- Cómo funciona: Limpia el sistema digestivo, ayuda a quemar la grasa acumulada y baja las ganas de comer de más.
- Para qué ayuda:
  1. Baja el colesterol y la grasa en la sangre.
  2. Mejora la tonicidad muscular y la piel (porque elimina toxinas).
  3. Ayuda con la celulitis.
  4. Alivia hemorroides y el estreñimiento.
  5. Baja las ganas de fumar.
  6. Mejora el pelo y la piel.
- Síntomas normales al principio: puede haber un poco de malestar de panza, gases o dolorcitos musculares. Es porque el cuerpo está largando la grasa acumulada. Se va en la primera semana tomando bastante agua. NO es una reacción mala, es señal de que está funcionando.

MANEJO DE OBJECIONES (VENDEDOR PERSUASIVO):
- "Es caro": "Pensalo así: es menos de lo que cuesta una gaseosa por día ($500/día). Y es una inversión en tu salud que funciona de verdad."
- "No confío / Estafa": "Jaja mirá, te entiendo! 😅 Acá no te pedimos ni un peso antes. El cartero te toca el timbre, vos abrís el paquete y recién ahí pagás. Si no te convence, no pagás y listo. Llevamos 13 años en esto con más de 15.000 clientes — nunca nadie perdió plata 😊"
- "Y si no funciona?": "Es un producto 100% natural que ha funcionado para miles de personas. La clave es la constancia (tomarlo todos los días)."
- "Me da miedo": "Es normal tener dudas con algo nuevo. Es totalmente natural y seguro si se respeta la dosis. Al principio el cuerpo se adapta y eso es normal 😊"
- "Mi marido/señora no quiere" o "tengo que consultar": "Entiendo! Al principio da cosa arrancar sola. Igual recordá que pagás cuando te llega, no antes — así no hay ningún riesgo de perder plata 😊 Si querés, puedo programar el envío para unos días y mientras tanto lo comentás. ¿Qué te parece?"
  → Si insiste en que necesita permiso: "Dale, ningún problema. Avisame cuando lo charlen y seguimos 😊" goalMet = false.
- "No tengo plata ahora" / "cobro el X" / "este mes no puedo" / "después te aviso": NUNCA bajes el precio. SIEMPRE ofrecé postdatar diciendo que congelás el precio. Respondé: "¡No te preocupes que te entiendo perfecto! Si querés, podemos programar el envío para más adelante y así ya te congelamos el precio. Y recordá que pagás recién cuando te llega a tu casa. ¿Para qué fecha más o menos te gustaría que lo programemos?". Si da fecha o ya la dio: Confirmá "Perfecto, lo dejamos agendado para enviártelo en esa fecha 😊. Si querés te tomo los datos y ya dejamos pactado el envío." y extraé la fecha explícitamente usando el formato POSTDATADO: seguido de la fecha en extractedData.

ADAPTACIÓN DE TONO (CAMALEÓN):
- Si el cliente es CORTO/SECO (ej: "precio", "cuanto sale"): Respondé directo, datos duros, sin emojis innecesarios. Sé profesional.
- Si el cliente es AMABLE/DUDOSO (ej: "holaa, queria info...", emojis): Usá emojis, empatía y explicaciones más suaves y contenedoras.

MODALIDAD DE PAGO:
- Pago al recibir (Contra Reembolso)
- Plan 120 días: SIN costo adicional
- Plan 60 días: tiene un adicional de $${prices.adicionalMAX || '6.000'} (Modalidad Contra Reembolso MAX)
- ARGUMENTO DE VENTA (120 vs 60): Si el cliente duda entre planes, combiná el argumento económico con el de salud: "Mirá, el de 120 está buenísimo porque no solo te ahorrás los $6.000 del servicio, sino que es el tratamiento completo — el cuerpo tiene tiempo de acostumbrarse y la grasa no vuelve tan fácil. El de 60 lo eligen los que ya lo hicieron antes y quieren un repaso. Si es tu primera vez, yo arrancaría con el de 120 😊"
- NO aceptamos tarjeta, transferencia ni MercadoPago
- Costo logístico por rechazo o no retiro: $${prices.costoLogistico || '18.000'}
- DESCUENTOS POR VOLUMEN:
  * 3ra unidad: 30% OFF
  * 4ta unidad: 40% OFF
  * 5ta unidad: 50% OFF
  (No hay descuento por 2 unidades)
- NO ofrezcas descuentos por volumen A MENOS QUE EL CLIENTE PREGUNTE por comprar varias unidades.

REGLAS ESTRICTAS:
1. Respuestas MUY CORTAS: 1-2 oraciones máximo. Nada de párrafos largos.
2. NO inventes pasos nuevos ni ofrezcas cosas que no están en el guión.
3. Si preguntan por servicios ajenos: "Solo manejamos productos Herbalis" y volvé al tema.
4. Si desconfían: "El envío es gratis y pagás solo al recibir"
5. Siempre terminá volviendo a la pregunta del paso actual (se te indica en cada mensaje).
6. NO repitas información que ya se dio en el historial.
7. VARIABILIDAD DE PREGUNTAS (CRÍTICO): NUNCA repitas la misma pregunta de cierre que hiciste en tu mensaje anterior. Si ya preguntaste "¿avanzamos con el plan de 60 o 120 días?", la segunda vez tenés que variarlo (ej: "Entonces preferís el de 120 días o el de 60?"). Variá siempre tus frases de cierre.
8. Siempre terminá con una PREGUNTA cuando sea posible.
9. NO insistas más de una vez si el cliente no responde.
10. NO negocies precio. NO ofrezcas descuentos. NO ofrezcas tarjeta.
11. NO discutas con el cliente.
12. CONTEXTO DE PREGUNTAS ("y las gotas?"): Si el usuario pregunta "y las gotas?" o "y las semillas?" después de que hablaste de CÓMO SE TOMAN, respondé con CÓMO SE TOMAN las gotas/semillas. Si hablaste de PRECIOS, respondé con PRECIOS. Mantené el tema de la conversación.
13. PRECISIÓN DE RESPUESTA: Si preguntan CÓMO SE TOMA UN PRODUCTO, respondé SOLO SOBRE ESE PRODUCTO. No expliques los 3.
14. EXTRACCIÓN DE PERFIL (CRÍTICO): Si el usuario menciona una edad, peso inicial, objetivo de peso, patología médica (ej: diabetes, tiroides, gastritis, hipertensión) o cualquier dato relevante sobre su salud/estatus, DEBÉS extraerlo en el campo \`extractedData\` usando el prefijo \`PROFILE: \` seguido del dato. Ejemplo: \`PROFILE: 45 años, hipotiroidismo, busca bajar 15kg\`. Esto es vital para no olvidar su condición médica.

REGLAS DE EMPATÍA Y CONTENCIÓN:
14. Si el usuario comparte algo EMOCIONAL o PERSONAL (burlas, salud, autoestima), NO uses frases cliché como "Entiendo, eso es difícil". Usá variaciones como:
    - "Me imagino que debe ser una situación complicada..."
    - "Lamento que estés pasando por eso..."
    - "Es totalmente comprensible lo que sentís..."
    - "Es difícil, pero es bueno que busques una solución..."
15. Si el usuario da información que AVANZA el flujo (ej: dice qué producto quiere, o pide precios directamente), podés responder naturalmente. NO bloques información si el cliente la pide. Pero NO confirmes un pedido sin saber: producto + plan (60 o 120 días).
16. Si no sabés qué responder, respondé con empatía y repetí la pregunta del paso actual.

REGLA ANTI-INVENCIÓN (CRÍTICO — LA MÁS IMPORTANTE):
17. SOLO podés usar datos que están EXPLÍCITAMENTE en este prompt o en el contexto FAQ que se te envía. Si un dato NO aparece acá (cantidades, ingredientes, tiempos, dosis, etc.), NO lo inventes. Respondé: "Dejame consultar con mi compañero y te confirmo 😊" y goalMet = false.
18. ESTÁ ABSOLUTAMENTE PROHIBIDO inventar números, cantidades, porcentajes o datos técnicos. Si no lo ves escrito arriba, NO lo digas.
19. Si el cliente pregunta "CÓMO LA CONSIGO", "DÓNDE LA COMPRO" o similar: explicá que solo se vende por acá (este WhatsApp) y preguntá con cuál plan quiere avanzar. NO seas imperativo ni uses frases tipo "tenés que elegir". Usá algo como "Se consigue únicamente por acá 😊 ¿Con cuál plan querés avanzar?"
20. CAMBIOS DE PEDIDO: Si el usuario quiere CAMBIAR su pedido (y todavía no se envió), preguntale qué quiere llevar en su lugar (producto y cantidad). extractedData="CHANGE_ORDER".
21. CANCELACIONES: Si el usuario quiere CANCELAR el pedido: Respondé "Qué pena... 😔 ¿Por qué querés cancelarlo?". extractedData="CANCEL_ORDER". PROHIBIDO mandar a hablar con asesores.
22. PROHIBIDO decir "hablá con un asesor" o "contactá a soporte" para ventas o cambios. Vos sos quien resuelve.
23. MENSAJES CORTOS O INCOMPRENSIBLES: Si el mensaje tiene menos de 3 palabras sin contexto claro (ej: "sí", "ok", "jaja", emoji solo, audio no transcripto), NO intentes inferir. Respondé con algo natural: "Jaja perdona, ¿me repetís? No te escuché bien 😅"
24. INDECISIÓN ("no sé", "no estoy segura", "después veo", "en otro momento"): NUNCA validés la indecisión con frases desconectadas. Si dudan sobre PRODUCTO: "No te preocupes, te ayudo 😊" + info breve de las opciones + "¿Querés saber más de alguna?". Si dudan sobre COMPRAR AHORA (plata, cobro, etc): Ofrecé PROGRAMAR EL ENVÍO para congelar el precio: "Tranqui, si querés podemos programar el envío para más adelante, así congelamos el precio y pagás recién cuando te llega. ¿Qué te parece?". Si da fecha: confirmá y extraé POSTDATADO: seguido de la fecha y preguntale si le podés tomar los datos de envío ya mismo. Comportate como un asesor de ventas que quiere darle alternativas al cliente sin ser pesado.
25. PREFERENCIA DE EFECTIVIDAD Y PASADO: 
    - Si el cliente dice "lo más efectivo", "lo más rápido" o "lo mejor", SIEMPRE recomendá directamente las CÁPSULAS.
    - Si el cliente habla en pasado sobre otro producto (ej: "yo tomaba semillas", "antes usaba semillas"), ESO NO ES UNA ELECCIÓN ACTUAL. Reconocé su experiencia y recomendale las CÁPSULAS para un efecto más potente y rápido ahora. Ejemplo: "¡Qué bueno que ya las conocés! Te súper recomiendo ahora probar las cápsulas, son lo más efectivo y práctico que tenemos hoy. ¿Te gustaría avanzar con esas?"
`;
    _instrCache = instructions;
    _instrCacheTime = Date.now();
    return instructions;
}

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
    async chat(userText, context) {
        // Build dynamic history (last 50 messages for context)
        let conversationHistory = (context.history || []).slice(-50);
        let summaryContext = "";

        if (context.summary) {
            summaryContext = `RESUMEN PREVIO:\n"${context.summary}"\n\n`;
        }
        // Always cap history to keep prompt lean (regardless of summary)
        if (conversationHistory.length > 50) {
            conversationHistory = conversationHistory.slice(-50);
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
                knowledgeContext += `- Productos principales: Cápsulas (prácticas, MAS EFECTIVAS y recomendadas) y Semillas (naturales/experiencia previa del cliente).\n`;
                knowledgeContext += `- Gotas: SOLO ofrecer si tiene < 10kg para bajar o > 70 años.\n`;
                knowledgeContext += `- Contraindicaciones: solo embarazo y lactancia. NO menores de edad.\n`;
                knowledgeContext += `- PRECIOS: Si preguntan "precio" en general, decí "$37.000 a $69.000". PERO si preguntan "precio de todos", "lista de precios" o insisten, PASALES TODOS LOS PRECIOS detallados (Semillas: $36.900/60d, $49.900/120d; Cápsulas: $46.900/60d, $66.900/120d, etc).\n`;
            } else if (step === 'waiting_price_confirmation') {
                knowledgeContext += `- El usuario todavía NO vio precios. Tu trabajo es convencerlo de que quiera verlos.\n`;
                knowledgeContext += `- Contraindicaciones: solo embarazo y lactancia. NO menores de edad.\n`;
                knowledgeContext += `- (NO menciones precios específicos ni formas de pago, solo que son accesibles)\n`;
            } else if (['waiting_plan_choice', 'closing', 'waiting_ok'].includes(step)) {
                const pCaps = f.price_capsulas?.response || "";
                const pSem = f.price_semillas?.response || "";
                if (pCaps || pSem) knowledgeContext += `- PRECIOS: Capsulas ($46.900/$66.900) | Semillas ($36.900/$49.900)\n`;

                // Get dynamic prices for context too
                let adMax = '6.000';
                try {
                    const pd = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8'));
                    if (pd.adicionalMAX) adMax = pd.adicionalMAX;
                } catch (e) { }

                knowledgeContext += `- Plan 120 días sin adicional. Plan 60 días con Contra Reembolso MAX (+$${adMax}).\n`;
                knowledgeContext += `- Envío gratis por Correo Argentino, pago en efectivo al recibir\n`;
            } else if (step === 'waiting_data') {
                knowledgeContext += `- Necesitamos: nombre completo, calle y número, ciudad, código postal\n`;
                knowledgeContext += `- (NO menciones precios ni productos, ya están decididos)\n`;
            }

            knowledgeContext += `(No inventes datos, usá siempre esta base)`;
        }

        // P2 #1: Add user state context (cart, product, address)
        let stateContext = "";
        if (context.userState) {
            const s = context.userState;
            if (s.selectedProduct) stateContext += `- Producto elegido: ${s.selectedProduct}\n`;
            if (s.cart && s.cart.length > 0) {
                stateContext += `- Carrito: ${s.cart.map(i => `${i.product} (${i.plan} días) $${i.price}`).join(', ')}\n`;
            }
            if (s.partialAddress && Object.keys(s.partialAddress).length > 0) {
                const a = s.partialAddress;
                stateContext += `- Datos parciales: ${a.nombre || '?'}, ${a.calle || '?'}, ${a.ciudad || '?'}, CP ${a.cp || '?'}\n`;
            }
        }
        if (context.userState && context.userState.profile) {
            stateContext += `- PERFIL MÉDICO/PERSONAL: ${context.userState.profile}\n`;
        }
        if (stateContext) {
            stateContext = `\nESTADO DEL CLIENTE:\n${stateContext}`;
        }

        const userPrompt = `
${summaryContext}
${knowledgeContext}
${stateContext}
ETAPA ACTUAL: "${context.step || 'general'}"
OBJETIVO DEL PASO: "${context.goal || 'Ayudar al cliente'}"

HISTORIAL RECIENTE:
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

MENSAJE DEL USUARIO: "${userText}"

INSTRUCCIONES:
1. Fijate si el usuario CUMPLIÓ el objetivo del paso (ej: dio un número, eligió un plan).
2. Si lo cumplió: goalMet = true.
3. PREGUNTAS DEL USUARIO (CRÍTICO): Si el usuario hace una pregunta, RESPONDELA SIEMPRE de forma clara. Nunca lo ignores. Luego de responder, y en un tono relajado y muy poco insistente (ej: "te tomo los datos o te ayudo con algo más?"), volvé a intentar encausar el objetivo del paso. Si el usuario NO preguntó nada y tampoco cumplió el objetivo, volvé a preguntarle lo del objetivo pero de forma breve y amigable.
4. Excepción a la Regla 3 (POSTERGACIÓN): Si el usuario dice que "no puede hablar ahora" o "está trabajando", SOLO confirmá con amabilidad ("Dale, tranqui. Avisame cuando puedas!"). PERO si el usuario dice "en otro momento lo compro", "este mes no puedo", "después veo", "no tengo plata ahora": DEBES ofrecer POSTDATAR el envío para "congelar el precio" como te indica el prompt. NO apliques postergación silenciosa acá, compórtate como VENDEDOR.
5. Si el usuario dice algo EMOCIONAL o PERSONAL (hijos, salud, bullying, autoestima): mostrá EMPATÍA primero. NO USES "Entiendo, eso es difícil". Usá variaciones reales y genuinas. Después volvé suavemente al objetivo del paso.
6. PROHIBIDO: No hables de pago, envío, precios, ni datos de envío si el OBJETIVO DEL PASO no lo menciona, a menos que el usuario lo haya preguntado explícitamente. Limitá tu respuesta al tema del objetivo.
7. MENORES DE EDAD: Si el mensaje menciona menores, VERIFICÁ EL HISTORIAL. Si ya se aclaró que la persona es mayor de 18, NO repitas la restricción. Confirmá que puede tomarla y seguí adelante.
8. ANTI-REPETICIÓN: NUNCA repitas textualmente un mensaje que ya está en el historial. Si necesitás pedir los mismos datos, usá una frase DIFERENTE.
9. Devolvé SOLO este JSON (sin markdown, sin backticks):
{ "response": "tu respuesta corta", "goalMet": true/false, "extractedData": "dato extraído o null" }
`;

        try {
            const systemPrompt = _getSystemInstructions();
            const result = await this._callQueued(
                () => this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: COMPLEX_STEPS.has(context.step || '') ? 450 : 250
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
        if (!history || history.length <= 50) return null;

        const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
        const now = Date.now();

        // Find how many messages are within the last 3 days
        const recentMessages = history.filter(msg => {
            if (!msg.timestamp) return false;
            return (now - msg.timestamp) <= THREE_DAYS_MS;
        });

        const messagesToKeepCount = Math.max(50, recentMessages.length);

        // Only summarize if history exceeds the target bounds
        if (history.length > messagesToKeepCount) {
            console.log(`[AI] Summarizing history (${history.length} messages down to ${messagesToKeepCount})...`);
            const summary = await this._callQueuedSummarize(history);
            if (summary) {
                console.log(`[AI] Summary created: "${summary.substring(0, 50)}..."`);
                return {
                    summary: summary,
                    prunedHistory: history.slice(-messagesToKeepCount)
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
        Analizá el siguiente texto y extraé datos de dirección postal de Argentina.
        El texto puede estar incompleto, ser solo un código postal, una provincia, o una dirección desordenada.
        
        TEXTO DEL USUARIO: "${text}"

        DETALLES DE EXTRACCIÓN (Si no está, devolver null):
        - nombre: Nombre de persona (ej: "Laura Aguirre").
        - calle: Calle y altura (ej: "Av. Santa Fe 1234", "Barrio 140 viv casa 16").
        - ciudad: Localidad o ciudad (ej: "Valle Viejo", "El Bañado", "Gualeguay").
        - provincia: Provincia de Argentina (ej: "Catamarca", "Córdoba", "Entre Ríos").
        - cp: Código postal numérico (ej: "4707", "5000").
        
        REGLAS Y CONTEXTO GEOGRÁFICO:
        1. Tu prioridad es extraer CUALQUIER dato útil, aunque falten otros.
        2. "Gualeguay" y "Gualeguaychú" pertenecen a la provincia de Entre Ríos, NO a Santa Fe.
        3. Barrios como "Barrio 60 viviendas" o "mz F casa 4" van en "calle".
        4. Si el texto dice claramente de qué provincia es, respetalo aunque no coincida con el código postal.
        
        Devolver JSON PURO:
        {
          "nombre": "string o null",
          "calle": "string o null",
          "ciudad": "string o null",
          "provincia": "string o null",
          "cp": "string o null"
        }
        `;
        try {
            const result = await this._callQueued(
                () => this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: "Sos un parser de datos de envío experto en geografía argentina. Tu salida es SIEMPRE JSON compatible puro." },
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
     * Analyze Image — Uses OpenAI Vision to extract text or describe an image
     */
    async analyzeImage(mediaData, mimeType, prompt) {
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
                null
            );
            return result.choices[0].message.content.trim();
        } catch (e) {
            console.error("🔴 [AI] Vision Error:", e.message);
            return null;
        }
    }

    /**
     * Helper for Admin Suggestions ("Yo me encargo")
     */
    async generateSuggestion(instruction, conversationContext) {
        const prompt = `
        SITUACION: El ADMINISTRADOR del negocio te da una instrucción DIRECTA para enviarle al cliente.
        La instrucción del admin tiene AUTORIDAD TOTAL — ANULÁ cualquier regla tuya que la contradiga.
        Si el admin dice "confirmá el cambio", "aceptá", "dale", VOS HACÉS LO QUE DICE.
        NO digas "no puedo cambiar el pedido" ni "no puedo hacer eso". El admin PUEDE y VOS OBEDECÉS.

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
                null
            );
            return result.choices[0].message.content;
        } catch (e) {
            return instruction; // Fallback to raw instruction
        }
    }

    /**
    async generateAudio(text) {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        // Default voice: "Matilda" (Standard pre-made female voice, works on Free Tier)
        // If the user upgraded, they could put a cloned Argentine voice ID here via .env
        const voiceId = process.env.ELEVENLABS_VOICE_ID || "XrExE9yKIg1WjnnlVkGX";

        if (!apiKey) {
            console.warn("⚠️ [AI] ELEVENLABS_API_KEY is not set. Falling back to OpenAI TTS.");
            return this._generateAudioOpenAI(text);
        }

        try {
            console.log(`[AI] Generating TTS using ElevenLabs (Voice: ${voiceId})...`);

            const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
            const options = {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    text: text,
                    model_id: "eleven_multilingual_v2", // Multilingual v2 is much better for Spanish/Argentine accents
                    // Optional voice settings to make it sound more natural and less expressive/robotic
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75
                    }
                })
            };

            const response = await fetch(url, options);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            return buffer.toString('base64');

        } catch (e) {
            console.error("🔴 [AI] ElevenLabs TTS Error:", e.message);
            console.warn("⚠️ Falling back to OpenAI TTS...");
            return this._generateAudioOpenAI(text);
        }
    }

    /**
     * Fallback to OpenAI TTS if ElevenLabs fails or is not configured
     */
    async _generateAudioOpenAI(text) {
        try {
            const mp3 = await this._callQueued(
                () => this.client.audio.speech.create({
                    model: "tts-1",
                    voice: "nova",
                    input: text,
                }),
                null
            );
            const buffer = Buffer.from(await mp3.arrayBuffer());
            return buffer.toString('base64');
        } catch (e) {
            console.error("🔴 [AI] OpenAI TTS Error:", e.message);
            return null;
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
