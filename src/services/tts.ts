/**
 * tts.ts — respuestas con nota de voz (experimento A/B, nov-2026).
 *
 * La audiencia es mayor de 45 y manda muchos audios. La hipótesis: a quien
 * escribe por audio, una voz le genera más confianza que un texto. Acá vive lo
 * que no depende del envío: la síntesis (ElevenLabs), la limpieza del texto para
 * que se pueda leer en voz alta, el criterio de "este texto no va por voz" y el
 * sorteo del grupo. El envío y el respaldo a texto están en sendMessageWithDelay
 * (botHelpers.ts).
 *
 * Todo acá falla hacia el texto: ante cualquier duda devuelve null/false y el
 * cliente recibe el mensaje escrito de siempre.
 */

import crypto from 'crypto';
const logger = require('../utils/logger');

export interface VoiceAudio {
    base64: string;
    mimetype: string;
}

export type VoiceGroup = 'voice' | 'text';

const TTS_TIMEOUT_MS = 15000;
const TTS_MODEL = 'eleven_multilingual_v2';
// WhatsApp graba sus notas de voz en ogg/opus. Se pide eso primero; mp3 queda
// de respaldo por si la cuenta o la API no lo dan.
const FORMAT_OPUS = 'opus_48000_64';
const FORMAT_MP3 = 'mp3_44100_128';
export const VOICE_MAX_CHARS = 600;
// Cuánto vale la señal "escribió por audio". Sin tope, un recordatorio del
// scheduler al día siguiente saldría como nota de voz solo porque el último
// mensaje del cliente, ayer, fue un audio.
export const VOICE_INBOUND_WINDOW_MS = 15 * 60 * 1000;

// Si ElevenLabs rechazó el formato opus (o devolvió algo que no es ogg), las
// llamadas siguientes van directo a mp3: reintentar opus cada vez sería pagar
// dos síntesis por mensaje.
let _opusUnavailable = false;

/**
 * ¿Están prendidas las respuestas por voz? Activas si hay clave de ElevenLabs;
 * VOICE_REPLIES=0 las apaga. En los tests nunca: el .env local puede traer la
 * clave real y un test no puede gastar síntesis (los que prueban la voz la
 * inyectan en createBotHelpers).
 */
export function isVoiceRepliesEnabled(): boolean {
    if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') return false;
    const flag = String(process.env.VOICE_REPLIES ?? '').trim().toLowerCase();
    // Apagado por defecto: hay que prenderlo con VOICE_REPLIES=1. Lo que no se
    // pudo probar sin producción (que WhatsApp muestre el audio como nota de
    // voz, y que el eco del audio se reconozca como del bot y no pause el chat)
    // conviene verlo con alguien mirando los logs, no en el primer deploy.
    if (!['1', 'true', 'on', 'si', 'sí'].includes(flag)) return false;
    return !!process.env.ELEVENLABS_API_KEY && !!process.env.ELEVENLABS_VOICE_ID;
}

/**
 * Grupo del A/B: hash del teléfono, mitad y mitad. Determinístico para que el
 * mismo cliente caiga siempre del mismo lado aunque se le borre el estado.
 */
export function voiceGroupFor(phone: string): VoiceGroup {
    const digest = crypto.createHash('sha256').update(`voice-ab:${phone}`).digest();
    return (digest[0] & 1) === 0 ? 'voice' : 'text';
}

const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}️‍⃣]/gu;
const MONEY_RE = /\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/g;

/**
 * El texto como se le pasa al sintetizador: sin emojis ni marcas de formato de
 * WhatsApp, y con los montos escritos para que se lean como plata ("$47.000"
 * leído tal cual sale "cuarenta y siete punto cero cero cero").
 */
export function cleanTextForVoice(text: string): string {
    const cleaned = String(text ?? '')
        .replace(MONEY_RE, (_m, entero: string, centavos?: string) => {
            const pesos = entero.replace(/\./g, '');
            return centavos && Number(centavos) > 0 ? `${pesos} pesos con ${centavos}` : `${pesos} pesos`;
        })
        .replace(EMOJI_RE, '')
        .replace(/[*~`_]/g, '');

    // Cada renglón termina en pausa: sin esto dos renglones cortos se leen de corrido.
    return cleaned
        .split(/\n+/)
        .map(l => l.replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim())
        .filter(l => /[\p{L}\p{N}]/u.test(l))
        .map(l => (/[.!?:,;…]$/.test(l) ? l : `${l}.`))
        .join(' ');
}

/**
 * ¿Este texto se puede decir en una nota de voz? No cuando es largo, trae algo
 * que el cliente necesita LEER o copiar (links, alias, mails, números largos
 * como un CBU o un código de seguimiento), varios precios para comparar, o un
 * menú/lista. Ante la duda, texto.
 */
export function isVoiceFriendly(text: string): boolean {
    const raw = String(text ?? '').trim();
    if (!raw || raw.length > VOICE_MAX_CHARS) return false;
    // Links, y cualquier "palabra.palabra" pegada (dominios, alias de transferencia) o mail.
    if (/https?:\/\/|www\.|wa\.me|\p{L}\.\p{L}|@/iu.test(raw)) return false;
    if ((raw.match(/\$\s?\d/g) || []).length > 2) return false;
    if (/\d{7,}/.test(raw)) return false;
    // Menús con teclas numeradas (1️⃣) o viñetas.
    if (/\d️?⃣|[🔹🔸🔺🔻▪▫•◦‣●]/u.test(raw)) return false;
    const listLines = raw.split('\n').filter(l => /^\s*(?:[-–—*]\s+\S|\d{1,2}[.)]\s+\S)/.test(l));
    if (listLines.length >= 2) return false;
    // Solo emojis o signos: no hay nada que decir.
    return (cleanTextForVoice(raw).match(/\p{L}/gu) || []).length >= 2;
}

/** ogg/opus o mp3 según los primeros bytes; null si no es ninguno de los dos. */
function sniffMimetype(buf: Buffer): string | null {
    if (buf.length < 4) return null;
    if (buf.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg; codecs=opus';
    if (buf.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    return null;
}

/** Una llamada a ElevenLabs. `formatProblem` = el problema fue el formato, no la cuenta ni la red. */
async function requestTts(text: string, format: string, apiKey: string, voiceId: string, signal: AbortSignal): Promise<{ audio: VoiceAudio | null; formatProblem: boolean }> {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${format}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: TTS_MODEL }),
        signal,
    });
    if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        logger.warn(`[TTS] ElevenLabs respondió ${res.status} (formato ${format}): ${detail}`);
        // 400/422 = no le gustó el pedido (típicamente el formato); 401/429/5xx no se arreglan cambiando de formato.
        return { audio: null, formatProblem: res.status === 400 || res.status === 422 };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mimetype = sniffMimetype(buf);
    if (!mimetype) {
        logger.warn(`[TTS] ElevenLabs devolvió ${buf.length} bytes que no son ogg ni mp3 (formato ${format})`);
        return { audio: null, formatProblem: true };
    }
    return { audio: { base64: buf.toString('base64'), mimetype }, formatProblem: false };
}

/**
 * Sintetiza `text` con la voz configurada. Devuelve null si falta la clave o la
 * voz, si el texto queda vacío al limpiarlo, o ante cualquier falla (red,
 * timeout de 15 s, saldo, formato): el que llama manda el texto escrito.
 */
export async function synthesizeVoice(text: string): Promise<VoiceAudio | null> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!apiKey || !voiceId) return null;

    const spoken = cleanTextForVoice(text);
    if (!spoken) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
    try {
        if (!_opusUnavailable) {
            const opus = await requestTts(spoken, FORMAT_OPUS, apiKey, voiceId, controller.signal);
            if (opus.audio) return opus.audio;
            if (!opus.formatProblem) return null;
            _opusUnavailable = true;
            logger.warn('[TTS] ogg/opus no disponible: de acá en más se pide mp3');
        }
        const mp3 = await requestTts(spoken, FORMAT_MP3, apiKey, voiceId, controller.signal);
        return mp3.audio;
    } catch (e: any) {
        logger.warn(`[TTS] Síntesis falló (${e?.name === 'AbortError' ? `timeout ${TTS_TIMEOUT_MS} ms` : e?.message})`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Solo para tests: olvida que opus no estaba disponible. */
export function _resetTtsForTests(): void {
    _opusUnavailable = false;
}
