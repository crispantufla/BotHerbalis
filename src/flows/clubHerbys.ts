/**
 * clubHerbys.ts — la conversación de la promo Club Herbys (Rosario y zona).
 *
 * Este bot es una copia del de Herbalis recortada a una sola cosa: manda la
 * promo (services/promo/) y, cuando la persona contesta, conversa hasta que
 * acepta o pide hablar con alguien. Ahí terminó su función: confirma, avisa a
 * Club Herbys (CLUB_ALERT_NUMBERS en adminService → 341 261-9405) y pausa el chat para que lo
 * tome una asesora. No toma datos, no arma pedidos, no cobra.
 *
 * Claude contesta las dudas, pero SOLO con la información de REFERENCIA de abajo,
 * y devuelve un JSON con la decisión. Los mensajes que cierran (confirmación,
 * derivación, despedida) son textos fijos del guion: la IA nunca los redacta.
 * Guion completo y ejemplos: docs/guion-rosario.pdf.
 */

import { UserState } from '../types/state';
import { pauseUser } from '../services/pauseService';
import { markPromoReply } from '../services/promo/promoDispatcher';
import { phoneZone } from './utils/deliveryZone';
import logger from '../utils/logger';

export const CLUB_PHONE_TEXT = '341 261-9405';
export const CLUB_AI_MODEL = process.env.CLUB_HERBYS_MODEL || 'claude-haiku-5-5';
/** Respuestas de la IA sin que la persona decida: después se deriva, para no estirar la charla. */
export const MAX_AI_TURNS = 4;

export const OFFER_TEXT =
    '🎁 BENEFICIO ESPECIAL HERBALIS + CLUB HERBYS\n' +
    'Ahora podés comenzar tu plan de Gotas Herbalis por 60 días sin pagar todo junto. Recibís tu producto y abonás $18.900 al momento de la entrega. ' +
    'Después completás el pago en 4 cuotas semanales de $7.900. Sin tarjeta. Sin trámites. ¿Querés aprovecharlo?';

/** La oferta para quien está FUERA de la zona de reparto: sin pago al recibir. */
export const OFFER_TEXT_OUT =
    '🎁 BENEFICIO ESPECIAL HERBALIS + CLUB HERBYS\n' +
    'Ahora podés comenzar tu plan de Gotas Herbalis por 60 días sin pagar todo junto. Abonás $18.900 al momento de realizar el pedido (transferencia o tarjeta). ' +
    'Después completás el pago en 4 cuotas semanales de $7.900 por transferencia. Sin trámites. ¿Querés aprovecharlo?';

/** Textos fijos del guion (las letras son las del PDF). */
export const TEXTS = {
    C: '¡Perfecto! 💗\nTu solicitud quedó registrada.\n\n' +
        'Ahora vamos a derivarte con una asesora de Club Herbys, que se va a comunicar con vos desde nuestro número de atención para:\n\n' +
        '• confirmar tus datos;\n• verificar el domicilio o lugar de entrega;\n• coordinar día y horario;\n• dejar confirmado tu pedido y la modalidad de pago.\n\n' +
        'No necesitás hacer nada más por ahora. En breve te escribimos para continuar.\n\n' +
        `Te vamos a escribir desde el WhatsApp oficial de Club Herbys: ${CLUB_PHONE_TEXT}.\n` +
        'Así vas a reconocer el mensaje cuando te llegue 😊',
    E: '¡Buenísimo! 😊 Le paso tu consulta a una asesora de Club Herbys, que te va a responder personalmente.\n\n' +
        `Te va a escribir desde nuestro WhatsApp oficial: ${CLUB_PHONE_TEXT}.\n` +
        'Así vas a reconocer el mensaje cuando te llegue.',
    F: '¡Gracias por responder! 😊 Si más adelante te interesa, escribinos por acá. ¡Que tengas un lindo día!',
    G: 'Entendido, no te vamos a volver a escribir. ¡Disculpá la molestia! 🙏',
    /** Aceptación FUERA de zona: no hay entrega coordinada ni pago al recibir. */
    C_OUT: '¡Perfecto! 💗\nTu solicitud quedó registrada.\n\n' +
        'Ahora vamos a derivarte con una asesora de Club Herbys, que se va a comunicar con vos desde nuestro número de atención para:\n\n' +
        '• confirmar tus datos;\n• pasarte cómo abonar los $18.900 (transferencia o tarjeta);\n• coordinar el envío a tu domicilio;\n• dejar confirmado tu pedido.\n\n' +
        'No necesitás hacer nada más por ahora. En breve te escribimos para continuar.\n\n' +
        `Te vamos a escribir desde el WhatsApp oficial de Club Herbys: ${CLUB_PHONE_TEXT}.\n` +
        'Así vas a reconocer el mensaje cuando te llegue 😊',
};

const REFERENCE_COMMON = `PRODUCTO: Gotas Herbalis, plan de 60 días. Es el único producto de este beneficio.
PARA QUÉ SIRVE: son gotas de nuez de la india para bajar de peso de forma natural. El plan de 60 días es el que recomendamos para bajar hasta 10 kg (lo mismo que dice el guion de Herbalis).
INGREDIENTES: clorofila, menta, nuez de la india y vitamina C. 100% naturales.
CÓMO SE TOMA: 10 gotas al día, 30 minutos antes del almuerzo o de la cena.
NO DIGAS EL TOTAL: si preguntan cuánto es en total, respondé con el anticipo y las cuotas, sin sumarlos.`;

const REFERENCE = `BENEFICIO: Herbalis + Club Herbys, para Rosario y zona.
${REFERENCE_COMMON}
PAGO: $18.900 de anticipo al recibir el pedido, y después 4 cuotas semanales de $7.900. Sin tarjeta de crédito y sin trámites.
CÓMO SIGUE: cuando la persona acepta, una asesora de Club Herbys le escribe desde el WhatsApp oficial ${CLUB_PHONE_TEXT} para confirmar los datos, verificar el domicilio o lugar de entrega, coordinar día y horario y dejar confirmado el pedido y la modalidad de pago.`;

// Fuera de la zona de reparto (5-nov-2026). La persona es de una característica
// sin reparto propio: no hay pago al recibir. Los primeros envíos de la campaña
// de noviembre salieron con el texto de la zona a todo el mundo; si en la charla
// aparece "pagás al recibir", la IA lo aclara con estas condiciones.
const REFERENCE_OUT = `BENEFICIO: Herbalis + Club Herbys, para fuera de Rosario y zona.
${REFERENCE_COMMON}
PAGO: $18.900 de anticipo AL MOMENTO DE REALIZAR EL PEDIDO, por transferencia o tarjeta. Después, 4 cuotas semanales de $7.900 por transferencia. Sin trámites.
PAGO AL RECIBIR: NO existe para esta persona. El pago al recibir es solo para Rosario y la zona de reparto. Si la charla dice otra cosa (le llegó un mensaje que decía que pagaba al recibir), aclaralo con amabilidad: fuera de Rosario y zona el anticipo se abona al hacer el pedido. Si la persona dice que es de Rosario o de la zona, decisión "derivar".
CÓMO SIGUE: cuando la persona acepta, una asesora de Club Herbys le escribe desde el WhatsApp oficial ${CLUB_PHONE_TEXT} para confirmar los datos, pasarle cómo abonar los $18.900, coordinar el envío y dejar confirmado el pedido.`;

const _system = (offer: string, reference: string) => `Atendés por WhatsApp a personas que recibieron esta oferta:

"${offer}"

Tu único trabajo es responder dudas sobre la oferta y llevar a la persona a aceptarla o a hablar con una asesora. Escribís como una persona de Rosario: cálida, simple, mensajes cortos (2 a 4 líneas), con algún emoji suelto, en castellano rioplatense (vos).

REFERENCIA (lo único que sabés):
${reference}

REGLAS:
- Respondé SOLO con la información de REFERENCIA. Si te preguntan algo que no está ahí (si llega a una localidad, otros medios de pago, otros productos, descuentos, efectos secundarios), NO lo inventes: decisión "derivar".
- Sobre bajar de peso hablá con lo que dice la REFERENCIA: sirve para bajar de peso de forma natural y el plan de 60 días es para bajar hasta 10 kg. No hables de otras cantidades de kilos ni de plazos distintos del plan, y no lo garantices ("seguro", "garantizado", "100%").
- Salud, enfermedades, medicación, embarazo, lactancia, menores de edad o contraindicaciones: NO opines, decisión "derivar".
- No pidas datos (nombre, dirección, DNI): de eso se encarga la asesora.
- Después de responder una duda, cerrá preguntando si quiere aprovechar el beneficio.

DECISIÓN (mirá el último mensaje de la persona, en el contexto de la charla):
- "acepta": dice que sí, que lo quiere, que le tomen el pedido, "dale", etc. Si dice que sí pero hace una pregunta, primero respondé ("responder").
- "derivar": pide hablar con una persona o asesora, pregunta algo fuera de la REFERENCIA, se queja, o no queda claro qué quiere después de un par de mensajes.
- "no": no le interesa, ahora no, no gracias.
- "baja": pide que no le escriban más, que la borren, o lo denuncia como spam.
- "responder": tiene una duda que la REFERENCIA contesta, saluda, o pide más información.

Respondé SOLO con un JSON, sin nada antes ni después:
{"decision": "responder" | "acepta" | "derivar" | "no" | "baja", "respuesta": "texto para la persona (solo si decision es responder; si no, vacío)"}`;

export const SYSTEM = _system(OFFER_TEXT, REFERENCE);
export const SYSTEM_OUT = _system(OFFER_TEXT_OUT, REFERENCE_OUT);

/** La zona de la oferta que recibió: la que guardó el despachador, o la característica del teléfono (envíos anteriores al 5-nov). */
export function promoZoneOf(userId: string, state: UserState): 'in' | 'out' {
    return state.promo?.zone || phoneZone(userId);
}

export type Decision = 'responder' | 'acepta' | 'derivar' | 'no' | 'baja';

/** Lee el JSON de la IA. Ante cualquier cosa rara, deriva: nunca adivina un sí. */
export function parseDecision(raw: string | null | undefined): { decision: Decision; respuesta: string } {
    const fallback = { decision: 'derivar' as Decision, respuesta: '' };
    if (!raw) return fallback;
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    try {
        const j = JSON.parse(m[0]);
        const d = String(j.decision || '').toLowerCase() as Decision;
        if (!['responder', 'acepta', 'derivar', 'no', 'baja'].includes(d)) return fallback;
        const respuesta = typeof j.respuesta === 'string' ? j.respuesta.trim() : '';
        if (d === 'responder' && !respuesta) return fallback;
        return { decision: d, respuesta };
    } catch {
        return fallback;
    }
}

/**
 * Red de seguridad sobre lo que escribió la IA: si menciona un monto que no es de
 * la oferta, el total, otra cantidad de kilos que los 10 del guion, o garantiza
 * resultados, no se manda y se deriva.
 */
export function isSafeReply(text: string): boolean {
    const amounts = (text.match(/\$\s?\d[\d.]*/g) || []).map((a) => a.replace(/[^\d]/g, ''));
    if (amounts.some((a) => !['18900', '7900'].includes(a))) return false;
    if (/\b50\.?500\b/.test(text)) return false;   // el total (18.900 + 4 × 7.900): no se muestra
    const kilos = [...text.matchAll(/(\d+)\s*(kg|kilos?)\b/gi)].map((m) => m[1]);
    if (kilos.some((k) => k !== '10')) return false;   // el guion habla de "hasta 10 kg"
    if (/\b(garantiz\w*|100\s?% (efectivo|seguro|garantizado)|seguro que baj\w*)/i.test(text)) return false;
    if (/https?:\/\//i.test(text)) return false;
    return true;
}

function _historyForAi(state: UserState): Array<{ role: 'user' | 'assistant'; content: string }> {
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const h of (state.history || []).slice(-12)) {
        const role = h.role === 'user' ? 'user' : 'assistant';
        const content = String(h.content || '').trim();
        if (!content) continue;
        const last = out[out.length - 1];
        if (last && last.role === role) last.content += '\n' + content;   // la API pide turnos alternados
        else out.push({ role, content });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
}

async function _askClaude(anthropic: any, state: UserState, zone: 'in' | 'out'): Promise<string | null> {
    const messages = _historyForAi(state);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return null;
    const res = await anthropic.messages.create({
        model: CLUB_AI_MODEL,
        max_tokens: 2000,
        system: [{ type: 'text', text: zone === 'in' ? SYSTEM : SYSTEM_OUT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages,
    });
    const block = (res.content || []).find((b: any) => b.type === 'text');
    return block ? block.text : null;
}

async function _close(userId: string, reason: string, dependencies: any): Promise<void> {
    // La marca `closed` es la que manda: la pausa sirve para el panel, pero el
    // bot de origen borra solas las pausas de más de 7 días (STALE_PAUSE_DAYS),
    // y un chat cerrado no puede volver a recibir respuestas de la IA.
    const st = dependencies.sharedState?.userState?.[userId];
    if (st?.promo) { st.promo.closed = true; dependencies.saveState?.(userId); }
    await pauseUser(userId, reason, { sharedState: dependencies.sharedState });
    const logAndEmit = dependencies.logAndEmit || dependencies.sharedState?.logAndEmit;
    if (typeof logAndEmit === 'function') {
        try { logAndEmit(userId, 'system', `⏸️ Bot pausado — ${reason}`, 'promo_offer'); } catch { /* best effort */ }
    }
}

/**
 * Turno de la conversación de la promo. Lo llama processSalesFlow cuando el
 * chat tiene una promo activa. Siempre devuelve matched: true (ningún otro
 * paso del flujo de Herbalis corre en este bot).
 */
export async function handleClubHerbys(userId: string, text: string, state: UserState, dependencies: any): Promise<{ matched: boolean; paused?: boolean }> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const instanceId = dependencies.sellerId || dependencies.sharedState?.sellerId || 'default';
    const promo: any = state.promo;

    if (!promo.repliedAt) {
        promo.repliedAt = Date.now();
        markPromoReply(instanceId, userId, 'question');
    }
    promo.aiTurns = promo.aiTurns || 0;
    const zone = promoZoneOf(userId, state);

    let decision: Decision = 'derivar';
    let respuesta = '';
    const anthropic = dependencies.aiService?.anthropic;
    if (!anthropic) {
        logger.error('[CLUB] Sin cliente de Anthropic (¿falta ANTHROPIC_API_KEY?) — derivo.');
    } else {
        try {
            ({ decision, respuesta } = parseDecision(await _askClaude(anthropic, state, zone)));
        } catch (e: any) {
            logger.error(`[CLUB] La IA falló para ${userId}: ${e.message} — derivo.`);
        }
    }
    if (decision === 'responder' && !isSafeReply(respuesta)) {
        logger.warn(`[CLUB] Respuesta de la IA descartada por la red de seguridad: ${JSON.stringify(respuesta)}`);
        decision = 'derivar';
    }
    if (decision === 'responder' && promo.aiTurns >= MAX_AI_TURNS) decision = 'derivar';
    logger.info(`[CLUB] ${userId}: ${decision}${decision === 'responder' ? ` (turno ${promo.aiTurns + 1})` : ''}`);

    const notify = dependencies.notifyAdmin;
    switch (decision) {
        case 'responder':
            promo.aiTurns++;
            saveState(userId);
            await sendMessageWithDelay(userId, respuesta);
            return { matched: true };

        case 'acepta':
            promo.outcome = 'accepted';
            markPromoReply(instanceId, userId, 'interested');
            saveState(userId);
            await sendMessageWithDelay(userId, zone === 'in' ? TEXTS.C : TEXTS.C_OUT);
            if (notify) await notify('✅ ACEPTÓ el beneficio — contactarla', userId, '💬 «' + text + '»').catch(() => {});
            await _close(userId, 'Aceptó el beneficio: lo toma una asesora de Club Herbys', dependencies);
            return { matched: true, paused: true };

        case 'no':
            promo.outcome = 'declined';
            markPromoReply(instanceId, userId, 'declined');
            saveState(userId);
            await sendMessageWithDelay(userId, TEXTS.F);
            await _close(userId, 'No le interesa la promo', dependencies);
            return { matched: true, paused: true };

        case 'baja':
            promo.outcome = 'opted_out';
            markPromoReply(instanceId, userId, 'opted_out');
            saveState(userId);
            await sendMessageWithDelay(userId, TEXTS.G);
            await _close(userId, 'Pidió que no le escriban', dependencies);
            return { matched: true, paused: true };

        default:   // derivar
            promo.outcome = 'handed_off';
            markPromoReply(instanceId, userId, 'question');
            saveState(userId);
            await sendMessageWithDelay(userId, TEXTS.E);
            if (notify) await notify('🙋 Quiere hablar con una asesora', userId, '💬 «' + text + '»').catch(() => {});
            await _close(userId, 'Derivado a una asesora de Club Herbys', dependencies);
            return { matched: true, paused: true };
    }
}
