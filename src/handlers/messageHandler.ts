/**
 * messageHandler.ts
 * Per-seller WhatsApp message handler factory.
 * Replaces the single `client.on('message', ...)` handler in index.ts.
 */

import * as steps from './incomingSteps';
import type { HandlerRuntime } from './incomingSteps';
const logger = require('../utils/logger');
const { _cleanPhone, _isAdminPhone } = require('../flows/utils/flowHelpers');


export interface MessageHandlerContext {
    sellerId: string;
    client: any;
    sharedState: any;
    userState: any;
    config: any;
    pausedUsers: Set<string>;
    pendingMessages: Map<string, { messages: { text: string; timestamp: number }[]; timer: ReturnType<typeof setTimeout>; startTime: number }>;
    botQueue: any;      // BullMQ Queue for this seller
    logAndEmit: (chatId: string, sender: string, text: string, step?: string, messageId?: string | null, overrideTimestamp?: number) => void;
    notifyAdmin: (reason: string, userPhone: string, details?: string | null) => Promise<any>;
    handleAdminCommand: (targetChatId: string | null, commandText: string, isApi?: boolean, alertSelector?: string | null) => Promise<any>;
    saveState: (userId?: string | null) => void;
    knowledge: any;     // Getter: current active knowledge
    dataDir: string;    // For audio file storage
}

/**
 * El recorrido de cada mensaje entrante de un seller.
 *
 * Era una sola función de ~360 líneas. Los pasos viven en incomingSteps.ts con
 * los cuerpos movidos tal cual; acá queda el orden, que es lo que importa leer.
 * tests/message_handler.test.js fija el comportamiento: se escribió contra la
 * versión anterior y da la misma traza de efectos contra esta.
 */
export function createMessageHandler(ctx: MessageHandlerContext): (msg: any) => Promise<void> {
    const {
        sellerId, client, sharedState, userState, config, pausedUsers, pendingMessages,
        botQueue, logAndEmit, notifyAdmin, handleAdminCommand, saveState, dataDir
    } = ctx;

    // El contexto del seller más el estado propio de este handler: los
    // throttles de avisos al admin, que viven lo que vive el handler.
    const rt: HandlerRuntime = {
        sellerId, client, sharedState, userState, config, pausedUsers, pendingMessages,
        botQueue, logAndEmit, notifyAdmin, handleAdminCommand, saveState, dataDir,
        lastPausedUserAlerts: new Map<string, number>(),
        lastLostMsgAlerts: new Map<string, number>(),
    };

    return async function messageHandler(msg: any): Promise<void> {
        try {
            // 1. Lo que no es una conversación, o ya se procesó.
            if (steps.isNotAConversation(msg, rt)) return;
            if (await steps.isDuplicateDelivery(msg, rt)) return;
            const chat = await msg.getChat();
            if (chat.isGroup) return; // Belt-and-suspenders

            // 2. Quién escribe.
            const userId = await steps.resolveUserId(msg, rt);
            const isAdmin = msg.fromMe || _isAdminPhone(userId, config.alertNumbers);
            let msgText = steps.normalizeBody(msg.body);

            // 3. El admin da órdenes: no entra al flujo de ventas.
            if (isAdmin) return await steps.handleAdminMessage(msg, userId, msgText, rt);

            // 4. Audio, imagen o documento: se registran, y pueden cortar acá
            //    (comprobante, sticker, audio ilegible) o convertirse en texto.
            const content = await steps.handleNonTextContent(msg, userId, msgText, rt);
            if (content === null) return;
            msgText = content;

            // 5. Sin texto: clic en un anuncio, evento de sistema o algo ilegible.
            if (!msgText || msgText.trim() === '') {
                const fromEmpty = await steps.handleEmptyMessage(msg, userId, rt);
                if (fromEmpty === null) return;
                msgText = fromEmpty;
            }

            // 6. Al chat del panel (audio e imagen ya se registraron en el paso 4).
            if (msg.type !== 'ptt' && msg.type !== 'audio' && msg.type !== 'image') {
                logAndEmit(userId, 'user', msgText, userState[userId]?.step || 'new');
            }

            // 7. Pausas: global y por cliente.
            if (config.globalPause && !isAdmin) {
                logger.info(`[PAUSED-GLOBAL][${sellerId}] Ignoring ${userId}`);
                return;
            }
            if (steps.handlePausedUser(msg, userId, msgText, rt)) return;

            // 8. A la cola: el flujo procesa todo junto cuando el cliente deja de escribir.
            steps.enqueueDebounced(msg, userId, msgText, rt);
        } catch (err: any) {
            // Un throw acá = un mensaje de un cliente que se perdió entero. El log
            // decía solo "Error: r" (error minificado del Chromium del agente), sin
            // decir de quién era: imposible de rastrear. Ahora identifica el chat y
            // le avisa al admin para que pueda contestar a mano.
            const preview = (msg?.body || '').slice(0, 80);
            logger.error(`[MESSAGE-HANDLER][${sellerId}] Error procesando msg de ${msg?.from} (type=${msg?.type}, body="${preview}"): ${err.message}`);
            try {
                if (msg?.from && !msg.fromMe && steps.shouldAlertLost(msg.from, rt)) {
                    await notifyAdmin('⚠️ Mensaje perdido', msg.from, `El bot falló al procesar un mensaje de este cliente y NO le respondió.\n\nTipo: ${msg.type}\nTexto: "${preview}"\nError: ${err.message}\n\nContestale a mano.`);
                }
            } catch { /* noop: si el cliente de WA está roto, el aviso tampoco sale */ }
        }
    };
}

/** Un envío del bot, para reconocer su eco. */
interface BotSend {
    chatId: string;
    text: string;
    media: boolean;
    /** Cuándo se llamó a sendMessage. */
    at: number;
    /** Cuándo volvió (con o sin id). Mientras no vuelve, el eco todavía está por llegar. */
    settledAt?: number;
}

/** Lo que mandó el bot, para no confundirlo con lo que el vendedor escribe a mano. */
export interface BotSends {
    /** Ids confirmados de los envíos del bot (se olvidan a los 30 s). */
    ids: Set<string>;
    /** Envíos del bot que todavía no volvieron con su id. */
    pending: Set<Promise<unknown>>;
    /** Qué mandó el bot a cada chat, mientras sirva para reconocer su eco. */
    recent: BotSend[];
}

const BOT_SEND_ID_TTL_MS = 30000;
// Cuánto sigue sirviendo un envío YA confirmado para reconocer su eco.
const BOT_SEND_RECENT_MS = 60000;
// Tope para uno que nunca volvió (una imagen pesada tarda, pero no diez minutos).
const BOT_SEND_MAX_PENDING_MS = 600000;
// Tope de la espera a los envíos en curso: un RPC colgado (30 s de timeout en
// remoto) no puede demorar tanto el registro y la pausa de un mensaje manual.
const PENDING_SEND_WAIT_MS = 10000;

/**
 * Un envío sirve para reconocer su eco mientras no volvió — el eco llega ANTES
 * que el ack, y un envío lento puede tardar más de un minuto — y hasta un minuto
 * después de haber vuelto.
 */
function _isLiveSend(s: BotSend, now: number): boolean {
    return s.settledAt === undefined
        ? now - s.at < BOT_SEND_MAX_PENDING_MS
        : now - s.settledAt < BOT_SEND_RECENT_MS;
}

/**
 * Envuelve client.sendMessage para anotar todo lo que manda el bot: flujo,
 * panel, comandos y avisos al admin pasan por ahí. Lo usa
 * createOutgoingMessageHandler para reconocer los ecos.
 */
export function trackBotSends(client: any): BotSends {
    const sends: BotSends = { ids: new Set(), pending: new Set(), recent: [] };
    const send = client.sendMessage.bind(client);
    client.sendMessage = function (...args: any[]) {
        const [chatId, content, options] = args;
        const now = Date.now();
        const media = !!content && typeof content === 'object';
        const entry: BotSend = { chatId, text: media ? (options?.caption || '') : String(content ?? ''), media, at: now };
        sends.recent = sends.recent.filter(s => _isLiveSend(s, now));
        sends.recent.push(entry);

        const sending = (async () => {
            const result = await send(...args);
            const id = result?.id?._serialized;
            if (id) {
                sends.ids.add(id);
                setTimeout(() => sends.ids.delete(id), BOT_SEND_ID_TTL_MS);
            }
            return result;
        })();
        sends.pending.add(sending);
        const settled = () => { sends.pending.delete(sending); entry.settledAt = Date.now(); };
        sending.then(settled, settled);
        return sending;
    };
    return sends;
}

/** Espera a que terminen los envíos del bot en curso, con tope. */
async function waitForBotSends(sends: BotSends): Promise<void> {
    if (!sends.pending.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        Promise.allSettled([...sends.pending]),
        new Promise(r => { timer = setTimeout(r, PENDING_SEND_WAIT_MS); }),
    ]);
    clearTimeout(timer);
}

const _sameText = (a: any, b: any) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();

/** ¿Este mensaje es el eco de algo que el bot le mandó a este chat? */
function isRecentBotSend(sends: BotSends, chatIds: string[], msg: any): boolean {
    const now = Date.now();
    const phones = chatIds.map(id => _cleanPhone(id));
    return sends.recent.some(s => _isLiveSend(s, now)
        && phones.includes(_cleanPhone(s.chatId))
        && s.media === !!msg.hasMedia
        && _sameText(s.text, msg.body));
}

/**
 * createOutgoingMessageHandler
 *
 * Listener para `client.on('message_create')` — captura mensajes salientes
 * (fromMe=true) que el `'message'` event NO emite. Cubre dos escenarios
 * cuando el admin escribe MANUALMENTE desde el WhatsApp del bot:
 *   1. Chat nuevo → pausar al cliente para que el bot no dispare la
 *      bienvenida cuando responda (persistido a DB).
 *   2. Cualquier chat con alertas pendientes → descartarlas. Si el admin
 *      contestó, ya vio la notificación; mantenerla en cola es ruido.
 *
 * Distinguir bot vs admin: lo que manda el bot también vuelve acá, y se
 * reconoce con lo que anotó trackBotSends (ver los dos resguardos abajo).
 *
 * Cubierto por tests/manual_chat.test.js.
 */
export function createOutgoingMessageHandler(ctx: {
    sellerId: string;
    client: any;
    userState: any;
    pausedUsers: Set<string>;
    sharedState: any;
    botSends: BotSends;
    logAndEmit: (chatId: string, sender: string, text: string, step?: string, messageId?: string | null, overrideTimestamp?: number) => void;
}): (msg: any) => Promise<void> {
    const { sellerId, client, userState, pausedUsers, sharedState, botSends, logAndEmit } = ctx;
    const { dismissAlertsForUser } = require('../services/adminService');

    return async function outgoingHandler(msg: any): Promise<void> {
        try {
            // Solo nos interesan outgoing messages a chats individuales. WhatsApp
            // arma el mensaje con `to: chat.id`, así que en los chats migrados a
            // @lid el destino llega como <lid>@lid (se resuelve más abajo). Hasta
            // el 2026-09-17 acá se exigía @c.us, y todo lo que el vendedor
            // escribía a mano en esos chats se perdía: ni ChatLog ni pausa.
            if (!msg.fromMe) return;
            if (!msg.to || typeof msg.to !== 'string') return;
            if (!msg.to.endsWith('@c.us') && !msg.to.endsWith('@lid')) return;

            // Skip si la conexión recién se inició (mensajes históricos).
            if (sharedState.connectedAt && msg.timestamp && msg.timestamp < sharedState.connectedAt) return;

            // Lo que manda el bot vuelve acá como mensaje propio, y su id se
            // conoce recién cuando termina el envío. En remoto el eco puede llegar
            // ANTES que ese ack: acá se esperaban 100 ms fijos, y el 17-sep el eco
            // del saludo les ganó y el chat quedó pausado como si lo hubiera
            // escrito el vendedor. Se espera a que terminen los envíos en curso.
            await waitForBotSends(botSends);
            const msgId = msg.id?._serialized;
            if (msgId && botSends.ids.has(msgId)) return;

            // El chat bajo el mismo id que usa el entrante para este cliente (su
            // userState, su pausa, su ChatLog): el @lid, resuelto al teléfono.
            // Recién acá, con los ecos del bot ya descartados, para no gastar un
            // RPC al agente por cada mensaje que manda el bot. msg.getContact()
            // no sirve: en un mensaje propio es el contacto del vendedor.
            const targetId = await steps.resolveUserIdFrom(msg.to, () => client.getContactById(msg.to), sellerId);

            // Resguardo que no depende del id: lo que el bot le mandó a este chat
            // es su eco. En remoto este es el camino NORMAL, no la excepción: al
            // mandar a <telefono>@c.us un chat que WhatsApp guarda bajo @lid, el
            // sendMessage de wwebjs devuelve undefined (busca el mensaje por una
            // clave con el teléfono), el agente ackea sin id y RemoteClient le
            // inventa un `remote_<ts>` que no cruza con nada. Medido en prod el
            // 17-sep: 20 de 20 ecos reconocidos por acá, ninguno por el id.
            if (isRecentBotSend(botSends, [msg.to, targetId], msg)) {
                logger.info(`[MANUAL-CHAT][${sellerId}] Eco de un envío del bot a ${targetId} (ack sin id que cruce: ${msgId}) — no es manual`);
                return;
            }

            // Registrar el mensaje manual del admin (escrito desde el teléfono del
            // bot) en el historial + emitirlo al dashboard en tiempo real. Antes NO
            // se registraba: solo se veía si el fetch en vivo de WhatsApp respondía
            // al abrir el chat, y si caía al fallback de DB no aparecía (reporte de
            // horacio: "lo que mando desde el móvil no se refleja"). Se loguea como
            // 'admin'. El de-dup de /history (sameRole + body + 60s) evita duplicar
            // con el mensaje que igual trae el fetch en vivo de WhatsApp.
            try {
                let logText = (msg.body || '').trim();
                if (!logText && msg.hasMedia) {
                    if (msg.type === 'image' || msg.type === 'sticker') logText = '📷 Imagen enviada';
                    else if (msg.type === 'audio' || msg.type === 'ptt') logText = '🎤 Audio enviado';
                    else if (msg.type === 'document') logText = '📄 Documento enviado';
                    else logText = '[archivo enviado]';
                }
                // Hora REAL de envío del dispositivo (msg.timestamp viene en
                // segundos desde whatsapp-web.js). Sin esto el mensaje manual se
                // registraba con la hora del handler (con la latencia del bridge
                // Puppeteer + los 100ms de defer de arriba), y se intercalaba mal
                // con los mensajes del bot → un correctivo escrito a mano podía
                // aparecer DEBAJO del mensaje del bot al que respondía.
                const deviceTs = (typeof msg.timestamp === 'number' && msg.timestamp > 0) ? msg.timestamp * 1000 : undefined;
                if (logText) logAndEmit(targetId, 'admin', logText, userState[targetId]?.step, msgId, deviceTs);
            } catch (e: any) {
                logger.warn(`[MANUAL-CHAT][${sellerId}] No se pudo registrar mensaje manual a ${targetId}: ${e?.message}`);
            }

            // Admin contestó manualmente → descartar cualquier alerta pendiente
            // de este usuario. Si tomó acción, ya vio la notificación.
            try {
                const hadAlert = (sharedState.sessionAlerts || []).some((a: any) => a.userPhone === targetId);
                if (hadAlert) {
                    dismissAlertsForUser(targetId, sharedState);
                    logger.info(`[MANUAL-CHAT][${sellerId}] Alertas de ${targetId} descartadas — admin respondió manualmente`);
                }
            } catch (e: any) {
                logger.warn(`[MANUAL-CHAT][${sellerId}] Failed to dismiss alerts for ${targetId}: ${e?.message}`);
            }

            // Traspaso por chat: si el vendedor respondió a mano, el bot le CEDE
            // esa conversación (la pausa) para no pisarlo. Aplica a chats nuevos
            // iniciados por él Y a chats que el bot venía atendiendo — antes solo
            // se pausaban los nuevos y el bot seguía pisando los activos (reporte
            // de horacio). Las pausas NO se auto-liberan: si quiere que el bot
            // retome, se despausa a mano desde el panel.
            if (pausedUsers.has(targetId)) return; // ya pausado, nada que hacer
            const wasBotActive = !!userState[targetId];
            pausedUsers.add(targetId);
            try {
                const { prisma } = require('../../db');
                const cleanPhone = _cleanPhone(targetId);
                const reason = wasBotActive
                    ? 'Vendedor tomó la conversación a mano (bot en pausa para no pisar)'
                    : 'Conversación iniciada manualmente por admin desde WhatsApp';
                await prisma.user.upsert({
                    where: { phone_instanceId: { phone: cleanPhone, instanceId: sellerId } },
                    update: { pausedAt: new Date(), pauseReason: reason },
                    create: { phone: cleanPhone, instanceId: sellerId, pausedAt: new Date(), pauseReason: reason },
                });
            } catch (err: any) {
                if (err?.code !== 'P2002') {
                    logger.warn(`[MANUAL-CHAT][${sellerId}] Failed to persist pause for ${targetId}: ${err?.message}`);
                }
            }
            logger.info(`[MANUAL-CHAT][${sellerId}] Vendedor respondió a mano a ${targetId} — chat pausado (bot cede)${wasBotActive ? ' [tomó charla activa]' : ' [chat nuevo]'}`);
        } catch (err: any) {
            logger.error(`[OUTGOING-HANDLER][${sellerId}] Error: ${err?.message}`);
        }
    };
}
