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
            const isRotacion = config.activeScript === 'rotacion';
            let effectiveScript = userState[userId]?.assignedScript;
            if (!effectiveScript) {
                if (isRotacion) {
                    effectiveScript = Math.random() < 0.5 ? 'v3' : 'v4';
                } else {
                    effectiveScript = config.activeScript || 'v3';
                }
                // Persist the assignment if the user already has state; otherwise
                // salesFlow will freeze it when it creates the state on first message.
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
                    if (!userState[targetChatId]) userState[targetChatId] = { step: 'greeting', partialAddress: {} };
                    userState[targetChatId].step = 'waiting_data';
                    saveState();
                    const knowledge = sharedState.knowledge;
                    await client.sendMessage(targetChatId, knowledge.flow.data_request.response);
                    await client.sendMessage(msg.from, `✅ Usuario ${targetNumber} forzado.`);
                    return;
                }

                if (msgText.toLowerCase() === '!ayuda') {
                    const helpPart1 = `📋 *Comandos disponibles (1/2):*\n\n*Alertas y pedidos:*\n• !alertas — Cola de alertas activas\n• 1 ok / 2 dale — Confirmar pedido por #\n• 1 me encargo — Tomar control de cliente\n• 1r1 / 1r2 / 1r3 — Respuesta rápida a alerta\n• !pedidos — Últimos 5 pedidos\n• !pedido [tel] — Pedidos de un cliente\n• !tracking [tel] [cod] — Cargar código seguimiento\n\n*Clientes:*\n• !pausados — Ver clientes pausados\n• !despauser [tel] — Reactivar bot para cliente\n• !reset [tel] — Reiniciar estado de cliente\n• !historial [tel] — Resumen IA del chat\n• !enviar [tel] [msg] — Mensaje directo`;
                    const helpPart2 = `📋 *Comandos (2/2):*\n\n*Analytics:*\n• !funnel — Embudo de ventas paso a paso\n• !abandonos — Motivos de abandono + A/B testing\n\n*Sistema:*\n• !status — Estado del bot\n• !stats — Ventas y métricas del día\n• !pausa-global on/off — Pausar todo el bot\n• !precios — Ver precios actuales\n• !script [v3/v4] — Ver o cambiar script\n• !admin add/remove [tel] — Gestionar admins\n\n*Otros:*\n• !resumen — Reporte diario\n• !saltear [tel] — Forzar paso de usuario\n• [texto libre] — Instrucción IA al cliente\n• !ayuda — Este menú`;
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
                if (msg.type === 'image' && msg.body) {
                    msgText = `[Imagen enviada por el usuario] ${msg.body}`;
                } else { return; }
            }

            // Empty message
            if (!msgText || msgText.trim() === '') {
                if (msg.type === 'chat' || msg.type === 'e2e_notification' || msg.type === 'template_button_reply') {
                    msgText = 'Hola! (Vengo de un anuncio)';
                } else if (msg.type === 'unknown') {
                    return;
                } else { return; }
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
                    const audioText = '¡Hola! Acá Marta del equipo de Herbalis. Contame, ¿en qué te puedo ayudar hoy?';
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
