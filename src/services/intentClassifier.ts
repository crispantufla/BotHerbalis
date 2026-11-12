/**
 * Clasificador de mensajes: qué está HACIENDO el cliente con lo que escribió.
 *
 * Nació el 12-nov-2026. Todas las fallas de la revisión de ese día tenían el
 * mismo origen: una regla del código decidió leyendo palabras sueltas, sin
 * entender la frase. "son de Herbalife o es otra cosa?" → cambio de pedido;
 * "Son de Rosario" → localidad del cliente; "tengo tarjeta pero me da miedo
 * usarla, ¿se puede en efectivo?" → eligió tarjeta. Acá una llamada corta a la
 * IA lee el mensaje ANTES de que actúen las reglas, y los pasos la consultan
 * por `dependencies.intent`.
 *
 * Solo SUMA señal: si falla, tarda o no hay cliente de Anthropic, devuelve null
 * y cada paso se comporta como antes.
 */
const logger = require('../utils/logger');

export interface MessageIntent {
    /** Contesta lo que se le preguntó o elige una opción (producto, plan, pago, envío, datos, sí/no). */
    chooses: boolean;
    /** Pregunta o pide una explicación, aunque no use signos. */
    asks: boolean;
    /** Desconfianza, miedo, queja o una traba para seguir. */
    objects: boolean;
    /** Menciona su edad, una enfermedad, medicación, embarazo o un efecto en su salud. */
    health: boolean;
}

const MODEL = process.env.INTENT_MODEL || process.env.CLAUDE_MODEL_SIMPLE || 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = Number(process.env.INTENT_TIMEOUT_MS) || 4000;
const ENABLED = () => process.env.INTENT_CLASSIFIER !== '0' && process.env.INTENT_CLASSIFIER !== 'false';

const SYSTEM = `Clasificás UN mensaje de un cliente en una venta por WhatsApp en Argentina (producto natural para bajar de peso: cápsulas, gotas o semillas). Recibís el último mensaje del vendedor y la respuesta del cliente. La gente escribe sin signos, con errores y a veces por audio transcripto.

Marcá cada campo por separado; pueden ser varios verdaderos a la vez:
- chooses: el cliente CONTESTA lo que se le preguntó o ELIGE algo (un producto, un plan, cómo pagar, dónde recibirlo), da su localidad o sus datos, o acepta/rechaza. Nombrar una opción para preguntar por ella o para decir que le da miedo NO es elegirla.
- asks: pregunta algo o pide que le expliquen, aunque no ponga signos ("se toma una x dia", "son de rosario", "y eso quita el apetito").
- objects: expresa desconfianza, miedo, enojo, una queja o una traba para seguir ("me da miedo dar la tarjeta", "no paso mis datos a nadie", "es caro").
- health: menciona su edad, una enfermedad, medicación, embarazo, lactancia o un efecto del producto en su salud.

Ejemplos:
Vendedor: "¿Con cuál querés arrancar?" / Cliente: "son de Herbalife o es otra cosa? tengo miedo que me haga mal, como se toma" → chooses=false asks=true objects=true health=true
Vendedor: "¿De qué localidad sos?" / Cliente: "Son de Rosario" → chooses=false asks=true objects=false health=false
Vendedor: "¿Y eso queda cerca de Rosario? ¿A cuántos km?" / Cliente: "Son de Rosario" → chooses=false asks=true objects=false health=false (habla del VENDEDOR: "son", "están", "tienen" en plural no es el cliente)
Vendedor: "¿De qué localidad sos?" / Cliente: "soy de rosario" → chooses=true asks=false objects=false health=false
Vendedor: "¿De qué localidad sos?" / Cliente: "Se abona al recibir" → chooses=false asks=true objects=false health=false (no dijo su localidad: pregunta cómo se paga)
Vendedor: "¿Arrancamos con las gotas?" / Cliente: "bueno vere, estare cobrando la semana que viene, se paga aqui cuando lo traen" → chooses=false asks=true objects=false health=false
Vendedor: "¿Avanzamos con esas?" / Cliente: "tengo q bajar 10 kilo" → chooses=true asks=false objects=false health=false (los kilos a bajar no son un tema de salud)
Vendedor: "¿Cómo querés abonar? 1 Tarjeta 2 Transferencia" / Cliente: "yo tengo tarjeta pero ya me robaron una vez, si viene a domicilio y pago en efectivo cuanto me sale" → chooses=false asks=true objects=true health=false
Vendedor: "¿Cómo querés abonar? 1 Tarjeta 2 Transferencia" / Cliente: "con tarjeta" → chooses=true asks=false objects=false health=false
Vendedor: "¿Con cuál querés arrancar?" / Cliente: "las capsulas de 60, cuanto tarda en llegar" → chooses=true asks=true objects=false health=false
Vendedor: "¿Te paso los precios?" / Cliente: "tengo los trigliceridos alto y diabetes" → chooses=false asks=false objects=false health=true
Vendedor: "¿Te paso los precios?" / Cliente: "si dale" → chooses=true asks=false objects=false health=false`;

const TOOL = {
    name: 'clasificar',
    description: 'Devuelve la clasificación del mensaje del cliente.',
    input_schema: {
        type: 'object',
        properties: {
            chooses: { type: 'boolean' },
            asks: { type: 'boolean' },
            objects: { type: 'boolean' },
            health: { type: 'boolean' },
        },
        required: ['chooses', 'asks', 'objects', 'health'],
    },
};

/**
 * Mensajes que no vale la pena clasificar: una o dos palabras sin signo, un
 * número, un "sí". Los resuelven bien las reglas y serían la mayoría de las
 * llamadas.
 */
export function isTrivialMessage(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return true;
    if (/[?¿]/.test(t)) return false;
    if (/^\/9j\//.test(t) || /^[A-Za-z0-9+/=]{200,}$/.test(t)) return true; // imagen que llegó como base64
    return t.split(/\s+/).length <= 2;
}

function _client(): any {
    try {
        return require('./ai').aiService?.anthropic || null;
    } catch {
        return null;
    }
}

export async function classifyMessage(
    text: string,
    ctx: { lastBotMessage?: string | null; step?: string | null } = {},
    client: any = _client()
): Promise<MessageIntent | null> {
    if (!ENABLED() || !client || isTrivialMessage(text)) return null;
    const lastBot = String(ctx.lastBotMessage || '').replace(/\s+/g, ' ').slice(-400) || '(sin mensaje previo)';
    const user = `Vendedor: "${lastBot}"\nCliente: "${text.replace(/\s+/g, ' ').slice(0, 1200)}"`;
    let timer: any;
    try {
        const call = client.messages.create({
            model: MODEL,
            max_tokens: 120,
            temperature: 0,
            system: SYSTEM,
            messages: [{ role: 'user', content: user }],
            tools: [TOOL],
            tool_choice: { type: 'tool', name: 'clasificar' },
        });
        const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), TIMEOUT_MS); });
        const result: any = await Promise.race([call, timeout]);
        if (!result) {
            logger.warn(`[INTENT] sin respuesta en ${TIMEOUT_MS} ms — sigo sin clasificación.`);
            return null;
        }
        const input = (result.content || []).find((c: any) => c.type === 'tool_use')?.input;
        if (!input) return null;
        const intent: MessageIntent = {
            chooses: input.chooses === true,
            asks: input.asks === true,
            objects: input.objects === true,
            health: input.health === true,
        };
        logger.info(`[INTENT] step=${ctx.step || '?'} chooses=${intent.chooses} asks=${intent.asks} objects=${intent.objects} health=${intent.health} — "${text.replace(/\s+/g, ' ').slice(0, 60)}"`);
        return intent;
    } catch (e: any) {
        logger.warn(`[INTENT] falló (${e?.message}) — sigo sin clasificación.`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** La IA dice que NO es una elección sino una pregunta u objeción. */
export function isNotAChoice(intent: MessageIntent | null | undefined): boolean {
    return !!intent && !intent.chooses && (intent.asks || intent.objects);
}
