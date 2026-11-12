/**
 * Revisión nocturna de charlas.
 *
 * Una vez por día Claude lee TODAS las conversaciones de las últimas 24 horas y
 * marca dónde el bot contestó mal: una duda ignorada, una palabra mal leída, un
 * cliente que quedó sin respuesta. Es lo que el 12-nov-2026 hubo que hacer a
 * mano para descubrir que el guion por zona mandaba la lista de precios a
 * cualquier cosa que dijera el cliente.
 *
 * El resultado se guarda en DATA_DIR/reviews/<seller>/<fecha>.json y un resumen
 * va por `notifyAdmin`. Solo lee: no manda nada a clientes ni toca estados.
 */
import fs from 'fs';
import path from 'path';
const logger = require('../utils/logger');

export interface ReviewFinding {
    telefono: string;
    gravedad: 'alta' | 'media' | 'baja';
    que_paso: string;
    que_debia_pasar: string;
    cita: string;
}
export interface ReviewReport {
    sellerId: string;
    desde: string;
    hasta: string;
    conversaciones: number;
    mensajesDeClientes: number;
    resumen: string;
    hallazgos: ReviewFinding[];
    sinRespuesta: string[];
}

const MODEL = process.env.REVIEW_MODEL || process.env.CLAUDE_MODEL_PREMIUM || 'claude-sonnet-4-6';
const MAX_TRANSCRIPT_CHARS = 180_000;
const MAX_MSG_CHARS = 600;

const SYSTEM = `Sos quien revisa la calidad de un bot de ventas por WhatsApp (Argentina) que vende un producto natural para bajar de peso en cápsulas, gotas o semillas. Recibís las conversaciones de las últimas 24 horas. En cada línea: BOT es el bot, CLIENTE es el cliente, VENDEDOR es una persona del negocio que escribió a mano, SISTEMA son avisos internos.

Tu trabajo es encontrar dónde el BOT falló. Marcá solo fallas reales y concretas, con el mensaje que las prueba:
- El cliente preguntó o comentó algo y el bot contestó otra cosa, o lo ignoró (por ejemplo, mandó una lista de precios o repitió su pregunta).
- El bot tomó una palabra suelta por lo que no era (una pregunta leída como elección; el nombre de un lugar tomado como la localidad del cliente; "tarjeta" tomado como que elige pagar con tarjeta).
- El cliente habló de su edad, una enfermedad, medicación o un efecto adverso y el bot no lo atendió. Regla del negocio: de 70 a 79 años solo se ofrecen gotas; de 80 en adelante, embarazo o lactancia, no se vende.
- El bot se contradijo, repitió el mismo mensaje, o dio un dato distinto al que ya había dado.
- El bot ofreció pagar al recibir a alguien de fuera de Rosario y alrededores, o le pidió datos de reparto a alguien de otra ciudad. Regla: reparto propio y pago al recibir solo en Rosario y hasta 60 km; al resto, Correo Argentino prepago.
- El cliente escribió y nadie le respondió (el último mensaje de la charla es del cliente y pide algo).

NO marques: que el cliente no haya comprado, que haya dejado de escribir después de una respuesta correcta, ni los mensajes de VENDEDOR (no evalúes lo que escribió una persona). Si una charla está bien, no la menciones.

Gravedad: "alta" si probablemente se perdió una venta o hay un tema de salud sin atender; "media" si la respuesta fue mala pero la charla siguió; "baja" si es un detalle.
Escribí en castellano rioplatense, claro y sin tecnicismos.

Respondé SOLO con este formato, sin nada antes ni después:

RESUMEN: dos o tres oraciones sobre cómo anduvo el bot y cuál es el problema que más se repite.

### <teléfono> | <alta|media|baja>
PASÓ: qué hizo mal el bot.
DEBÍA: qué tendría que haber hecho.
CITA: el mensaje del cliente y la respuesta del bot, textuales, en una sola línea.

(un bloque ### por cada falla; si no hay ninguna, no pongas bloques)

SIN RESPUESTA: teléfonos separados por coma cuyo último mensaje es del cliente, pide algo y nadie contestó (o "ninguno").`;

/**
 * Lee el informe en el formato de texto de SYSTEM. Se usa texto y no una
 * herramienta porque con la respuesta estructurada el modelo devolvía la lista
 * de hallazgos como un JSON mal formado (las comillas de las citas sin escapar).
 * Tolera líneas de más y campos faltantes.
 */
export function parseReviewText(text: string): { resumen: string; hallazgos: ReviewFinding[]; sinRespuesta: string[] } {
    const t = String(text || '');
    const resumen = (t.match(/RESUMEN:\s*([\s\S]*?)(?=\n\s*###|\n\s*SIN RESPUESTA:|$)/i)?.[1] || '').trim();
    const hallazgos: ReviewFinding[] = [];
    for (const block of t.split(/\n\s*###\s*/).slice(1)) {
        const body = block.split(/\n\s*SIN RESPUESTA:/i)[0];
        const head = body.split('\n')[0] || '';
        const telefono = (head.match(/\d{8,15}/)?.[0] || head.split('|')[0] || '').trim();
        const gravedad = (head.match(/\b(alta|media|baja)\b/i)?.[1] || 'media').toLowerCase() as ReviewFinding['gravedad'];
        const field = (name: string) =>
            (body.match(new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n\\s*(?:PAS[OÓ]|DEB[IÍ]A|CITA):|$)`, 'i'))?.[1] || '').trim();
        const que_paso = field('PAS[OÓ]');
        if (!telefono || !que_paso) continue;
        hallazgos.push({ telefono, gravedad, que_paso, que_debia_pasar: field('DEB[IÍ]A'), cita: field('CITA') });
    }
    const sr = t.match(/SIN RESPUESTA:\s*([^\n]*)/i)?.[1] || '';
    const sinRespuesta = sr.match(/\d{8,15}/g) || [];
    return { resumen, hallazgos, sinRespuesta };
}

const ROLE: Record<string, string> = { user: 'CLIENTE', bot: 'BOT', admin: 'VENDEDOR', system: 'SISTEMA' };

/** Arma el texto de las conversaciones del período, solo las que tienen algún mensaje del cliente. */
export async function buildTranscript(sellerId: string, from: Date, to: Date, prismaClient?: any): Promise<{ text: string; conversaciones: number; mensajesDeClientes: number }> {
    const prisma = prismaClient || require('../../db').prisma;
    const logs = await prisma.chatLog.findMany({
        where: { instanceId: sellerId, timestamp: { gte: from, lt: to } },
        orderBy: { timestamp: 'asc' },
        select: { userPhone: true, role: true, content: true, timestamp: true },
    });
    const by = new Map<string, any[]>();
    for (const l of logs) {
        if (!by.has(l.userPhone)) by.set(l.userPhone, []);
        by.get(l.userPhone)!.push(l);
    }
    const blocks: string[] = [];
    let mensajesDeClientes = 0;
    for (const [phone, ls] of by) {
        const users = ls.filter((l) => l.role === 'user').length;
        if (!users) continue;
        mensajesDeClientes += users;
        const lines = ls.map((l) => {
            // Hora de Argentina (UTC-3), para que el informe coincida con lo que ve el vendedor.
            const hhmm = new Date(new Date(l.timestamp).getTime() - 3 * 3600_000).toISOString().slice(11, 16);
            let c = String(l.content || '').replace(/MEDIA_AUDIO:[^|]*\|TRANSCRIPTION:/, '[audio] ').replace(/\s+/g, ' ').trim();
            if (/^\/9j\//.test(c) || /^[A-Za-z0-9+/=]{200,}$/.test(c)) c = '[imagen]';
            if (c.length > MAX_MSG_CHARS) c = c.slice(0, MAX_MSG_CHARS) + '…';
            return `[${hhmm}] ${ROLE[l.role] || String(l.role).toUpperCase()}: ${c}`;
        });
        blocks.push(`=== Teléfono ${phone} ===\n${lines.join('\n')}`);
    }
    let text = blocks.join('\n\n');
    // Si no entra, se conservan las charlas más recientes.
    while (text.length > MAX_TRANSCRIPT_CHARS && blocks.length > 1) {
        blocks.shift();
        text = blocks.join('\n\n');
    }
    return { text, conversaciones: blocks.length, mensajesDeClientes };
}

/** Texto corto para WhatsApp: resumen + hallazgos, los graves primero. */
export function formatReviewForAdmin(r: ReviewReport, maxChars: number = 3500): string {
    const order: Record<string, number> = { alta: 0, media: 1, baja: 2 };
    const icon: Record<string, string> = { alta: '🔴', media: '🟠', baja: '🟡' };
    const sorted = [...r.hallazgos].sort((a, b) => (order[a.gravedad] ?? 3) - (order[b.gravedad] ?? 3));
    let out = `📋 *Revisión de charlas* — ${r.conversaciones} conversaciones, ${r.mensajesDeClientes} mensajes de clientes\n\n${r.resumen}`;
    if (!sorted.length && !r.sinRespuesta.length) return `${out}\n\n✅ No encontré fallas del bot.`;
    let shown = 0;
    for (const h of sorted) {
        const item = `\n\n${icon[h.gravedad] || '•'} *${h.telefono}*\n${h.que_paso}\n→ ${h.que_debia_pasar}`;
        if (out.length + item.length > maxChars - 200) break;
        out += item;
        shown++;
    }
    if (shown < sorted.length) out += `\n\n(+${sorted.length - shown} hallazgos más en el informe guardado)`;
    if (r.sinRespuesta.length) out += `\n\n⏳ *Sin respuesta:* ${r.sinRespuesta.slice(0, 15).join(', ')}`;
    return out;
}

function _anthropic(): any {
    try {
        return require('./ai').aiService?.anthropic || null;
    } catch {
        return null;
    }
}

export async function runNightlyReview(
    sellerId: string,
    deps: { notifyAdmin?: (title: string, userId: string, msg: string) => Promise<any> },
    opts: { now?: Date; hours?: number; client?: any; prisma?: any; dataDir?: string } = {}
): Promise<ReviewReport | null> {
    const client = opts.client || _anthropic();
    if (!client) {
        logger.warn(`[REVIEW][${sellerId}] sin cliente de Anthropic — no se hace la revisión.`);
        return null;
    }
    const hours = opts.hours || 24;
    const to = opts.now || new Date();
    const from = new Date(to.getTime() - hours * 3600_000);
    try {
        const t = await buildTranscript(sellerId, from, to, opts.prisma);
        if (!t.conversaciones) {
            logger.info(`[REVIEW][${sellerId}] sin conversaciones en las últimas ${hours} h — nada que revisar.`);
            return null;
        }
        const result: any = await client.messages.create({
            model: MODEL,
            max_tokens: 6000,
            temperature: 0,
            system: SYSTEM,
            messages: [{ role: 'user', content: `Conversaciones de las últimas ${hours} horas (hora de Argentina):\n\n${t.text}` }],
        }, { timeout: 180_000 });
        const raw = (result?.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
        const parsed = parseReviewText(raw);
        if (!parsed.resumen) {
            logger.warn(`[REVIEW][${sellerId}] la IA no devolvió el informe en el formato esperado: ${raw.slice(0, 200)}`);
            return null;
        }
        const report: ReviewReport = {
            sellerId,
            desde: from.toISOString(),
            hasta: to.toISOString(),
            conversaciones: t.conversaciones,
            mensajesDeClientes: t.mensajesDeClientes,
            resumen: parsed.resumen,
            hallazgos: parsed.hallazgos,
            sinRespuesta: parsed.sinRespuesta,
        };
        try {
            const dir = path.join(opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '../..'), 'reviews', sellerId);
            fs.mkdirSync(dir, { recursive: true });
            const day = new Date(to.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
            fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify(report, null, 2));
        } catch (e: any) {
            logger.warn(`[REVIEW][${sellerId}] no pude guardar el informe: ${e.message}`);
        }
        const u = result?.usage || {};
        logger.info(`[REVIEW][${sellerId}] ${report.conversaciones} charlas → ${report.hallazgos.length} hallazgos, ${report.sinRespuesta.length} sin respuesta (in=${u.input_tokens || '?'} out=${u.output_tokens || '?'}).`);
        if (deps.notifyAdmin) await deps.notifyAdmin('📋 Revisión de charlas', 'system', formatReviewForAdmin(report));
        return report;
    } catch (e: any) {
        logger.error(`[REVIEW][${sellerId}] falló: ${e.message}`);
        return null;
    }
}
