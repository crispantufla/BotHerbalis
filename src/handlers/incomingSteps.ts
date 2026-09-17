/**
 * incomingSteps.ts — los pasos de un mensaje entrante.
 *
 * createMessageHandler (messageHandler.ts) era una sola función de ~360 líneas:
 * la puerta de entrada de cada mensaje de cada cliente, con todo en fila. Acá
 * están sus pasos, cada uno con su nombre y con los cuerpos movidos tal cual;
 * messageHandler.ts quedó con el orden, que es lo que importa leer.
 *
 * El comportamiento lo fija tests/message_handler.test.js: se escribió contra la
 * versión anterior y da la misma traza de efectos contra esta.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { MessageHandlerContext } from './messageHandler';
const logger = require('../utils/logger');
const { parseAdminInput } = require('../services/adminService');
const { aiService } = require('../services/ai');
const { redisConnection } = require('../services/queueService');
const { _isAdminPhone, _setStep } = require('../flows/utils/flowHelpers');

const DEBOUNCE_MS = 10000;

// Eventos que WhatsApp emite por el mismo canal que los mensajes pero que NO
// son una persona escribiendo (rotación de claves, cambios de grupo, llamadas,
// mensajes borrados o todavía sin desencriptar). No hay nada que contestar y no
// deben ensuciar el chat del dashboard: se descartan, pero CON log.
const WA_SYSTEM_TYPES = new Set([
    'e2e_notification', 'notification', 'notification_template', 'protocol',
    'gp2', 'group_notification', 'ciphertext', 'revoked', 'call_log'
]);

/** Lo que usan los pasos: el contexto del seller más el estado propio del handler. */
export type HandlerRuntime = Pick<MessageHandlerContext,
    'sellerId' | 'client' | 'sharedState' | 'userState' | 'config' | 'pausedUsers' | 'pendingMessages'
    | 'botQueue' | 'logAndEmit' | 'notifyAdmin' | 'handleAdminCommand' | 'saveState' | 'dataDir'> & {
    /** Último aviso "cliente en pausa te escribió", por cliente. */
    lastPausedUserAlerts: Map<string, number>;
    /** Último aviso "no pude procesar/leer este mensaje", por cliente. */
    lastLostMsgAlerts: Map<string, number>;
};

// Los pasos 4 y 5 devuelven el texto con el que sigue el mensaje, o null si el
// mensaje termina ahí (se registró y listo, o era un comprobante).

// Avisos de "no pude procesar este mensaje". Throttle por cliente igual que
// lastPausedUserAlerts: si el Chromium del agente se rompe, TODOS los
// mensajes fallan y sin esto el admin recibiría cientos de avisos.
export function shouldAlertLost(id: string, rt: HandlerRuntime): boolean {
    const now = Date.now();
    if (now - (rt.lastLostMsgAlerts.get(id) || 0) < 30 * 60 * 1000) return false;
    rt.lastLostMsgAlerts.set(id, now);
    return true;
}

// ── 1. descartes ────────────────────────────────────────────────

/** Estados, grupos, broadcasts y mensajes anteriores a la conexión: nada que contestar. */
export function isNotAConversation(msg: any, rt: HandlerRuntime): boolean {
    const { sellerId, sharedState } = rt;
    if (msg.from === 'status@broadcast') return true;
    // Short-circuit groups/broadcast before Puppeteer bridge call (avoids expensive getChat)
    if (msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) return true;
    if (sharedState.connectedAt && msg.timestamp && msg.timestamp < sharedState.connectedAt) {
        // Antes esto descartaba SIN log — durante un flap del agente, los
        // mensajes reentregados de la ventana caída desaparecían sin rastro.
        logger.info(`[SKIP-OLD][${sellerId}] msg de ${msg.from} (ts=${msg.timestamp} < connectedAt=${sharedState.connectedAt}) — ignorado como historial`);
        return true;
    }
    return false;
}

/** true si este mismo mensaje físico ya se tomó (reentrega, doble bot). */
export async function isDuplicateDelivery(msg: any, rt: HandlerRuntime): Promise<boolean> {
    const { sellerId } = rt;
    // Idempotencia (caso doble-bot / reentrega del mismo mensaje físico): si
    // este id ya fue tomado (Redis compartido), lo descartamos ACÁ — ANTES de
    // gastar los RPCs getChat()/getContact() al agente (en remoto la reentrega
    // disparaba 2-3 getContact por mensaje, ver [ID-RESOLVE] repetidos). El id
    // de WhatsApp es el mismo en cloud y remoto. Fail-open: si Redis falla, sigo.
    // Solo dedupear con un id string REAL: agentes viejos serializaban un
    // MessageId sin _serialized como "[object Object]" — todos esos mensajes
    // colisionaban en la MISMA key de Redis y se descartaban entre sí (mensajes
    // nuevos y distintos sin responder, 20-jul-2026). Ante id inutilizable,
    // mejor sin dedup que mudo.
    const _rawMsgId = typeof msg.id?._serialized === 'string' ? msg.id._serialized : null;
    if (_rawMsgId && !_rawMsgId.startsWith('remote_') && _rawMsgId !== '[object Object]') {
        try {
            const seen = await redisConnection.set(`msgseen:${sellerId}:${_rawMsgId}`, '1', 'EX', 600, 'NX');
            if (seen === null) {
                logger.warn(`[DEDUP][${sellerId}] msg ${_rawMsgId} ya procesado/reentregado — descarto`);
                return true;
            }
        } catch (e: any) {
            logger.warn(`[DEDUP][${sellerId}] Redis no disponible (${e.message}) — sigo sin dedup`);
        }
    }
    return false;
}

// ── 2. quién escribe ────────────────────────────────────────────

/** El id del chat, con los @lid y los ids de proxy resueltos al teléfono real. */
export async function resolveUserId(msg: any, rt: HandlerRuntime): Promise<string> {
    return resolveUserIdFrom(msg.from, () => msg.getContact(), rt.sellerId);
}

/**
 * resolveUserId para cualquier id de chat. La usa también lo que el vendedor
 * escribe a mano (createOutgoingMessageHandler, con msg.to): el mensaje del
 * cliente y la respuesta del vendedor tienen que caer en la misma conversación.
 */
export async function resolveUserIdFrom(rawId: string, getContact: () => Promise<any>, sellerId: string): Promise<string> {
    let userId = rawId;

    // Resolve Meta @lid / proxy identifiers to real phone numbers — con
    // resolución PEGAJOSA en Redis. getContact() es best-effort: puede
    // resolver en un mensaje y FALLAR en el siguiente, lo que partía al
    // MISMO cliente en DOS conversaciones (@lid y @c.us) con userState
    // divergente → dos respuestas contradictorias y link con producto
    // equivocado (caso real 1131381951, 2026-06-19). Con la cache, una vez
    // que el @lid se resolvió a un teléfono, TODOS los mensajes siguientes
    // mapean al mismo userId aunque getContact vuelva a fallar.
    if (userId.includes('@lid') || userId.length > 18) {
        const stickyKey = `lidmap:${sellerId}:${rawId}`;
        let resolved: string | null = null;
        try {
            const contact = await getContact();
            if (userId.includes('@lid')) {
                if (contact && contact.number) resolved = `${contact.number}@c.us`;
            } else {
                const cleanName = (contact?.name || contact?.pushname || '').replace(/\D/g, '');
                if (cleanName.length >= 10 && cleanName.length <= 13) resolved = `${cleanName}@c.us`;
            }
        } catch (e: any) {
            logger.warn(`[ID-RESOLVE][${sellerId}] getContact falló para ${rawId}: ${e.message}`);
        }
        if (resolved) {
            userId = resolved;
            logger.info(`[ID-RESOLVE][${sellerId}] ${rawId} → ${userId}`);
            try { await redisConnection.set(stickyKey, userId, 'EX', 604800); } catch { /* noop */ }
        } else {
            // No se pudo resolver ahora → reusar la última resolución conocida
            // para no abrir una segunda conversación bajo el id crudo.
            try {
                const cached = await redisConnection.get(stickyKey);
                if (cached) {
                    userId = cached;
                    logger.info(`[ID-STICKY][${sellerId}] ${rawId} → ${userId} (cache)`);
                }
            } catch { /* noop */ }
        }
    }
    return userId;
}

/** El texto del mensaje, sin espacios en los bordes. */
export function normalizeBody(body: any): string {
    let msgText = (body || '').trim();

    // WhatsApp placeholder fix
    const WA_PLACEHOLDERS = ['esperando el mensaje', 'waiting for this message', 'este mensaje estaba esperando', 'this message was waiting'];
    if (WA_PLACEHOLDERS.some(p => msgText.toLowerCase().includes(p))) {
        msgText = 'Hola';
    }
    return msgText;
}

// ── 3. el admin ─────────────────────────────────────────────────

/** Comandos del admin: por audio (se transcribe) o por texto. Nunca entran al flujo de ventas. */
export async function handleAdminMessage(msg: any, userId: string, msgText: string, rt: HandlerRuntime): Promise<void> {
    const { sellerId, client, sharedState, userState, handleAdminCommand, saveState } = rt;

    if (msg.type === 'ptt' || msg.type === 'audio') {
        const media = await msg.downloadMedia();
        if (media) {
            const transcription = await aiService.transcribeAudio(media.data, media.mimetype);
            if (transcription) {
                const { selector, command } = parseAdminInput(transcription);
                const result = await handleAdminCommand(null, command, false, selector);
                if (result) await client.sendMessage(msg.from, result);
            }
        }
        return;
    }
    if (!msgText) return;
    logger.info(`[ADMIN][${sellerId}] ${userId}: ${msgText}`);

    if (msgText.toLowerCase().startsWith('!saltear ')) {
        const parts = msgText.split(' ');
        const targetNumber = parts[1];
        const targetChatId = targetNumber.includes('@') ? targetNumber : `${targetNumber.replace(/\D/g, '')}@c.us`;
        if (!userState[targetChatId]) userState[targetChatId] = { step: 'greeting', partialAddress: {}, history: [] };
        // Usamos _setStep para mantener tracking de funnel + reset de flags.
        // V3/V4 tenían knowledge.flow.data_request; V5/V6 lo renombraron a
        // flow.closing (que también pide datos para la etiqueta). Si ninguno
        // existe, fallback a un mensaje fijo equivalente.
        _setStep(userState[targetChatId], 'waiting_data');
        saveState();
        const knowledge = sharedState.knowledge;
        const dataMsg = knowledge?.flow?.closing?.response
            || knowledge?.flow?.data_request?.response
            || '¡Dale! Pasame los datos para la etiqueta:\n\nNombre completo:\nCalle y número:\nLocalidad:\nCódigo postal:';
        await client.sendMessage(targetChatId, dataMsg);
        await client.sendMessage(msg.from, `✅ Usuario ${targetNumber} forzado a waiting_data.`);
        return;
    }

    if (msgText.toLowerCase() === '!ayuda') {
        const helpPart1 = `📋 *Comandos disponibles (1/2):*\n\n*Alertas y pedidos:*\n• !alertas — Cola de alertas activas\n• 1 ok / 2 dale — Confirmar pedido por #\n• 1 me encargo — Tomar control de cliente\n• 1r1 / 1r2 / 1r3 — Respuesta rápida a alerta\n• !pedidos — Últimos 5 pedidos\n• !pedido [tel] — Pedidos de un cliente\n• !tracking [tel] [cod] — Cargar código seguimiento\n\n*Clientes:*\n• !pausados — Ver clientes pausados\n• !despauser [tel] — Reactivar bot para cliente\n• !reset [tel] — Reiniciar estado de cliente\n• !historial [tel] — Resumen IA del chat\n• !enviar [tel] [msg] — Mensaje directo`;
        const helpPart2 = `📋 *Comandos (2/2):*\n\n*Analytics:*\n• !funnel — Embudo de ventas paso a paso\n• !abandonos — Motivos de abandono + A/B testing\n\n*Sistema:*\n• !status — Estado del bot\n• !stats — Ventas y métricas del día\n• !pausa-global on/off — Pausar todo el bot\n• !precios — Ver precios actuales\n• !script — Ver script activo (v7)\n• !admin add/remove [tel] — Gestionar admins\n\n*Otros:*\n• !resumen — Reporte diario\n• !saltear [tel] — Forzar paso de usuario\n• [texto libre] — Instrucción IA al cliente\n• !ayuda — Este menú`;
        await client.sendMessage(msg.from, helpPart1);
        await client.sendMessage(msg.from, helpPart2);
        return;
    }

    const { selector, command } = parseAdminInput(msgText);
    const result = await handleAdminCommand(null, command, false, selector);
    if (result) await client.sendMessage(msg.from, result);
}

// ── 4. audio, imagen, documento ─────────────────────────────────

/**
 * Audio, imagen/sticker o documento del cliente. Cada uno se registra en el
 * chat del panel, y puede cortar el mensaje acá (comprobante de pago, sticker,
 * audio que no se pudo escuchar) o dejarlo seguir convertido en texto.
 */
export async function handleNonTextContent(msg: any, userId: string, msgText: string, rt: HandlerRuntime): Promise<string | null> {
    if (msg.type === 'ptt' || msg.type === 'audio') return handleClientAudio(msg, userId, rt);
    if (msg.type === 'image' || msg.type === 'sticker') return handleImageOrSticker(msg, userId, rt);
    if (msg.type === 'document') return handleDocument(msg, userId, rt);
    return msgText;
}

async function handleClientAudio(msg: any, userId: string, rt: HandlerRuntime): Promise<string | null> {
    const { sellerId, client, userState, logAndEmit, dataDir } = rt;

    // downloadMedia() es un RPC al Chromium del agente y puede tirar un
    // error minificado ("r"). Antes ese throw subía al catch global y el
    // audio se perdía ENTERO: sin ChatLog, sin aviso al admin y sin
    // respuesta al cliente — él veía "enviado" y en el panel el chat
    // quedaba vacío. Lo mismo pasaba con el `else { return }` mudo
    // cuando media venía null (reporte de horacio, varias veces al día).
    let media: any = null;
    try {
        media = await msg.downloadMedia();
    } catch (e: any) {
        logger.warn(`[AUDIO][${sellerId}] downloadMedia falló para ${userId}: ${e.message}`);
    }
    if (!media) {
        logAndEmit(userId, 'user', '🎤 Audio recibido (no se pudo descargar)', userState[userId]?.step || 'new');
        await client.sendMessage(userId, 'Disculpá, no pude escuchar bien el audio. ¿Me lo escribís?');
        return null;
    }

    // La URL sirve para reproducirlo en el dashboard; si el guardado en
    // disco falla igual seguimos con la transcripción (mejor un mensaje
    // sin audio adjunto que un mensaje perdido).
    let audioUrl: string | null = null;
    try {
        const audioDir = path.join(dataDir, '..', 'public', 'media', 'audio');
        await fs.promises.mkdir(audioDir, { recursive: true }).catch(() => {});
        const ext = media.mimetype?.includes('ogg') ? 'ogg' : 'mp3';
        // Nombre NO adivinable y SIN el teléfono: /media es estático
        // sin auth — con <telefono>_<ts>.ogg cualquiera podía enumerar
        // y bajar audios de clientes. La URL queda persistida en el
        // ChatLog (logAndEmit de abajo), así que la reproducción en el
        // dashboard sigue funcionando igual.
        const audioFilename = `aud_${Date.now()}_${crypto.randomUUID()}.${ext}`;
        await fs.promises.writeFile(path.join(audioDir, audioFilename), Buffer.from(media.data, 'base64'));
        audioUrl = `/media/audio/${audioFilename}`;
    } catch (e: any) {
        logger.warn(`[AUDIO][${sellerId}] no pude guardar el audio de ${userId}: ${e.message}`);
    }

    let transcription: string | null = null;
    try {
        transcription = await aiService.transcribeAudio(media.data, media.mimetype);
    } catch (e: any) {
        logger.warn(`[AUDIO][${sellerId}] transcripción falló para ${userId}: ${e.message}`);
    }

    const audioLog = audioUrl ? `MEDIA_AUDIO:${audioUrl}` : '🎤 Audio recibido';
    if (transcription) {
        logAndEmit(userId, 'user', `${audioLog}|TRANSCRIPTION:${transcription}`, userState[userId]?.step || 'new');
        return transcription;
    }
    logAndEmit(userId, 'user', audioLog, userState[userId]?.step || 'new');
    await client.sendMessage(userId, 'Disculpá, no pude escuchar bien el audio. ¿Me lo escribís?');
    return null;
}

async function handleImageOrSticker(msg: any, userId: string, rt: HandlerRuntime): Promise<string | null> {
    const { sharedState, client, userState, logAndEmit, notifyAdmin } = rt;

    logAndEmit(userId, 'user', `📷 ${msg.type === 'sticker' ? 'Sticker' : 'Imagen'} recibida${msg.body ? ': ' + msg.body : ''}`, userState[userId]?.step || 'new');
    // FIX (caso real Romina 19-may): si el cliente está en flujo de
    // pago (waiting_mp_payment o waiting_transfer_confirmation) y
    // manda una imagen, probablemente sea un comprobante. Pausar y
    // alertar al admin para verificación manual.
    const stepNow = userState[userId]?.step;
    if (msg.type === 'image' && (stepNow === 'waiting_mp_payment' || stepNow === 'waiting_transfer_confirmation')) {
        try {
            await client.sendMessage(userId, '¡Recibí la imagen del comprobante! 📸 Un asesor lo verifica enseguida y te confirma el envío.');
            const { pauseUser } = require('../services/pauseService');
            await pauseUser(userId, 'Cliente envió comprobante (imagen) durante pago. Verificación manual requerida.', { sharedState });
            await notifyAdmin('💸 Comprobante recibido (imagen)', userId, `Cliente mandó una imagen estando en ${stepNow}. Probable comprobante de pago — verificar y confirmar pedido.`);
        } catch (e: any) {
            logger.warn(`[COMPROBANTE-IMG] Error procesando imagen: ${e.message}`);
        }
        return null;
    }
    if (msg.type === 'image' && msg.body) {
        return `[Imagen enviada por el usuario] ${msg.body}`;
    }
    return null;
}

// Document/PDF — típicamente comprobante de pago. Si el cliente
// está en flujo de pago, pausamos y alertamos al admin para
// verificación manual. Sin esto, el bot le contestaba genérico y
// dejaba al cliente en limbo (caso real Romina 19-may).
async function handleDocument(msg: any, userId: string, rt: HandlerRuntime): Promise<string | null> {
    const { sharedState, client, userState, logAndEmit, notifyAdmin } = rt;

    const filename = (msg as any)._data?.filename || msg.body || 'documento.pdf';
    logAndEmit(userId, 'user', `📄 Documento recibido: ${filename}`, userState[userId]?.step || 'new');
    const stepNow = userState[userId]?.step;
    if (stepNow === 'waiting_mp_payment' || stepNow === 'waiting_transfer_confirmation') {
        try {
            await client.sendMessage(userId, '¡Recibí el comprobante! 📄 Un asesor lo verifica enseguida y te confirma el envío.');
            const { pauseUser } = require('../services/pauseService');
            await pauseUser(userId, 'Cliente envió comprobante (PDF) durante pago. Verificación manual requerida.', { sharedState });
            await notifyAdmin('💸 Comprobante recibido (PDF)', userId, `Cliente mandó "${filename}" estando en ${stepNow}. Verificar pago y confirmar pedido manualmente.`);
        } catch (e: any) {
            logger.warn(`[COMPROBANTE-DOC] Error procesando documento: ${e.message}`);
        }
        return null;
    }
    // Fuera de los steps de pago, ignoramos el documento (no
    // sabemos qué hacer con él) — el bot sigue con el flow normal.
    return null;
}

// ── 5. sin texto ────────────────────────────────────────────────

/** Mensaje sin texto: clic en un anuncio, evento de sistema de WhatsApp, o algo que el bot no sabe leer. */
export async function handleEmptyMessage(msg: any, userId: string, rt: HandlerRuntime): Promise<string | null> {
    const { sellerId, userState, logAndEmit, notifyAdmin } = rt;

    // 'e2e_notification' es una system event de WhatsApp (cambio de
    // clave de encriptación, re-instalación, nuevo dispositivo) que
    // NO es un mensaje del usuario. Si la trataramos como ad click,
    // gatillamos el saludo a clientes que nunca escribieron — este
    // bug causaba cross-talk cuando el cliente rotaba sus claves
    // mientras el bot tenía su contacto guardado.
    if (msg.type === 'chat' || msg.type === 'template_button_reply') {
        return 'Hola! (Vengo de un anuncio)';
    }
    if (WA_SYSTEM_TYPES.has(msg.type)) {
        logger.info(`[SKIP-SYSTEM][${sellerId}] evento '${msg.type}' de ${msg.from} — no es un mensaje, ignorado`);
        return null;
    }
    // Persona real mandando algo que el flujo no sabe leer (video,
    // ubicación, contacto, encuesta...). Antes salía por acá SIN
    // ninguna traza: ni log, ni ChatLog, ni aviso — el cliente veía
    // "enviado" y en el panel el chat aparecía vacío. Es el caso que
    // horacio reportaba varias veces al día. Ahora queda registrado
    // en el chat y se le avisa para que conteste a mano.
    logger.warn(`[MSG-UNSUPPORTED][${sellerId}] ${msg.from} mandó tipo '${msg.type}' sin texto — el bot no puede procesarlo`);
    logAndEmit(userId, 'user', `📎 Mensaje que el bot no puede leer (${msg.type})`, userState[userId]?.step || 'new');
    if (shouldAlertLost(userId, rt)) {
        await notifyAdmin('📎 Mensaje que el bot no puede leer', userId, `El cliente mandó un mensaje de tipo "${msg.type}" (sin texto). El bot no sabe interpretarlo y no le respondió — miralo en WhatsApp y contestale vos.`);
    }
    return null;
}

// ── 7. pausas ───────────────────────────────────────────────────

/**
 * Cliente pausado: no se encola, y se le avisa al admin como mucho una vez
 * cada 30 min. Devuelve true si el cliente estaba pausado.
 */
export function handlePausedUser(msg: any, userId: string, msgText: string, rt: HandlerRuntime): boolean {
    const { pausedUsers, pendingMessages, notifyAdmin, lastPausedUserAlerts } = rt;

    if (!(pausedUsers.has(userId) || (msg.from !== userId && pausedUsers.has(msg.from)))) return false;

    if (!pausedUsers.has(userId) && msg.from !== userId && pausedUsers.has(msg.from)) {
        pausedUsers.delete(msg.from);
        pausedUsers.add(userId);
    }
    const pendingEntry = pendingMessages.get(userId);
    if (pendingEntry) { clearTimeout(pendingEntry.timer); pendingMessages.delete(userId); }

    const now = Date.now();
    const lastAlert = lastPausedUserAlerts.get(userId) || 0;
    if (now - lastAlert > 30 * 60 * 1000) {
        lastPausedUserAlerts.set(userId, now);
        notifyAdmin('💬 Cliente en pausa te escribió', userId, `El cliente envió: "${msgText.substring(0, 100)}..."\n\nEl bot sigue pausado.`).catch(() => {});
    }
    return true;
}

// ── 8. debounce y cola ──────────────────────────────────────────

/** Acumula el mensaje y (re)arma el debounce: se procesa todo junto cuando el cliente deja de escribir. */
export function enqueueDebounced(msg: any, userId: string, msgText: string, rt: HandlerRuntime): void {
    const { userState, pendingMessages } = rt;

    let currentDelay = DEBOUNCE_MS;
    if (userState[userId]?.step === 'waiting_data') {
        currentDelay = 25000;
    }

    const msgObj = { text: msgText, timestamp: msg.timestamp || Math.floor(Date.now() / 1000) };

    if (pendingMessages.has(userId)) {
        const pending = pendingMessages.get(userId)!;
        pending.messages.push(msgObj);
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => processDebounced(userId, rt), currentDelay);
    } else {
        pendingMessages.set(userId, {
            messages: [msgObj],
            timer: setTimeout(() => processDebounced(userId, rt), currentDelay),
            startTime: Date.now()
        });
    }
}

/** Vence el debounce: junta los mensajes acumulados y los manda a la cola de BullMQ. */
export async function processDebounced(userId: string, rt: HandlerRuntime): Promise<void> {
    const { sellerId, userState, config, pausedUsers, pendingMessages, botQueue, saveState } = rt;

    const pending = pendingMessages.get(userId);
    if (!pending) return;

    const isAdminUser = _isAdminPhone(userId, config.alertNumbers);
    if (pausedUsers.has(userId) || (config.globalPause && !isAdminUser)) {
        logger.info(`[DEBOUNCE][${sellerId}] Skipping ${userId}: paused during debounce`);
        pendingMessages.delete(userId);
        return;
    }

    const sortedMessages = pending.messages.sort((a, b) => a.timestamp - b.timestamp);
    const combinedText = sortedMessages.map(m => m.text).join(' ');
    const startTime = pending.startTime;
    pendingMessages.delete(userId);

    logger.info(`[DEBOUNCE][${sellerId}] Processing ${sortedMessages.length} msg(s) from ${userId}: "${combinedText}"`);

    try {
        // V7 es el único script activo.
        const effectiveScript = 'v7';
        if (userState[userId] && userState[userId].assignedScript !== 'v7') {
            userState[userId].assignedScript = 'v7';
            saveState(userId);
        }

        await botQueue.add('process-message', { userId, combinedText, effectiveScript, startTime }, {
            removeOnComplete: true,
            removeOnFail: 100
        });
    } catch (err: any) {
        logger.error(`[DEBOUNCE][${sellerId}] Error:`, err.message);
    }
}
