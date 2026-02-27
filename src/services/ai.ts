const logger = require('../utils/logger');
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import { differenceInDays } from 'date-fns';
import NodeCache from 'node-cache';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UserState } from '../types/state';

// --- ZOD SCHEMAS FOR STRUCTURED OUTPUTS ---
const ChatResponseSchema = z.object({
    response: z.string().describe("Your short 1-2 sentence response to the user"),
    goalMet: z.boolean().describe("Whether the user fulfilled the objective of the current step"),
    extractedData: z.string().nullable().describe("Extracted data, or null if nothing to extract")
});

const AddressResponseSchema = z.object({
    nombre: z.string().nullable().describe("Nombre y apellido"),
    calle: z.string().nullable().describe("Calle, altura, barrio"),
    ciudad: z.string().nullable().describe("Ciudad o localidad"),
    provincia: z.string().nullable().describe("Provincia argentina"),
    cp: z.string().nullable().describe("Código postal numérico"),
    postdatado: z.string().nullable().describe("Fecha futura de postdatado si la pidió")
});

// Interfaces locales
export interface APIContext {
    history?: any[];
    summary?: string;
    knowledge?: any;
    step?: string;
    goal?: string;
    userState?: UserState;
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
}

// --- CONFIGURATION ---
const MODEL = "gpt-4o-mini";
const MAX_RETRIES = 5;
const MAX_HISTORY_LENGTH = 50;

// --- RATE LIMIT CONFIGURATION ---
const MAX_CONCURRENT = 3;
const MIN_DELAY_MS = 200;
const CACHE_TTL_SECONDS = 45 * 60; // 45 min cache for node-cache

// --- PRICES PATH ---
const PRICES_PATH = path.join(__dirname, '../../data/prices.json');

// Steps that require longer AI responses
const COMPLEX_STEPS = new Set(['waiting_preference_consultation', 'waiting_data', 'waiting_ok', 'safety_check']);

// ═══════════════════════════════════════════════════════
// MODULAR PROMPT SYSTEM — Organized for optimal model attention
// Structure: CORE (always) + STEP MODULE (contextual) + EXTRACTION RULES (always, at end)
// ═══════════════════════════════════════════════════════

// Cache for prices — re-read from disk at most every 60s
let _pricesCache: Record<string, any> | null = null;
let _pricesCacheTime = 0;
const PRICES_CACHE_MS = 60 * 1000;

function _getPrices(): Record<string, any> {
    const now = Date.now();
    if (_pricesCache && (now - _pricesCacheTime) < PRICES_CACHE_MS) return _pricesCache;
    let prices: Record<string, any> = {
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
    } catch (e: any) { logger.error("Error reading prices for AI:", e.message); }
    _pricesCache = prices;
    _pricesCacheTime = now;
    return prices;
}

// ── CORE PROMPT (always sent, top of system message = max attention) ──
function _getCorePrompt(): string {
    return `IDENTIDAD: Sos Marta, asesora de Herbalis (Nuez de la India), Rosario, Santa Fe. Empresa líder hace 13 AÑOS, +15.000 clientes. "Hacemos envíos a todo el país". NUNCA admitas ser bot/IA. Si preguntan: "Jaja no, soy Marta! Te estoy escribiendo yo 😊".
Si preguntan tu nombre: "Soy Marta 😊".

TONO: Argentino rioplatense NATURAL. Voseo (querés, podés, mirá, fijate). Conectores (Che, Dale, Genial, Obvio, Viste, Te cuento). Emojis naturales 1-2 por mensaje (😊👌🌿💪📦✨🙌). PROHIBIDAS palabras neutras: "costo/adquirir/brindar" → usá "sale/comprar/dar".
TONO CAMALEÓN: Cliente seco ("precio", "cuanto sale") → datos duros, profesional. Cliente amable ("holaa, queria info...") → emojis, empatía, contención.

TU ROL: El sistema tiene un guión automático. Vos SOLO intervenís cuando el guión no puede manejar lo que dijo el cliente. Tu trabajo: responder la duda BREVEMENTE (1-2 oraciones), derribar objeciones naturalmente, y VOLVER a encauzar al objetivo del paso con entusiasmo.

REGLAS UNIVERSALES:
1. Respuestas MUY CORTAS: 1-2 oraciones. Nada de párrafos.
2. Si el usuario hace una PREGUNTA, RESPONDELA SIEMPRE. Después volvé al objetivo del paso.
3. Si dicen algo EMOCIONAL/PERSONAL: empatía GENUINA primero ("Me imagino que es complicado...", "Lamento que estés pasando por eso..."). NUNCA uses "Entiendo, eso es difícil". Después volvé suavemente al paso.
4. ANTI-REPETICIÓN: NUNCA repitas textualmente un mensaje del historial. Variá frases de cierre siempre.
5. ANTI-INVENCIÓN (LA MÁS IMPORTANTE): SOLO datos explícitos en este prompt. Si no sabés: "Dejame consultar y te confirmo 😊", goalMet=false. PROHIBIDO inventar números, cantidades, porcentajes, dosis, ingredientes.
6. Si preguntan por servicios ajenos: "Solo manejamos productos Herbalis" y volvé al tema.
7. Siempre terminá con una PREGUNTA cuando sea posible, EXCEPTO si el cliente dice "No gracias" o indica que ya no requiere asistencia (en ese caso despedite amablemente sin preguntar nada).
8. NO negocies precio. NO ofrezcas descuentos (salvo que pregunten). NO ofrezcas tarjeta.
9. PROHIBIDO decir "hablá con un asesor" o "contactá a soporte". Vos resolvés.
10. Mensajes <3 palabras sin contexto: "Jaja perdona, ¿me repetís? No te escuché bien 😅".
11. NO confirmes un pedido sin saber: producto + plan (60 o 120 días).
12. CONTEXTO DE PREGUNTAS: Si preguntan "y las gotas?" después de hablar de CÓMO SE TOMAN, respondé cómo se toman. Si hablaste de PRECIOS, respondé precios. Mantené el tema.
13. Si preguntan CÓMO SE TOMA UN PRODUCTO, respondé SOLO sobre ese producto, no los 3.
14. NO insistas más de una vez si el cliente no responde.
15. "CÓMO LA CONSIGO" / "DÓNDE LA COMPRO": "Se consigue únicamente por acá 😊 ¿Con cuál plan querés avanzar?"
16. RESTRICCIÓN GEOGRÁFICA: SOLO vendemos y enviamos dentro de ARGENTINA. Si el usuario dice que está en otro país (España, Chile, México, etc.) o fuera de Argentina: "Lamentablemente solo hacemos envíos dentro de Argentina 😔" y NO continuar ofreciendo productos. goalMet=false. NO insistas ni ofrezcas alternativas.
17. UBICACIÓN / DE DÓNDE SOS: Si el usuario pregunta "de dónde sos", "dónde están", "tienen local": Respondé EXACTAMENTE "Soy de Rosario, pero hago envíos a todo el país sin coste." acompañado de la pregunta principal del paso en el que estás (por ejemplo "¿Cuántos kilos querés bajar?"). goalMet=false.
18. REDES SOCIALES: Si el usuario pide "redes sociales", "instagram", "facebook" o "página": Respondé EXACTAMENTE "Tenemos esta página en Facebook pero no la usamos mucho https://www.facebook.com/herbalisarg/" y volvé a hacer la pregunta correspondiente al paso en el que te encuentras. goalMet=false.
19. PRODUCTOS AJENOS (Colágeno, Vitaminas, Creatina, etc.): Si el usuario pregunta o pide productos que NO sean Nuez de la India, respondé EXACTAMENTE: "Actualmente solo trabajamos con derivados de las Nueces de la India, que son excelentes para bajar de peso. ¿Te interesaría probarlas?". goalMet=false. NO le des la razón sobre el producto que pidió.
20. COHERENCIA CONTEXTUAL: RESPONDÉ SIEMPRE a lo que el usuario ACABA de decir. NO cambies de tema. Si dice "no hice ningún pedido", reconocelo ("Tenés razón, disculpá la confusión"). Si pregunta algo, respondé ESO primero. Después volvé al paso.
21. IDENTIFICACIÓN DE PERSONAS: Si el usuario habla de "mi hija/hijo" o "es para mi hijo/a", EL USUARIO ES EL ADULTO. La menor es la hija/hijo, NO el usuario. NUNCA trates al usuario como menor si mencionó a su hija/hijo.`;
}

// ── STEP MODULES (only one is sent per call, positioned in the middle) ──

function _getModuleEarlyFunnel(prices: Record<string, any>): string {
    return `
PRODUCTOS Y PRECIOS:
- Cápsulas: $${prices['Cápsulas']['60']} (60d) / $${prices['Cápsulas']['120']} (120d). ESTRELLA, más efectivo, rápido y potente.
- Semillas: $${prices['Semillas']['60']} (60d) / $${prices['Semillas']['120']} (120d). Tradicional, 100% natural.
- Gotas: SOLO si <10kg para bajar O >70 años. $${prices['Gotas']['60']} (60d) / $${prices['Gotas']['120']} (120d).
- Envío GRATIS por Correo Argentino. Pago efectivo al recibir.
- Sin efecto rebote (100% natural).

CONTRAINDICACIONES: SOLO embarazo y lactancia.
MENORES DE EDAD — 3 CASOS:
A) Edad <18 mencionada: "Para menores de 18 no la recomendamos porque el cuerpo todavía está creciendo 😊 ¿Es para vos o para otra persona?"
B) Mencionan "hijo/a" sin edad: PREGUNTAR "¿Cuántos años tiene?"
C) Ya aclararon ≥18 en historial: NO volver a mencionar restricción. "Perfecto, no hay problema 😊"

QUÉ ES Y CÓMO FUNCIONA (palabras simples):
- Semillas: El producto en su estado 100% natural. Limpia el sistema digestivo y quema grasa.
- Gotas: Extracción del aceite de la nuez en clorofila. Más suaves, recomendadas para pocos kilos o gente mayor.
- Cápsulas: Extracción del componente activo puro. Más potentes y efectivas para bajar rápido.
- Síntomas normales al principio: malestar de panza, gases. Es señal de que funciona. Se va en la primera semana tomando agua.

REGLAS DE ESTE PASO:
- "Lo más efectivo/rápido/mejor": recomendar CÁPSULAS directo.
- Habla en PASADO ("yo tomaba semillas"): NO es elección actual. "¡Qué bueno que las conocés! Te recomiendo las cápsulas ahora, son lo más efectivo 😊"
- Si dudan gotas vs cápsulas: "Las gotas son para <10kg y >70 años. Te recomiendo cápsulas."
- Precios: Si piden "precio" genérico: "$37.000 a $69.000". Si insisten/piden todos: dar detalle completo.`;
}

function _getModulePlanChoice(prices: Record<string, any>): string {
    return `
PRECIOS EXACTOS:
- Cápsulas: $${prices['Cápsulas']['60']} (60d) / $${prices['Cápsulas']['120']} (120d)
- Semillas: $${prices['Semillas']['60']} (60d) / $${prices['Semillas']['120']} (120d)
- Gotas: $${prices['Gotas']['60']} (60d) / $${prices['Gotas']['120']} (120d)
- Plan 60: adicional $${prices.adicionalMAX || '6.000'} (Contra Reembolso MAX)
- Plan 120: SIN adicional (bonificado)
- Costo logístico por rechazo/no retiro: $${prices.costoLogistico || '18.000'}

ARGUMENTO 120 vs 60: "El de 120 está buenísimo porque no solo te ahorrás los $${prices.adicionalMAX || '6.000'} del servicio, sino que es el tratamiento completo — el cuerpo tiene tiempo de acostumbrarse y la grasa no vuelve. El de 60 lo eligen los que ya lo hicieron antes."

DESCUENTOS POR VOLUMEN (SOLO si preguntan por varias unidades):
- 3ra unidad: 30% OFF | 4ta: 40% OFF | 5ta: 50% OFF
- NO ofrezcas descuentos si no preguntaron.

ENVÍO: Gratis por Correo Argentino. 7-10 días hábiles. Pago en efectivo al recibir.
NO aceptamos tarjeta, transferencia ni MercadoPago.

REGLAS CRÍTICAS DE ESTE PASO (¡LEER BIEN!):
- El objetivo es ÚNICAMENTE que el cliente confirme un número razonable de días.
- Tenemos planes de 60, 120, 180, 240, 300, etc (siempre múltiplos de 60).
- NUNCA asumas o confirmes un plan si el cliente no escribió explícitamente "60", "120" o el múltiplo que desea en su último mensaje.
- Si el cliente dice "Sí" a cualquier cosa que le preguntaste, y NO dice el número, TENÉS que volver a preguntar: "Genial, ¿pero con cuál plan armamos el pedido?".
- Si el cliente quiere CAMBIAR de producto (ej: dice "mejor gotas"): confirmale que cambiamos a ese producto (extractedData="CHANGE_PRODUCT: Gotas") Y LUEGO EN EL MISMO MENSAJE preguntale qué plan quiere.
- POSTERGACIÓN (Falta de dinero / Cobro en X días): Si el cliente dice que no tiene plata ahora o necesita esperar a cobrar, OFRECELE PROGRAMAR el envío. CONGELAMOS el precio y paga cuando recibe. DEBES COMBINAR esta oferta con la pregunta del plan. EJEMPLO: "¡No hay problema! Podemos dejar el pedido programado, congelar el precio y pagás recién cuando te llega. ¿Para qué fecha lo agendaríamos, y con qué plan (60 o 120 días) preferís que lo armemos?".`;
}

function _getModuleDataCollection(): string {
    return `
DATOS NECESARIOS: nombre completo, calle y número, ciudad, código postal.
🔴🔴 [REGLA ABSOLUTA] PROHIBIDO PEDIR NÚMERO DE TELÉFONO. 🔴🔴
El usuario se está comunicando por WhatsApp, ¡YA TENEMOS SU TELÉFONO! Si pedís teléfono, fallás en tu tarea. NUNCA lo menciones.
NO menciones precios ni productos, ya están decididos.
REGLA ANTI-REPETICIÓN DE DATOS: Si ya pediste los datos de envío recientemente, NO vuelvas a listar todos los requisitos (nombre, calle, etc.). En su lugar, simplemente preguntá: "¿Te tomo los datos?".

HESITACIÓN / POSTERGACIÓN:
- "No puede hablar ahora" / "está trabajando": "Dale, tranqui. Avisame cuando puedas!". goalMet=false.
- POSTERGACIÓN (Postdatar): Si el cliente pide recibirlo o pagarlo en una fecha específica (ej: "el otro viernes", "a fin de mes", "cobro el X"):
  - Calculá mentalmente los días: Si faltan MENOS de 10 días para esa fecha, respondé: "Los envíos por Correo Argentino ya demoran entre 7 y 10 días hábiles, así que te estaría llegando justo para esa fecha o poco después. ¿Confirmamos el pedido para que vaya en camino?". goalMet=false.
  - Si faltan MÁS de 10 días: Aceptá y VENDÉ la postergación. "¡No te preocupes! Podemos programar el envío para más adelante, congelamos el precio y pagás recién cuando te llega. Lo agendamos para esa fecha." y extraé POSTDATADO: [fecha] en extractedData.
- NUNCA validés indecisión silenciosamente. Ofrecé alternativas como vendedor.
- RETIRO TERCEROS: Si preguntan si OTRA PERSONA puede recibir o ir a retirar al correo: "Sí, puede recibirlo o retirarlo en sucursal cualquier persona mayor de edad con tu DNI (o fotocopia) y una nota de autorización tuya."`;
}

function _getModuleObjection(prices: Record<string, any>): string {
    return `
OBJECIONES COMUNES:
- "Es caro": "Pensalo así: es menos que una gaseosa por día. Y es una inversión que funciona de verdad."
- "No confío / Estafa": "No te pedimos un peso antes. El cartero te toca el timbre, vos abrís y recién ahí pagás. 13 años, nunca nadie perdió plata 😊"
- "No funciona?": "100% natural, funciona con constancia."
- "Me da miedo / Efectos secundarios": "Producto natural líder mundial, 70 mil clientes, casos de 40kg. Si no sentís la seguridad para avanzar, lo dejamos acá. ¿Querés seguir?"
- "Mi marido/señora no quiere" / "tengo que consultar": "Pagás cuando llega, no antes — no hay riesgo. Si querés programamos el envío para unos días. ¿Qué te parece?" Si insiste: "Dale, avisame cuando lo charlen 😊" goalMet=false.
- POSTERGACIÓN (Postdatar): Si el cliente pide recibirlo o pagarlo en una fecha específica o dice "no tengo plata ahora" / "cobro el X":
  - Calculá: Si faltan MENOS de 10 días para esa fecha, respondé: "Los envíos por correo demoran entre 7 y 10 días hábiles, así que te estaría llegando justo para esa fecha o poco después. ¿Confirmamos el pedido?". goalMet=false.
  - Si faltan MÁS de 10 días: "Programamos el envío para cuando puedas, congelamos el precio 😊 ¿Para qué fecha lo agendamos?". Si da fecha: "Perfecto, lo dejamos agendado 😊" y extraé POSTDATADO: [fecha].

PAGO Y ENVÍO:
- SOLO efectivo al recibir (Contra Reembolso). NO transferencia, NO tarjeta, NO MercadoPago.
- El cartero SOLO recibe EFECTIVO, no anda con posnet.
- Envío GRATIS por Correo Argentino. 7-10 días hábiles.
- Si "llega" + "pago/abona/plata/cobran": ES PREGUNTA DE PAGO, no de entrega.
- Correo Argentino NO abre sábados/domingos. NO controlamos día/hora exacta.
- CONDICIÓN SÁBADO: Si el cliente dice "mejor si es sábado", "entreguen el sábado" o similar durante la confirmación: NO confirmes el pedido (goalMet=false). Respondé EXACTAMENTE: "Los carteros normalmente no trabajan los sabados, en caso de no poder entregartelo en persona podrias ir a buscarlo a la sucursal no?" y esperá su afirmación.
- Si pide día específico: "No podemos garantizar porque depende del correo."
- RETIRO TERCEROS: Si preguntan si OTRA PERSONA puede recibir o ir a retirar al correo: "Sí, puede recibirlo o retirarlo en sucursal cualquier persona mayor de edad con tu DNI (o fotocopia) y una nota de autorización tuya."

INDECISIÓN:
- Dudan sobre PRODUCTO: "No te preocupes, te ayudo 😊" + breve info opciones + "¿Querés saber más de alguna?"
- Dudan sobre COMPRAR AHORA: Ofrecé programar envío para congelar precio. Comportate como vendedor con alternativas.`;
}

function _getModuleConsumption(): string {
    return `
INSTRUCCIONES DE CONSUMO (responder SOLO el producto preguntado):
⚠️ Si no sabés qué producto eligió: preguntá primero "¿Con cuál arrancás?"
- SEMILLAS: Semana 1 partís en 8, después en 4. Cada noche hervís un pedacito 5 min, tomás agua + pedacito antes de dormir. Sin gusto.
- CÁPSULAS: Una al día, media hora antes de la comida principal con un vaso de agua. Antes del almuerzo o cena (la que más comés o más ansiedad tenés).
- GOTAS: Semana 1: 10 gotas antes de la comida principal con agua. Semana 2+: antes del almuerzo o cena, ajustando según progreso.`;
}

function _getModulePostSale(): string {
    return `
Este cliente YA COMPRÓ. Sos un asistente post-venta amable.
REGLAS:
1. Si saluda: respondé breve.
2. Si pregunta por envío/demora: tarda 7-10 días hábiles.
3. Si pide postergar ENVÍO a fecha futura: Si <10 días desde hoy: "Los envíos tardan mínimo 10 días, no hay problema". Si >10 días: aceptá, confirmá y extraé POSTDATE: [fecha].
4. Si tiene reclamo/duda compleja: extractedData="NEED_ADMIN".
5. Si quiere VOLVER A COMPRAR: extractedData="RE_PURCHASE" y preguntale qué quiere.
6. ANTI-INSISTENCIA (CRÍTICO): NUNCA repitas "¿Te puedo ayudar con algo más?" si ya lo dijiste hace poco. Si el cliente dice "No gracias" o indica que no necesita más nada, RESPONDÉ SIMPLEMENTE "¡Perfecto! Que tengas un lindo día 😊" y NO HAGAS NINGUNA PREGUNTA MÁS.
7. NUNCA inventes info. NUNCA pidas datos de envío/dirección.`;
}

function _getModuleSafety(): string {
    return `
Verificar si hay contraindicación o riesgo.
MENORES — REGLA CRÍTICA DE IDENTIFICACIÓN:
- Si el usuario menciona "mi hija/hijo" o "es para mi hija/hijo": EL USUARIO ES EL ADULTO. La menor es la hija/hijo, NO el usuario.
- NUNCA trates al usuario como menor si dijo que el producto es para su hijo/a menor.
- Respondé: "Para menores de 18 no la recomendamos porque el cuerpo todavía está creciendo 😊 Si es para vos, sí podés tomarla sin problema."
- Si ya aclararon ≥18 años → SÍ puede tomarla, goalMet=true. Si <18 → rechazar venta para esa persona amablemente.
EMBARAZO/LACTANCIA/+80 AÑOS/CÁNCER: RECHAZAR VENTA. "Priorizamos tu salud 🌿😊 Por precaución no recomendamos el consumo en casos de embarazo, lactancia, edad muy avanzada o patologías oncológicas graves. Si el pedido es para otra persona, avisame." extractedData="REJECT_MEDICAL".`;
}

// ── EXTRACTION RULES (always sent, at END = high attention zone) ──
function _getExtractionRules(): string {
    return `
EXTRACCIÓN DE DATOS (CRÍTICO — siempre verificar antes de responder):
- Si el cliente elige o confirma un producto (ej: "sí, quiero esas", "cápsulas", "gotas"): extractedData="PRODUCTO: Cápsulas" (o Gotas, o Semillas). ¡Este paso es VITAL para que el sistema avance!
- Si mencionan edad/peso/patología (diabetes, tiroides, gastritis, hipertensión): extractedData="PROFILE: [dato]". Ejemplo: "PROFILE: 45 años, hipotiroidismo, bajar 15kg"
- Si piden postergar envío a fecha futura: extractedData="POSTDATADO: [fecha]"
- REGLA DE POSTERGACIÓN: NUNCA ofrezcas postergar el envío por tu cuenta. Solo hacelo si el cliente lo insinúa.
- Si quieren CAMBIAR pedido: preguntá qué quieren y extractedData="CHANGE_ORDER"
- Si quieren CANCELAR: "Qué pena... 😔 ¿Por qué?" extractedData="CANCEL_ORDER"
- Si EMBARAZADA/LACTANDO/+80/CÁNCER: rechazar venta, extractedData="REJECT_MEDICAL"

FORMATO (JSON puro, sin markdown, sin backticks):
{ "response": "tu respuesta corta", "goalMet": true/false, "extractedData": "dato extraído o null" }`;
}

// ── PROMPT BUILDER — Selects the right module for each step ──
function _buildSystemPrompt(step: string): string {
    const prices = _getPrices();
    let module;

    switch (step) {
        case 'waiting_weight':
        case 'waiting_preference':
        case 'waiting_preference_consultation':
            module = _getModuleEarlyFunnel(prices);
            break;
        case 'waiting_plan_choice':
            module = _getModulePlanChoice(prices);
            break;
        case 'waiting_data':
            module = _getModuleDataCollection();
            break;
        case 'waiting_price_confirmation':
        case 'waiting_ok':
        case 'closing':
            module = _getModuleObjection(prices);
            break;
        case 'post_sale':
            module = _getModulePostSale();
            break;
        case 'safety_check':
            module = _getModuleSafety();
            break;
        default:
            module = _getModuleObjection(prices);
            break;
    }

    // Append consumption info if relevant (user might ask how to take it in any step)
    const consumptionSteps = [
        'waiting_preference', 'waiting_preference_consultation', 'waiting_plan_choice',
        'waiting_ok', 'waiting_data', 'waiting_final_confirmation',
        'waiting_admin_ok', 'waiting_admin_validation', 'post_sale'
    ];
    const extraModule = consumptionSteps.includes(step) ? '\n' + _getModuleConsumption() : '';

    return [
        _getCorePrompt(),     // TOP — max attention (identity, tone, universal rules)
        module,               // MIDDLE — step-specific context 
        extraModule,          // MIDDLE — consumption (if relevant step)
        _getExtractionRules() // BOTTOM — max attention (data extraction, JSON format)
    ].join('\n\n');
}



// ═══════════════════════════════════════════════════════
// AI SERVICE — OpenAI GPT-4o-mini
// ═══════════════════════════════════════════════════════
class AIService {
    client: OpenAI;
    model: string;
    cache: NodeCache;
    stats: { calls: number, cached: number, retries: number, errors: number };

    constructor() {
        const apiKey = process.env.OPENAI_API_KEY || "";
        if (!apiKey) {
            logger.error("❌ CRITICAL: OPENAI_API_KEY is missing!");
        }

        logger.info(`📡 [AI] Initializing OpenAI (model: ${MODEL})`);

        this.client = new OpenAI({ apiKey });
        this.model = MODEL;
        this.cache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS, checkperiod: 120, maxKeys: 1000 });
        this.stats = { calls: 0, cached: 0, retries: 0, errors: 0 };
    }

    /**
     * Hash string utility for Keys
     */
    _hashKey(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        // Prefab with standard length for collision awareness
        return 'ai_' + hash.toString(36) + '_' + str.length;
    }

    /**
     * Core API call with retry + rate limit handling
     */
    async _callQueued<T>(apiCallFn: () => Promise<T>, rawCacheKey: string | null = null, customTTL: number | undefined = undefined): Promise<T> {
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

        let result: T | undefined;
        let success = false;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                result = await apiCallFn();
                success = true;
                break;
            } catch (e: any) {
                const status = e.status || e.statusCode;
                if (status === 429) {
                    this.stats.retries++;
                    const waitTime = Math.pow(2, attempt + 1) * 1000 + Math.floor(Math.random() * 1000);
                    logger.warn(`⚠️ [AI] Rate Limit (429). Attempt ${attempt + 1}/${MAX_RETRIES}. Backing off ${waitTime / 1000}s...`);
                    await new Promise(r => setTimeout(r, waitTime));
                } else {
                    this.stats.errors++;
                    throw e; // Non-rate limit errors bubble up to BullMQ worker explicitly
                }
            }
        }

        if (!success || result === undefined) {
            this.stats.errors++;
            throw new Error("AI Service Unavailable (Max Retries Exceeded or Unhandled Error)");
        }

        // Cache the result
        if (cacheKey && result) {
            if (customTTL) {
                this.cache.set(cacheKey, result, customTTL);
            } else {
                this.cache.set(cacheKey, result);
            }
        }

        return result;
    }

    /**
     * Main Chat Function
     */
    async chat(userText: string, context: APIContext): Promise<AIParsedResponse> {
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

            const pathInfo = faq.find((q: any) => q.keywords.includes('diabetes'))?.response || "";
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
                } catch (e: any) { }

                knowledgeContext += `- Plan 120 días sin adicional. Plan 60 días con Contra Reembolso MAX (+$${adMax}).\n`;
                knowledgeContext += `- Envío gratis por Correo Argentino, pago en efectivo al recibir\n`;
            } else if (step === 'waiting_data') {
                knowledgeContext += `- Necesitamos: nombre completo, calle y número, ciudad, código postal\n`;
                knowledgeContext += `- PROHIBIDO PEDIR NÚMERO DE TELÉFONO. Ya estamos hablando por WhatsApp, ¡ya tenemos su número! Nunca pidas este dato.\n`;
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
3. PREGUNTAS DEL USUARIO (CRÍTICO): Si el usuario hace una pregunta, RESPONDELA SIEMPRE de forma clara. Nunca lo ignores. Luego de responder, y en un tono relajado y muy poco insistente (ej: "te tomo los datos o te ayudo con algo más?"), volvé a intentar encausar el objetivo del paso. EXCEPCIÓN: Si el usuario dice explícitamente "No gracias" o similar, o la etapa es post-venta y no quiere nada más, NO HAGAS NINGUNA PREGUNTA ADICIONAL. Si el usuario NO preguntó nada y tampoco cumplió el objetivo, volvé a preguntarle lo del objetivo pero de forma breve y amigable.
4. Excepción a la Regla 3 (POSTERGACIÓN): Si el usuario dice que "no puede hablar ahora" o "está trabajando", SOLO confirmá con amabilidad ("Dale, tranqui. Avisame cuando puedas!"). PERO si el usuario dice "en otro momento lo compro", "este mes no puedo", "después veo", "no tengo plata ahora": DEBES ofrecer POSTDATAR el envío para "congelar el precio" como te indica el prompt. NO apliques postergación silenciosa acá, compórtate como VENDEDOR.
5. Si el usuario dice algo EMOCIONAL o PERSONAL (hijos, salud, bullying, autoestima): mostrá EMPATÍA primero. NO USES "Entiendo, eso es difícil". Usá variaciones reales y genuinas. Después volvé suavemente al objetivo del paso.
6. PROHIBIDO: No hables de pago, envío, precios, ni datos de envío si el OBJETIVO DEL PASO no lo menciona, a menos que el usuario lo haya preguntado explícitamente. Limitá tu respuesta al tema del objetivo.
7. MENORES DE EDAD: Si el mensaje menciona menores, VERIFICÁ EL HISTORIAL. Si ya se aclaró que la persona es mayor de 18, NO repitas la restricción. Confirmá que puede tomarla y seguí adelante.
8. ANTI-REPETICIÓN: NUNCA repitas textualmente un mensaje que ya está en el historial. Si necesitás pedir los mismos datos, usá una frase DIFERENTE.
`;

        try {
            const systemPrompt = _buildSystemPrompt(context.step || 'general');
            const result: any = await this._callQueued(
                () => this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    response_format: zodResponseFormat(ChatResponseSchema, "chat_response"),
                    temperature: 0.7,
                    max_tokens: COMPLEX_STEPS.has(context.step || '') ? 450 : 250
                }),
                `chat_${systemPrompt.length}_${userPrompt.substring(0, 150)}` // Caché activo para FAQs y etapas repetitivas
            );

            // OpenAI Structured Outputs guarantees this structure natively due to zodResponseFormat
            // The content string is 100% guaranteed to be a valid JSON matching the schema
            const content = result.choices[0].message?.content || "";
            return this._parseJSON(content);
        } catch (e: any) {
            logger.error("🔴 [AI] Chat Error:", e.message);
            return { response: "Estoy teniendo un pequeño problema técnico, ¿me repetís?", goalMet: false };
        }
    }

    /**
     * Check if history needs summarization
     */
    async checkAndSummarize(history: any[]): Promise<{ summary: string; prunedHistory: any[] } | null> {
        if (!history || history.length <= 50) return null;

        const now = Date.now();

        // Find how many messages are within the last 3 days
        const recentMessages = history.filter(msg => {
            if (!msg.timestamp) return false;
            return differenceInDays(now, msg.timestamp) <= 3;
        });

        const messagesToKeepCount = Math.max(50, recentMessages.length);

        // Only summarize if history exceeds the target bounds
        if (history.length > messagesToKeepCount) {
            logger.info(`[AI] Summarizing history (${history.length} messages down to ${messagesToKeepCount})...`);
            const summary = await this._callQueuedSummarize(history);
            if (summary) {
                logger.info(`[AI] Summary created: "${summary.substring(0, 50)}..."`);
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
    async generateManualSummary(history: any[]): Promise<string | null> {
        return await this._callQueuedSummarize(history);
    }

    /**
     * Summarize history through the queue
     */
    async _callQueuedSummarize(history: any[]): Promise<string | null> {
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
        const cacheKey = `report_${prompt.substring(0, 100)}`;
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
    async parseAddress(text: string): Promise<AIParsedResponse> {
        const prompt = `
        Analizá el siguiente texto y extraé datos de dirección postal de Argentina.
        El texto puede estar incompleto, ser solo un código postal, una provincia, o una dirección desordenada.
        
        TEXTO DEL USUARIO: "${text}"

        DETALLES DE EXTRACCIÓN (Si no está, devolver null):
        - nombre: Nombre COMPLETO de persona, SIEMPRE incluir apellido si lo dice (ej: "Laura Aguirre", "Marta Pastor"). NUNCA omitas el apellido.
        - calle: Calle y altura (ej: "Av. Santa Fe 1234", "Barrio 140 viv casa 16").
        - ciudad: Localidad o ciudad (ej: "Valle Viejo", "El Bañado", "Gualeguay").
        - provincia: Provincia de Argentina (ej: "Catamarca", "Córdoba", "Entre Ríos").
        - cp: Código postal numérico (ej: "4707", "5000").
        
        FECHA ACTUAL DE LA CONSULTA: ${new Date().toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        - postdatado: SOLO si el cliente EXPLÍCITAMENTE pide enviar o recibir el pedido en una fecha futura (ej: "mandamelo el 10", "cobro a principio de mes", "el viernes que viene"). 
          CRÍTICO: Usá la "Fecha Actual" provista arriba para calcular el día exacto y retorná la fecha en formato "dd/MM" (ej: "10/05", "15/12"). Si es "a principio de mes", asume el día 05 del mes siguiente. Si el texto es solo datos de dirección/nombre, SIEMPRE devolver null. NO inventes si no lo pidieron.
        
        REGLAS Y CONTEXTO GEOGRÁFICO:
        1. Tu prioridad es extraer CUALQUIER dato útil, aunque falten otros.
        2. "Gualeguay" y "Gualeguaychú" pertenecen a la provincia de Entre Ríos, NO a Santa Fe.
        3. Barrios como "Barrio 60 viviendas" o "mz F casa 4" van en "calle".
        4. CRÍTICO: Separa correctamente el NOMBRE DE PERSONA del NOMBRE DE LA CALLE. 
           Si te dicen "marta pastor bengas 77", "marta pastor" es el nombre y "bengas 77" es la calle. No pongas apellidos como parte de la calle ni calles como parte del apellido. EXTRAE SIEMPRE el nombre Y apellido completo de la persona.
        5. Si el usuario envía SOLO SU NOMBRE (ej: "Juan", "Pedro Pablo"), extraelo como "nombre", y devuelve los demás como null.
        6. Si el texto dice claramente de qué provincia es, respetalo aunque no coincida con el código postal.
        7. Las Avenidas o calles a veces están abreviadas (ej: "av belgrano 45D").
        `;
        try {
            const result: any = await this._callQueued(
                () => this.client.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: "Sos un parser de datos de envío experto en geografía argentina." },
                        { role: "user", content: prompt }
                    ],
                    response_format: zodResponseFormat(AddressResponseSchema, "address_response"),
                    temperature: 0,
                    max_tokens: 200
                }),
                `addr_${text.substring(0, 50)}`, // Clave de caché para deduplicar textos crudos como "1", "2" o direcciones comunes
                5 * 60 // 5 MINUTOS DE TTL para extracciones
            );

            const content = result.choices[0].message?.content || "";
            return this._parseJSON(content);
        } catch (e: any) {
            return { _error: true };
        }
    }

    /**
     * Transcribe Audio — Uses OpenAI Whisper API
     */
    async transcribeAudio(mediaData: string, mimeType: string): Promise<string | null> {
        try {
            // Convert base64 to buffer and write temp file (Whisper needs a file)
            const buffer = Buffer.from(mediaData, 'base64');
            const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
            const tmpPath = path.join(os.tmpdir(), `herbalis_audio_${Date.now()}.${ext}`);

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
        } catch (e: any) {
            logger.error("🔴 [AI] Transcribe Error:", e.message);
            return null;
        }
    }

    /**
     * Analyze Image — Uses OpenAI Vision to extract text or describe an image
     */
    async analyzeImage(mediaData: string, mimeType: string, prompt: string): Promise<string | null> {
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
            return result.choices[0].message?.content?.trim() || null;
        } catch (e: any) {
            logger.error("🔴 [AI] Vision Error:", e.message);
            return null;
        }
    }

    /**
     * Helper for Admin Suggestions ("Yo me encargo")
     */
    async generateSuggestion(instruction: string, conversationContext: string): Promise<string> {
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

    _parseJSON(text: string): AIParsedResponse {
        try {
            const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(jsonStr);
            if (typeof parsed.response !== 'string') {
                parsed.response = String(parsed.response || "");
            }
            return parsed as AIParsedResponse;
        } catch (e: any) {
            return { response: typeof text === 'string' ? text.replace(/```/g, '') : "", goalMet: false };
        }
    }
}

// Singleton Instance
const aiService = new AIService();
export { aiService };
