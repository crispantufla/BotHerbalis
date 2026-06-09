/**
 * agent.js — Brazo del bot (whatsapp-web.js) en la PC del vendedor.
 *
 * Corre WhatsApp en un Chromium real (IP del vendedor) y lo conecta al cerebro en
 * Railway vía el gateway /agent, usando el MISMO protocolo de frames que remoteClient.ts.
 * El cerebro (salesFlow/IA/DB) vive en Railway y no cambia.
 *
 * Config: agent/config.json  (o variables de entorno GATEWAY_URL / SELLER_ID / AGENT_TOKEN).
 * Correr:  npm install && npm start
 *
 * FASE 1: conectar, recibir (incoming), enviar (send_text), QR/ready, reconexión WS.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { injectSidebar } = require('./sidebar');

// ── Config ───────────────────────────────────────────────────────────────────
function loadConfig() {
    let cfg = {};
    const file = path.join(__dirname, 'config.json');
    if (fs.existsSync(file)) {
        try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`config.json inválido: ${e.message}`); }
    }
    cfg.gatewayUrl = process.env.GATEWAY_URL || cfg.gatewayUrl;
    cfg.sellerId = process.env.SELLER_ID || cfg.sellerId;
    cfg.token = process.env.AGENT_TOKEN || cfg.token;
    cfg.apiBase = process.env.API_BASE || cfg.apiBase || cfg.dashboardUrl || 'https://mainherbalisbot-production.up.railway.app';
    cfg.apiToken = process.env.API_TOKEN || cfg.apiToken || '';   // JWT del vendedor (para los botones del panel)
    if (!cfg.gatewayUrl || !cfg.sellerId || !cfg.token) {
        fail('Falta config. Completá agent/config.json (gatewayUrl, sellerId, token) o usá variables de entorno.');
    }
    return cfg;
}
function fail(msg) { console.error('[AGENT] ✗', msg); process.exit(1); }
const log = (...a) => console.log('[AGENT]', ...a);

const cfg = loadConfig();

// Llama a la API de Railway server-to-server (Node, sin CORS). Auth con el JWT del vendedor.
async function apiCall(method, pathname, body) {
    const url = String(cfg.apiBase).replace(/\/$/, '') + pathname;
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiToken) headers['Authorization'] = 'Bearer ' + cfg.apiToken;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const txt = await res.text();
    let data; try { data = JSON.parse(txt); } catch { data = txt; }
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
}

// Devuelve el chat que el vendedor tiene ABIERTO, con su id EXACTO, vía los módulos
// internos de WA Web (WAWebCollections.Chat.getActive) — la misma vía que usa wwebjs.
// El match por NOMBRE contra client.getChats queda solo como fallback de emergencia:
// es ambiguo con contactos homónimos y la lista se reordena entre llamadas (llegó a
// apuntar acciones del panel a OTRO chat).
async function getOpenChat() {
    const res = await client.pupPage.evaluate(() => {
        try {
            const Chat = window.require('WAWebCollections').Chat;
            const active = (typeof Chat.getActive === 'function' && Chat.getActive())
                || Chat.getModelsArray().find((c) => c.active);
            if (active) return { id: active.id._serialized, name: active.formattedTitle || active.name || null };
        } catch (e) { /* módulo no disponible — caemos al DOM */ }
        const h = document.querySelector('#main header');
        return { id: null, name: h ? (h.innerText || '').split('\n')[0].trim() : null };
    });
    if (res.id) return { id: res.id, dbg: { name: res.name, via: 'store' } };
    if (!res.name) return { id: null, dbg: { reason: 'ningún chat abierto' } };
    try {
        const chats = await client.getChats();
        const c = chats.find(x => (x.name || '').trim() === res.name.trim());
        return { id: c ? c.id._serialized : null, dbg: { name: res.name, via: 'nombre (ambiguo)', matched: !!c, n: chats.length } };
    } catch (e) { return { id: null, dbg: { name: res.name, err: e.message } }; }
}

const HB_INTERVAL_MS = 15000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

// ── WhatsApp (whatsapp-web.js) ───────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ clientId: cfg.sellerId, dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: {
        headless: false,   // ventana visible: el vendedor escanea el QR y ve que anda
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});

let waReady = false;
let exposed = false;

// Abre el dashboard de Railway en una segunda pestaña del mismo Chrome.
// WhatsApp queda al frente; la sesión del dashboard persiste en el perfil (user-data-dir).
let dashOpened = false;
async function openDashboardTab() {
    if (dashOpened || !client.pupBrowser || !client.pupPage) return;
    dashOpened = true;
    try {
        const base = String(cfg.apiBase).replace(/\/$/, '') + '/';
        const pages = await client.pupBrowser.pages();
        if (!pages.some((p) => p.url().startsWith(base))) {
            const page = await client.pupBrowser.newPage();
            await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
            log('dashboard abierto en segunda pestaña:', base);
        }
        await client.pupPage.bringToFront();
    } catch (e) { dashOpened = false; log('no pude abrir el dashboard:', e.message); }
}

function serializeMsg(m) {
    return {
        id: { _serialized: (m.id && m.id._serialized) || String(m.id) },
        from: m.from,
        to: m.to,
        body: m.body || '',
        type: m.type || 'chat',
        hasMedia: !!m.hasMedia,
        timestamp: m.timestamp || Math.floor(Date.now() / 1000),
        author: m.author,
        fromMe: !!m.fromMe,
    };
}

client.on('qr', (qr) => {
    log('escaneá este QR con el WhatsApp del vendedor (en ESTA ventana, no en el dashboard):');
    qrcode.generate(qr, { small: true });
    // NO se reenvía al dashboard: el QR se escanea acá, en la ventana del agente.
    // (El dashboard ya no muestra QR para un vendedor remoto.)
});
client.on('authenticated', () => log('autenticado'));
client.on('auth_failure', (m) => { log('auth_failure:', m); send({ t: 'auth_failure', message: m }); });
client.on('ready', async () => {
    waReady = true;
    const phone = client.info && client.info.wid ? client.info.wid.user : '';
    log('✅ WhatsApp listo. Número:', phone);
    send({ t: 'ready', phone });
    // Panel lateral (botonera) en la ventana de WhatsApp del agente.
    try {
        // Expone al panel una función para enviar mensajes vía wwebjs. Una sola vez:
        // el binding de exposeFunction persiste entre recargas de WhatsApp.
        if (!exposed) {
            await client.pupPage.exposeFunction('hbSendMessage', async (number, text) => {
                try {
                    const chatId = String(number).replace(/\D/g, '') + '@c.us';
                    const sent = await client.sendMessage(chatId, text);
                    log(`▶ enviado desde panel a ${chatId}`);
                    return { ok: true, id: sent && sent.id ? sent.id._serialized : null };
                } catch (e) {
                    log('envío desde panel falló:', e.message);
                    return { ok: false, error: e.message };
                }
            });
            // Enviar al chat que el vendedor tiene ABIERTO.
            await client.pupPage.exposeFunction('hbSendToOpenChat', async (text) => {
                try {
                    const o = await getOpenChat();
                    if (!o.id) return { ok: false, error: 'no detecté el chat — dbg: ' + JSON.stringify(o.dbg) };
                    const sent = await client.sendMessage(o.id, text);
                    log(`▶ enviado al chat abierto ${o.id}`);
                    return { ok: true, id: sent && sent.id ? sent.id._serialized : null, chatId: o.id };
                } catch (e) { log('envío a chat abierto falló:', e.message); return { ok: false, error: e.message }; }
            });
            // Botones del asistente de IA — el agente llama a la API de Railway (sin CORS).
            await client.pupPage.exposeFunction('hbAction', async (action) => {
                try {
                    const o = await getOpenChat();
                    if (!o.id) return { ok: false, error: 'no detecté el chat — dbg: ' + JSON.stringify(o.dbg) };
                    const chatId = o.id;
                    switch (action) {
                        case 'pause':  await apiCall('POST', '/api/toggle-bot', { chatId, paused: true });  return { ok: true, msg: 'Bot pausado' };
                        case 'resume': await apiCall('POST', '/api/toggle-bot', { chatId, paused: false }); return { ok: true, msg: 'Bot reactivado' };
                        case 'reset':  await apiCall('POST', '/api/reset-chat', { chatId });                return { ok: true, msg: 'Chat reiniciado' };
                        case 'confirm': { const r = await apiCall('POST', '/api/orders/manual-complete', { chatId, silent: false }); return { ok: true, msg: 'Pedido confirmado (con mensaje)', data: r }; }
                        case 'confirm_silent': { const r = await apiCall('POST', '/api/orders/manual-complete', { chatId, silent: true }); return { ok: true, msg: 'Pedido registrado (sin mensaje)', data: r }; }
                        case 'summarize': { const r = await apiCall('GET', '/api/summarize/' + encodeURIComponent(chatId)); return { ok: true, msg: 'Resumen', data: (r && (r.summary || r.text)) || r }; }
                        default: return { ok: false, error: 'acción desconocida' };
                    }
                } catch (e) { log(`acción ${action} falló:`, e.message); return { ok: false, error: e.message }; }
            });
            // Trae el guion (pasos) para mostrarlos en el panel.
            await client.pupPage.exposeFunction('hbGetScript', async () => {
                try { const r = await apiCall('GET', '/api/script/v7'); return { ok: true, flow: (r && r.flow) || {} }; }
                catch (e) { return { ok: false, error: e.message }; }
            });
            exposed = true;
        }
        await injectSidebar(client.pupPage);
        log('panel inyectado');
    } catch (e) { log('sidebar:', e.message); }
});
client.on('change_state', (s) => { log('estado:', s); send({ t: 'state', state: s }); });
client.on('disconnected', (reason) => {
    waReady = false;
    log('desconectado de WhatsApp:', reason);
    send({ t: 'state', state: 'UNPAIRED' });
    setTimeout(() => client.initialize().catch((e) => log('re-init falló:', e.message)), 5000);
});

// Entrantes (del cliente)
client.on('message', (m) => {
    const msg = serializeMsg(m);
    // from se deja tal cual (incluye @lid): es lo que enruta bien al enviar de vuelta.
    // La resolución a teléfono real, si hace falta, se hace del lado de Railway (resolveChatId).
    log(`◀ incoming de ${msg.from}: ${JSON.stringify(msg.body)}`);
    send({ t: 'incoming', msg });
});
// Salientes — incluye lo que el bot manda y lo que el vendedor escribe a mano desde el
// celular. Railway deduplica los del bot por msgId (botSentMessageIds); los manuales
// los trata como intervención.
client.on('message_create', (m) => {
    if (m.fromMe) send({ t: 'outgoing', msg: serializeMsg(m) });
});

// ── Comandos del gateway → acciones wwebjs ───────────────────────────────────
async function handleCommand(frame) {
    const { t, id } = frame;
    try {
        switch (t) {
            case 'sync':
                if (waReady) send({ t: 'ready', phone: client.info && client.info.wid ? client.info.wid.user : '' });
                return;
            case 'send_text': {
                const sent = await client.sendMessage(frame.chatId, frame.text);
                ack(id, true, { msgId: sent && sent.id ? sent.id._serialized : null });
                return;
            }
            case 'send_media': {
                const media = new MessageMedia(frame.mimetype, frame.data, frame.filename || undefined);
                const opts = frame.opts || {};
                const sent = await client.sendMessage(frame.chatId, media, {
                    caption: opts.caption || undefined,
                    sendAudioAsVoice: !!opts.isPtt,
                });
                ack(id, true, { msgId: sent && sent.id ? sent.id._serialized : null });
                return;
            }
            case 'typing': {
                const chat = await client.getChatById(frame.chatId);
                await chat.sendStateTyping();
                return;
            }
            case 'clear_state': {
                const chat = await client.getChatById(frame.chatId);
                await chat.clearState();
                return;
            }
            case 'seen': {
                const chat = await client.getChatById(frame.chatId);
                await chat.sendSeen();
                return;
            }
            case 'download': {
                const m = await client.getMessageById(frame.msgId);
                const media = m ? await m.downloadMedia() : null;
                ack(id, true, media ? { mimetype: media.mimetype, data: media.data, filename: media.filename } : {});
                return;
            }
            case 'fetch_messages': {
                const chat = await client.getChatById(frame.chatId);
                const msgs = await chat.fetchMessages({ limit: frame.limit || 50 });
                ack(id, true, { messages: (msgs || []).map(serializeMsg) });
                return;
            }
            case 'get_chats': {
                // Para GET /api/chats del dashboard. Solo los campos que la ruta lee.
                const chats = await client.getChats();
                const out = (chats || []).map((c) => ({
                    id: c.id && c.id._serialized,
                    name: c.name || '',
                    isGroup: !!c.isGroup,
                    timestamp: c.timestamp || 0,
                    unreadCount: c.unreadCount || 0,
                    lastMessage: c.lastMessage ? {
                        body: c.lastMessage.body || '',
                        hasMedia: !!c.lastMessage.hasMedia,
                        timestamp: c.lastMessage.timestamp || 0,
                    } : null,
                }));
                ack(id, true, { chats: out });
                return;
            }
            case 'get_contact': {
                // Para resolveChatId / resolución @lid→@c.us en Railway.
                const contact = await client.getContactById(frame.contactId);
                if (!contact) { ack(id, true, { found: false }); return; }
                ack(id, true, {
                    found: true,
                    id: contact.id && contact.id._serialized,
                    number: contact.number || null,
                    name: contact.name || null,
                    pushname: contact.pushname || null,
                });
                return;
            }
            default:
                return;
        }
    } catch (e) {
        log('cmd', t, 'falló:', e.message);
        ack(id, false, e.message);
    }
}

// ── WebSocket al gateway ─────────────────────────────────────────────────────
let ws = null;
let hbTimer = null;
let reconnectAttempts = 0;

function send(frame) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(frame)); } catch (e) { /* noop */ }
    }
}
function ack(id, ok, payload) {
    if (id == null) return;
    send(ok ? { t: 'ack', id, ok: true, result: payload } : { t: 'ack', id, ok: false, error: String(payload) });
}

function connectGateway() {
    log(`conectando al gateway ${cfg.gatewayUrl} como ${cfg.sellerId}…`);
    ws = new WebSocket(cfg.gatewayUrl);

    ws.on('open', () => {
        reconnectAttempts = 0;
        send({ t: 'auth', sellerId: cfg.sellerId, token: cfg.token });
        startHeartbeat();
        if (waReady) send({ t: 'ready', phone: client.info && client.info.wid ? client.info.wid.user : '' });
        log('gateway conectado, auth enviado');
    });
    ws.on('message', (raw) => {
        let frame; try { frame = JSON.parse(raw.toString()); } catch { return; }
        handleCommand(frame);
    });
    ws.on('close', () => { stopHeartbeat(); scheduleReconnect(); });
    ws.on('error', (e) => log('WS error:', e.message));
}

function scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts++;
    log(`reconectando al gateway en ${delay / 1000}s…`);
    setTimeout(connectGateway, delay);
}
function startHeartbeat() { stopHeartbeat(); hbTimer = setInterval(() => send({ t: 'hb' }), HB_INTERVAL_MS); }
function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }

// ── Arranque ─────────────────────────────────────────────────────────────────
log(`iniciando agente para seller "${cfg.sellerId}"…`);
connectGateway();
client.initialize().catch((e) => fail(`no pude iniciar WhatsApp: ${e.message}`));

// Apenas exista la ventana de Chrome (antes del QR/ready), abrir el dashboard al lado.
const dashTimer = setInterval(() => {
    if (client.pupBrowser && client.pupPage) { clearInterval(dashTimer); openDashboardTab(); }
}, 700);

// Errores transitorios de puppeteer/wwebjs (ej. "Execution context was destroyed" cuando
// WhatsApp se recarga mientras wwebjs inyecta) NO deben tumbar el agente. Los logueamos;
// wwebjs maneja la reconexión por su cuenta.
process.on('unhandledRejection', (reason) => {
    log('unhandledRejection (ignorado):', (reason && reason.message) || String(reason));
});
process.on('uncaughtException', (e) => {
    log('uncaughtException (ignorado):', (e && e.message) || String(e));
});

process.on('SIGINT', async () => { log('cerrando…'); try { await client.destroy(); } catch {} process.exit(0); });
