/**
 * messageHandler.ts
 * Per-seller WhatsApp message handler factory.
 * Replaces the single `client.on('message', ...)` handler in index.ts.
 */

import fs from 'fs';
import path from 'path';
const logger = require('../utils/logger');
const { MessageMedia } = require('whatsapp-web.js');
const { aiService } = require('../services/ai');
const { parseAdminInput } = require('../services/adminService');

const DEBOUNCE_MS = 10000;

export interface MessageHandlerContext {
    sellerId: string;
    client: any;
    sharedState: any;
    userState: any;
    config: any;
    pausedUsers: Set<string>;
    pendingMessages: Map<string, { messages: { text: string; timestamp: number }[]; timer: ReturnType<typeof setTimeout>; startTime: number }>;
    botQueue: any;      // BullMQ Queue for this seller
    logAndEmit: (chatId: string, sender: string, text: string, step?: string, messageId?: string | null) => void;
    notifyAdmin: (reason: string, userPhone: string, details?: string | null) => Promise<any>;
    handleAdminCommand: (targetChatId: string | null, commandText: string, isApi?: boolean, alertSelector?: string | null) => Promise<any>;
    saveState: (userId?: string | null) => void;
    knowledge: any;     // Getter: current active knowledge
    dataDir: string;    // For audio file storage
}

export function createMessageHandler(ctx: MessageHandlerContext): (msg: any) => Promise<void> {
    const {
        sellerId, client, sharedState, userState, config, pausedUsers, pendingMessages,
        botQueue, logAndEmit, notifyAdmin, handleAdminCommand, saveState, dataDir
    } = ctx;

    const lastPausedUserAlerts = new Map<string, number>();

    async function _processDebounced(userId: string): Promise<void> {
        const pending = pendingMessages.get(userId);
        if (!pending) return;

        const alertNums = (config.alertNumbers || []).map((n: string) => n.replace(/\D/g, ''));
        const isAdminUser = alertNums.some((n: string) => userId.startsWith(n));
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
            // V7 es el único script activo (may-2026). v1..v6 + rotacion fueron archivados.
            // Si la DB devuelve un valor legacy, lo coercemos a v7.
            const legacyScripts = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'rotacion'];
            let effectiveScript = userState[userId]?.assignedScript;
            if (effectiveScript && legacyScripts.includes(effectiveScript)) {
                effectiveScript = 'v7';
                if (userState[userId]) {
                    userState[userId].assignedScript = effectiveScript;
                    saveState(userId);
                }
            }
            if (!effectiveScript) {
                effectiveScript = 'v7';
                if (userState[userId]) {
                    userState[userId].assignedScript = effectiveScript;
                    saveState(userId);
                }
            }

            await botQueue.add('process-message', { userId, combinedText, effectiveScript, startTime }, {
                removeOnComplete: true,
                removeOnFail: 100
            });
        } catch (err: any) {
            logger.error(`[DEBOUNCE][${sellerId}] Error:`, err.message);
        }
    }

    return async function messageHandler(msg: any): Promise<void> {
        try {
            if (msg.from === 'status@broadcast') return;
            // Short-circuit groups/broadcast before Puppeteer bridge call (avoids expensive getChat)
            if (msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) return;
            if (sharedState.connectedAt && msg.timestamp && msg.timestamp < sharedState.connectedAt) return;

            const chat = await msg.getChat();
            if (chat.isGroup) return; // Belt-and-suspenders

            let userId = msg.from;

            // Resolve Meta @lid identifiers to real phone numbers
            if (userId.includes('@lid')) {
                try {
                    const contact = await msg.getContact();
                    if (contact && contact.number) {
                        userId = `${contact.number}@c.us`;
                        logger.info(`[LID-RESOLVE][${sellerId}] ${msg.from} → ${userId}`);
                    }
                } catch (e: any) {
                    logger.error(`[LID-RESOLVE][${sellerId}] Error:`, e.message);
                }
            } else if (userId.length > 18) {
                try {
                    const contact = await msg.getContact();
                    const cleanName = (contact?.name || contact?.pushname || '').replace(/\D/g, '');
                    if (cleanName.length >= 10 && cleanName.length <= 13) {
                        userId = `${cleanName}@c.us`;
                        logger.info(`[PROXY-RESOLVE][${sellerId}] ${msg.from} → ${userId}`);
                    }
                } catch (e: any) { /* ignore */ }
            }

            const alertNumbers = (config.alertNumbers || []).map((n: string) => n.replace(/\D/g, ''));
            const isAdmin = msg.fromMe || alertNumbers.some(n => userId.startsWith(n));
            let msgText = (msg.body || '').trim();

            // WhatsApp placeholder fix
            const WA_PLACEHOLDERS = ['esperando el mensaje', 'waiting for this message', 'este mensaje estaba esperando', 'this message was waiting'];
            if (WA_PLACEHOLDERS.some(p => msgText.toLowerCase().includes(p))) {
                msgText = 'Hola';
            }

            // --- ADMIN COMMANDS ---
            if (isAdmin) {
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
                    const { _setStep } = require('../flows/utils/flowHelpers');
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
                    const helpPart2 = `📋 *Comandos (2/2):*\n\n*Analytics:*\n• !funnel — Embudo de ventas paso a paso\n• !abandonos — Motivos de abandono + A/B testing\n\n*Sistema:*\n• !status — Estado del bot\n• !stats — Ventas y métricas del día\n• !pausa-global on/off — Pausar todo el bot\n• !precios — Ver precios actuales\n• !script [v5/v6] — Ver o cambiar script\n• !admin add/remove [tel] — Gestionar admins\n\n*Otros:*\n• !resumen — Reporte diario\n• !saltear [tel] — Forzar paso de usuario\n• [texto libre] — Instrucción IA al cliente\n• !ayuda — Este menú`;
                    await client.sendMessage(msg.from, helpPart1);
                    await client.sendMessage(msg.from, helpPart2);
                    return;
                }

                const { selector, command } = parseAdminInput(msgText);
                const result = await handleAdminCommand(null, command, false, selector);
                if (result) await client.sendMessage(msg.from, result);
                return;
            }

            // --- USER MESSAGES ---

            // Audio
            if (msg.type === 'ptt' || msg.type === 'audio') {
                const media = await msg.downloadMedia();
                if (media) {
                    const audioDir = path.join(dataDir, '..', 'public', 'media', 'audio');
                    await fs.promises.mkdir(audioDir, { recursive: true }).catch(() => {});
                    const ext = media.mimetype?.includes('ogg') ? 'ogg' : 'mp3';
                    const audioFilename = `${userId.replace('@c.us', '')}_${Date.now()}.${ext}`;
                    await fs.promises.writeFile(path.join(audioDir, audioFilename), Buffer.from(media.data, 'base64'));
                    const audioUrl = `/media/audio/${audioFilename}`;
                    const transcription = await aiService.transcribeAudio(media.data, media.mimetype);
                    if (transcription) {
                        logAndEmit(userId, 'user', `MEDIA_AUDIO:${audioUrl}|TRANSCRIPTION:${transcription}`, userState[userId]?.step || 'new');
                        msgText = transcription;
                    } else {
                        logAndEmit(userId, 'user', `MEDIA_AUDIO:${audioUrl}`, userState[userId]?.step || 'new');
                        await client.sendMessage(userId, 'Disculpá, no pude escuchar bien el audio. ¿Me lo escribís?');
                        return;
                    }
                } else { return; }
            }

            // Image/Sticker
            if (msg.type === 'image' || msg.type === 'sticker') {
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
                    return;
                }
                if (msg.type === 'image' && msg.body) {
                    msgText = `[Imagen enviada por el usuario] ${msg.body}`;
                } else { return; }
            }

            // Document/PDF — típicamente comprobante de pago. Si el cliente
            // está en flujo de pago, pausamos y alertamos al admin para
            // verificación manual. Sin esto, el bot le contestaba genérico y
            // dejaba al cliente en limbo (caso real Romina 19-may).
            if (msg.type === 'document') {
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
                    return;
                }
                // Fuera de los steps de pago, ignoramos el documento (no
                // sabemos qué hacer con él) — el bot sigue con el flow normal.
                return;
            }

            // Empty message
            if (!msgText || msgText.trim() === '') {
                // 'e2e_notification' es una system event de WhatsApp (cambio de
                // clave de encriptación, re-instalación, nuevo dispositivo) que
                // NO es un mensaje del usuario. Si la trataramos como ad click,
                // gatillamos el saludo a clientes que nunca escribieron — este
                // bug causaba cross-talk cuando el cliente rotaba sus claves
                // mientras el bot tenía su contacto guardado.
                if (msg.type === 'chat' || msg.type === 'template_button_reply') {
                    msgText = 'Hola! (Vengo de un anuncio)';
                } else {
                    return;
                }
            }

            if (msg.type !== 'ptt' && msg.type !== 'audio' && msg.type !== 'image') {
                logAndEmit(userId, 'user', msgText, userState[userId]?.step || 'new');
            }

            // Special: audio request
            if (msgText.toLowerCase() === 'marta mandame un audio') {
                try {
                    const chat2 = await msg.getChat();
                    await chat2.sendStateRecording();
                } catch (e) { /* ignore */ }
                try {
                    const audioText = '¡Hola! Acá Elena del equipo de Herbalis. Contame, ¿en qué te puedo ayudar hoy?';
                    const base64Audio = await aiService.generateAudio(audioText);
                    if (base64Audio) {
                        const mediaMp3 = new MessageMedia('audio/mp3', base64Audio, 'audio.mp3');
                        await client.sendMessage(userId, mediaMp3, { sendAudioAsVoice: true });
                        logAndEmit(userId, 'bot', `AUDIO ENVIADO: "${audioText}"`, userState[userId]?.step);
                    } else {
                        await client.sendMessage(userId, 'Uh, perdoná, se me complicó mandar el audio ahora.');
                    }
                } catch (e: any) {
                    await client.sendMessage(userId, 'Uy, tuve un problemita con el audio, ¡perdoná!');
                }
                return;
            }

            // Global pause check
            if (config.globalPause && !isAdmin) {
                logger.info(`[PAUSED-GLOBAL][${sellerId}] Ignoring ${userId}`);
                return;
            }

            // Per-user pause
            if (pausedUsers.has(userId) || (msg.from !== userId && pausedUsers.has(msg.from))) {
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
                return;
            }

            // Debounce
            let currentDelay = DEBOUNCE_MS;
            if (userState[userId]?.step === 'waiting_data') {
                currentDelay = 25000;
            }

            const msgObj = { text: msgText, timestamp: msg.timestamp || Math.floor(Date.now() / 1000) };

            if (pendingMessages.has(userId)) {
                const pending = pendingMessages.get(userId)!;
                pending.messages.push(msgObj);
                clearTimeout(pending.timer);
                pending.timer = setTimeout(() => _processDebounced(userId), currentDelay);
            } else {
                pendingMessages.set(userId, {
                    messages: [msgObj],
                    timer: setTimeout(() => _processDebounced(userId), currentDelay),
                    startTime: Date.now()
                });
            }
        } catch (err: any) {
            logger.error(`[MESSAGE-HANDLER][${sellerId}] Error:`, err.message);
        }
    };
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
 * Distinguir bot vs admin: `botSentMessageIds` registra los IDs que el
 * bot envió via client.sendMessage (wrappeado en clientPool). Si el ID
 * del mensaje saliente está en ese set, lo ignoramos.
 */
export function createOutgoingMessageHandler(ctx: {
    sellerId: string;
    userState: any;
    pausedUsers: Set<string>;
    sharedState: any;
    botSentMessageIds: Set<string>;
}): (msg: any) => Promise<void> {
    const { sellerId, userState, pausedUsers, sharedState, botSentMessageIds } = ctx;
    const { dismissAlertsForUser } = require('../services/adminService');

    return async function outgoingHandler(msg: any): Promise<void> {
        try {
            // Solo nos interesan outgoing messages a chats individuales.
            if (!msg.fromMe) return;
            if (!msg.to || typeof msg.to !== 'string') return;
            if (!msg.to.endsWith('@c.us')) return;
            if (msg.to.endsWith('@g.us') || msg.to.endsWith('@broadcast')) return;

            // Skip si la conexión recién se inició (mensajes históricos).
            if (sharedState.connectedAt && msg.timestamp && msg.timestamp < sharedState.connectedAt) return;

            // 'message_create' puede dispararse antes de que el wrapper de
            // client.sendMessage termine el await y agregue el ID al set.
            // Diferimos el chequeo 100ms para evitar esa race (el wrapper
            // resuelve y registra el ID dentro de microsegundos del evento).
            await new Promise(r => setTimeout(r, 100));

            // Si el ID está en botSentMessageIds, este mensaje lo envió el bot
            // mismo via client.sendMessage. No es manual.
            const msgId = msg.id?._serialized;
            if (msgId && botSentMessageIds.has(msgId)) return;

            const targetId = msg.to;

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

            // Si el chat ya tiene estado de bot o ya está pausado, no necesitamos
            // hacer la pausa de nueva conversación.
            if (userState[targetId]) return;
            if (pausedUsers.has(targetId)) return;

            // Chat nuevo iniciado manualmente — pausarlo para que el bot no
            // dispare la bienvenida cuando el cliente responda.
            pausedUsers.add(targetId);
            try {
                const { prisma } = require('../../db');
                const cleanPhone = targetId.replace('@c.us', '').replace(/\D/g, '');
                await prisma.user.upsert({
                    where: { phone_instanceId: { phone: cleanPhone, instanceId: sellerId } },
                    update: { pausedAt: new Date(), pauseReason: 'Conversación iniciada manualmente por admin desde WhatsApp' },
                    create: { phone: cleanPhone, instanceId: sellerId, pausedAt: new Date(), pauseReason: 'Conversación iniciada manualmente por admin desde WhatsApp' },
                });
            } catch (err: any) {
                if (err?.code !== 'P2002') {
                    logger.warn(`[MANUAL-CHAT][${sellerId}] Failed to persist pause for ${targetId}: ${err?.message}`);
                }
            }
            logger.info(`[MANUAL-CHAT][${sellerId}] Admin escribió manualmente a ${targetId} — chat pausado para no disparar bienvenida`);
        } catch (err: any) {
            logger.error(`[OUTGOING-HANDLER][${sellerId}] Error: ${err?.message}`);
        }
    };
}
