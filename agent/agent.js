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
const { checkAndUpdate } = require('./updater');

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
        // Flags anti-throttling: sin esto, Chrome "duerme" la pestaña de WhatsApp
        // cuando no está al frente (el agente abre una 2ª pestaña con el dashboard)
        // o cuando la ventana queda tapada → se cae el WebSocket de WhatsApp y se
        // re-empareja cada ~30 min (reporte de horacio "se desconecta solo"). Estos
        // flags mantienen vivos los timers y la red de la pestaña sin foco/ocluida.
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
        ],
    },
});

// ── Recuperación del perfil bloqueado (Windows) ──────────────────────────────
// Chromium implementa un ProcessSingleton POR user-data-dir: si queda un
// chrome.exe VIVO usando session-<seller> (porque un restart anterior —watchdog,
// update, cierre de ventana con la X, crash— mató el Node sin cerrar el browser),
// el próximo launch hace "handover" y sale, y puppeteer tira "The browser is
// already running for <dir>" → fail() → exit(1) → run.bat relanza → MISMO zombie
// → loop infinito (reporte real de horacio, jul-2026). Dos defensas, ambas
// fail-open (si algo falla, se loguea y se sigue):
//   1) cleanupStaleProfile(): ANTES de initialize mata SOLO los procesos cuyo
//      command line apunta a la ruta ABSOLUTA de NUESTRO perfil — no toca el
//      Chrome personal del vendedor ni otras sesiones. Rompe el loop y auto-cura.
//   2) killBrowserSync(): en cada salida con el browser vivo (watchdog/update)
//      mata el árbol del browser para no DEJAR el zombie. Corta el problema de raíz.
const PROFILE_DIR = path.join(__dirname, '.wwebjs_auth', 'session-' + cfg.sellerId);
let browserPid = null;

function cleanupStaleProfile() {
    if (process.platform !== 'win32') return;
    try {
        const { execFileSync } = require('child_process');
        // Matamos SOLO el chrome.exe del browser cuyo argumento --user-data-dir es
        // EXACTAMENTE nuestro perfil. Tres cuidados (los tres verificados con una
        // revisión adversarial + prueba empírica en Windows):
        //   • Name -eq 'chrome.exe': sin esto, -match sobre CommandLine tumbaría
        //     CUALQUIER proceso que lleve la ruta del perfil en su línea de comando
        //     (un antivirus escaneándola, un editor/shell del vendedor, etc.).
        //   • [regex]::Escape(...): la ruta puede traer [ ] . ( ) y espacios ("Bot
        //     Whatsapp") — escaparla evita tanto falsos negativos como sobre-match.
        //   • Ancla final (?:"|\s|$): sin ella, session-horacio matchearía el Chrome
        //     SANO de session-horacio2 (otro seller en la misma PC) por prefijo.
        // El '--user-data-dir=' + comilla/espacio de cierre encuadran el valor exacto.
        const dirLit = PROFILE_DIR.replace(/'/g, "''"); // literal PS single-quoted
        // Regex: --user-data-dir="?<perfil>(?:"|\s|$)
        //   • "? tras el '=' cubre las dos formas de quoting: node spawnea el proceso
        //     browser como "--user-data-dir=<path>" (comilla afuera) y Chromium spawnea
        //     los hijos como --user-data-dir="<path>" (comilla adentro).
        //   • el ancla final evita que session-horacio matchee session-horacio2.
        const psScript = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match ([regex]::Escape('--user-data-dir=') + '"?' + [regex]::Escape('${dirLit}') + '(?:"|\\s|$)') } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`;
        // -EncodedCommand (base64 UTF-16LE): el script lleva comillas, $_ y una regex
        // con "|\s|$ — pasarlo como -Command a través del quoting de Node→powershell
        // los corrompe. El base64 no tiene nada que cmd/PS puedan malinterpretar.
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore', timeout: 15000, windowsHide: true });
        log(`perfil: limpié cualquier Chromium previo de session-${cfg.sellerId} (si había alguno)`);
    } catch (e) { log('cleanup de perfil (ignorado):', (e && e.message) || String(e)); }
}

// Mata sincrónicamente el árbol del browser de ESTA corrida. Se llama antes de
// process.exit() en las salidas con browser vivo, para no dejar el zombie que
// bloquea el próximo arranque.
function killBrowserSync() {
    let pid = browserPid;
    try {
        const p = client.pupBrowser && typeof client.pupBrowser.process === 'function' ? client.pupBrowser.process() : null;
        if (p && p.pid) pid = p.pid;
    } catch { /* noop */ }
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            require('child_process').execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 10000 });
        } else {
            process.kill(pid);
        }
    } catch { /* best-effort: si falla, el próximo cleanupStaleProfile lo agarra */ }
}

// ── Instancia única (anti doble-launch) ──────────────────────────────────────
// DOS agentes del mismo seller en la misma PC (doble-click al lanzador) es un
// desastre: se pelean el socket del gateway (flap de reconexión cada ~3s) y cada
// boot le mata el Chromium al otro (cleanupStaleProfile matchea el mismo perfil)
// → "se reinicia solo cada minuto" + envíos que fallan por frame detached (caso
// horacio jul-2026). Candado: un named pipe (Windows) / unix socket (posix) que el
// OS LIBERA solo al morir el proceso — sin PID files ni staleness (que sufren reuse
// de PID). El 2º agente no puede escuchar el mismo pipe → se cierra limpio (exit 0
// → run.bat NO relanza). Fail-open: ante un error raro del candado arrancamos igual
// (mejor correr sin protección que quedar mudo). Va ANTES de checkAndUpdate/Chromium
// para que el duplicado salga sin tocarle el perfil al que ya anda.
// Tradeoff conocido: si el que ya corre queda "colgado-pero-vivo", retiene el pipe y
// un doble-click del vendedor para "reiniciar" se cierra en silencio; se auto-cura vía
// el stuck/frame-watchdog (≤5 min). No lo resolvemos con un canal de control por el
// pipe a propósito: haría que un doble-click accidental rebote una sesión SANA.
let singleInstanceServer = null;
function _lockName() {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\herbalis-agent-${cfg.sellerId}`
        : path.join(require('os').tmpdir(), `herbalis-agent-${cfg.sellerId}.sock`);
}
function _tryListen(name) {
    const net = require('net');
    return new Promise((resolve) => {
        const srv = net.createServer((sock) => sock.destroy()); // no atendemos: solo marcamos presencia
        srv.once('error', (err) => resolve({ ok: false, err }));
        srv.listen(name, () => resolve({ ok: true, srv }));
    });
}
async function acquireSingleInstanceLock() {
    const name = _lockName();
    for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await _tryListen(name);
        if (r.ok) { singleInstanceServer = r.srv; return true; }
        if (r.err && r.err.code === 'EADDRINUSE') {
            // POSIX (solo dev): un .sock huérfano (crash sin cerrar) da EADDRINUSE
            // aunque no haya dueño vivo. Probamos conectar; si nadie atiende, está
            // stale. En Windows el kernel libera el pipe al morir el proceso, así que
            // ahí un EADDRINUSE = dueño vivo de verdad (esta rama no corre en prod).
            if (process.platform !== 'win32') {
                const alive = await new Promise((res) => {
                    const c = require('net').connect(name)
                        .once('connect', () => { c.destroy(); res(true); })
                        .once('error', () => res(false));
                });
                if (!alive) {
                    // Stale: intentamos tomarlo (unlink + relisten), pero SIN dueño vivo
                    // arrancamos igual pase lo que pase (fail-open) — nunca quedar mudos
                    // por un .sock que nadie usa aunque el unlink falle (permisos, RO-FS).
                    try { fs.unlinkSync(name); } catch { /* noop */ }
                    const r2 = await _tryListen(name);
                    if (r2.ok) singleInstanceServer = r2.srv;
                    return true;
                }
            }
            // Dueño vivo (o Windows). Un reintento corto cubre la carrera con un
            // relaunch de run.bat (el proceso viejo libera el pipe recién al salir).
            if (attempt < 3) { await new Promise((res) => setTimeout(res, 500)); continue; }
            return false;
        }
        log('candado de instancia única no disponible (sigo igual):', (r.err && r.err.message) || 'error desconocido');
        return true; // fail-open
    }
    return false;
}

let waReady = false;
let exposed = false;
// Estamos mostrando un QR y esperando que el vendedor lo escanee: en ese estado
// NO estar "ready" es normal (puede tardar minutos), así que el stuck-watchdog de
// más abajo se pausa para no relanzar en plena cara del vendedor mientras escanea.
let awaitingQr = false;

// Health-check del frame: tras una suspensión de la PC + recarga de WA Web, el
// pupPage de wwebjs puede quedar apuntando a un frame DETACHED — el bot deja de
// enviar/recibir SIN avisar (el WS al gateway sigue vivo, Railway lo cree ready).
// Se chequea client.getState() (NO un evaluate('1+1') pelado): getState pasa por
// el binding del Store de WA Web, que es exactamente lo que muere en el estado
// zombie "página viva pero WA colgado" (caso horacio 20-jul-2026: waReady=true,
// heartbeats OK, cero eventos de mensajes por más de 1 h — el evaluate trivial
// pasaba y ningún watchdog disparaba). Strike si getState cuelga, tira, o devuelve
// algo ≠ CONNECTED. 3 strikes consecutivos (~3 min) → salir con código ≠0; run.bat
// relanza y wwebjs re-engancha limpio. 3 y no 1 porque OPENING/PAIRING transitorios
// son normales durante una reconexión sana de WA Web.
let watchdogTimer = null;
let watchdogStrikes = 0;
function startFrameWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(async () => {
        if (!waReady || !client.pupPage) return;
        try {
            const st = await Promise.race([
                client.getState(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 10s')), 10000)),
            ]);
            if (st !== 'CONNECTED') throw new Error(`estado ${st || 'null'}`);
            watchdogStrikes = 0;
        } catch (e) {
            watchdogStrikes++;
            log(`frame health-check falló (${watchdogStrikes}/3):`, e.message);
            if (watchdogStrikes >= 3) { log('frame zombie — matando el browser y saliendo para que run.bat relance'); killBrowserSync(); process.exit(1); }
        }
    }, 60000);
}

// Watchdog "conectado pero nunca llegó a ready". Si el gateway está conectado y
// WA Web no alcanzó 'ready' en STUCK_LIMIT_MS —y NO estamos esperando el escaneo
// de un QR— es que wwebjs quedó colgado (re-pair a medias, loading screen trabado,
// frame que no engancha, perfil recién re-emparejado). Nadie lo cura solo: el
// server manda 'sync' UNA sola vez al (re)conectar el agente y, si waReady está en
// false, el frame 'ready' no sale nunca → el dashboard queda OFFLINE para siempre
// (caso horacio jul-2026: vinculó un número nuevo, quedó offline 3 h tras un
// restart del server). Relanzamos limpio: run.bat re-corre cleanupStaleProfile +
// initialize — el mismo remedio que el reinicio manual, pero automático. Umbral
// conservador (5 min consecutivos) y el reset ante waReady/awaitingQr/gateway-caído
// evitan relanzar durante un boot normal, un escaneo de QR o una caída de red.
const STUCK_CHECK_MS = 60000;
const STUCK_LIMIT_MS = 300000; // 5 min conectado-sin-ready ⇒ colgado
let stuckTimer = null;
let notReadyStreak = 0;
function startStuckWatchdog() {
    if (stuckTimer) return;
    stuckTimer = setInterval(() => {
        // Ready, esperando QR, o gateway caído → no es un cuelgue: reiniciar la cuenta.
        if (waReady || awaitingQr || !ws || ws.readyState !== WebSocket.OPEN) { notReadyStreak = 0; return; }
        notReadyStreak++;
        if (notReadyStreak * STUCK_CHECK_MS >= STUCK_LIMIT_MS) {
            log(`WhatsApp no llegó a "ready" en ${STUCK_LIMIT_MS / 60000} min con el gateway conectado — relanzando limpio para re-enganchar`);
            killBrowserSync();
            process.exit(1); // run.bat relanza → cleanupStaleProfile + initialize fresco
        }
    }, STUCK_CHECK_MS);
}

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

// Id del mensaje para el frame. wwebjs a veces entrega un MessageId SIN _serialized
// (reentregas tras reconexión de WA Web). El viejo fallback String(m.id) producía
// "[object Object]" — TODOS esos mensajes compartían la misma key de dedup en
// Railway y se descartaban entre sí (mensajes REALES sin responder, jul-2026).
// Fallbacks: componer el formato canónico fromMe_remote_id (estable entre
// reentregas); si ni eso se puede, un id único con prefijo remote_ — Railway
// saltea el dedup por id para esos (fail-open: mejor un posible doble que un mudo).
function _msgId(m) {
    if (m.id && typeof m.id._serialized === 'string' && m.id._serialized) return m.id._serialized;
    if (m.id && typeof m.id === 'object' && m.id.id) {
        const remote = (m.id.remote && (m.id.remote._serialized || m.id.remote)) || m.from || '?';
        return `${m.id.fromMe ? 'true' : 'false'}_${remote}_${m.id.id}`;
    }
    if (typeof m.id === 'string' && m.id) return m.id;
    return `remote_noid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function serializeMsg(m) {
    return {
        id: { _serialized: _msgId(m) },
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
    awaitingQr = true; // esperando escaneo humano → pausa el stuck-watchdog
    log('escaneá este QR con el WhatsApp del vendedor (en ESTA ventana, no en el dashboard):');
    qrcode.generate(qr, { small: true });
    // NO se reenvía al dashboard: el QR se escanea acá, en la ventana del agente.
    // (El dashboard ya no muestra QR para un vendedor remoto.)
});
client.on('authenticated', () => { awaitingQr = false; log('autenticado'); }); // ya escaneó/reconectó: ahora 'ready' debe llegar solo
client.on('auth_failure', (m) => { log('auth_failure:', m); send({ t: 'auth_failure', message: m }); });
client.on('ready', async () => {
    waReady = true;
    awaitingQr = false;
    try { const p = client.pupBrowser && client.pupBrowser.process(); if (p && p.pid) browserPid = p.pid; } catch { /* noop */ }
    const phone = client.info && client.info.wid ? client.info.wid.user : '';
    log('✅ WhatsApp listo. Número:', phone);
    send({ t: 'ready', phone });
    startFrameWatchdog();
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
            // Trae los precios reales (para resolver los {{PRICE_*}} del guion en el panel).
            await client.pupPage.exposeFunction('hbGetPrices', async () => {
                try { const r = await apiCall('GET', '/api/prices'); return { ok: true, prices: r || {} }; }
                catch (e) { return { ok: false, error: e.message }; }
            });
            // Trae el state del chat ABIERTO (producto/plan/total/link) para resolver
            // los placeholders del cliente en el guion; lo que falte lo pide el modal.
            await client.pupPage.exposeFunction('hbGetChatState', async () => {
                try {
                    const o = await getOpenChat();
                    if (!o.id) return { ok: false, error: 'no detecté el chat — dbg: ' + JSON.stringify(o.dbg) };
                    const r = await apiCall('GET', '/api/chat-state/' + encodeURIComponent(o.id));
                    return { ok: true, state: r || {} };
                } catch (e) { return { ok: false, error: e.message }; }
            });
            // Genera un link de Mercado Pago por `amount` y lo ENVÍA al chat abierto.
            await client.pupPage.exposeFunction('hbMpLink', async (amount) => {
                try {
                    const o = await getOpenChat();
                    if (!o.id) return { ok: false, error: 'no detecté el chat — dbg: ' + JSON.stringify(o.dbg) };
                    // Dígitos puros = pesos enteros. Evita que "46.900" (formato AR) se
                    // interprete como 46,9 por el separador de miles.
                    const amt = parseInt(String(amount).replace(/\D/g, ''), 10);
                    if (!amt || amt <= 0) return { ok: false, error: 'monto inválido' };
                    const r = await apiCall('POST', '/api/mp-link', { amount: amt, userPhone: o.id, sendToChat: true });
                    if (r && r.sent === false) return { ok: false, error: 'link generado pero no se envió: ' + (r.sendError || '?') };
                    return { ok: true, msg: `Link MP enviado al chat ($${amt.toLocaleString('es-AR')})`, data: (r && r.link) || r };
                } catch (e) { return { ok: false, error: e.message }; }
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
// Dedup local: wwebjs a veces dispara 'message' 2-3 veces por el mismo mensaje físico
// (confirmado en prod: [ID-RESOLVE] repetidos en Railway). Lo cortamos en ORIGEN para
// no reenviar el frame duplicado por el WS (ahorra ancho de banda + RPCs del lado Railway).
// Railway igual deduplica por msg-id (defensa en capas).
const _seenIncoming = new Map(); // msgId → ts
function _dupIncoming(id) {
    if (!id) return false;
    const now = Date.now();
    for (const [k, t] of _seenIncoming) { if (now - t > 60000) _seenIncoming.delete(k); }
    if (_seenIncoming.has(id)) return true;
    _seenIncoming.set(id, now);
    return false;
}
client.on('message', (m) => {
    const msg = serializeMsg(m);
    const _id = msg.id && msg.id._serialized;
    if (_dupIncoming(_id)) { log(`⊘ incoming duplicado ignorado: ${_id}`); return; }
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
                const realId = (contact.id && contact.id._serialized) || null;
                // OJO: contact.number puede traer los dígitos del LID (no el teléfono).
                // El id del MODELO sí dereferencia lid → @c.us real (verificado en la
                // WA Web actual), así que el número sale de ahí.
                const number = (realId && realId.endsWith('@c.us'))
                    ? realId.split('@')[0]
                    : (contact.number || null);
                ack(id, true, {
                    found: true,
                    id: realId,
                    number,
                    name: contact.name || null,
                    pushname: contact.pushname || null,
                });
                return;
            }
            case 'update': {
                // Push remoto: POST /api/agent/update → gateway → acá. Baja los
                // archivos nuevos de /agent-dist y sale con 99 (run.bat relanza).
                // frame.force=true relanza AUNQUE no haya versión nueva — palanca del
                // admin para descolgar en el acto un agente "conectado pero no ready".
                log(frame.force ? 'relaunch remoto FORZADO por el gateway…' : 'update remoto solicitado por el gateway…');
                const updated = await checkAndUpdate(cfg);
                ack(id, true, { updated, forced: !!frame.force });
                if (updated || frame.force) {
                    log(updated ? '✓ actualizado — reiniciando' : '✓ relanzando (forzado, sin cambio de versión)');
                    // exit 99 = convención "actualizado"; si es solo force, exit 1
                    // igual relanza (run.bat loopea ante cualquier código ≠ 0).
                    setTimeout(() => { killBrowserSync(); process.exit(updated ? 99 : 1); }, 500); // deja salir el ack por el WS
                }
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

// ── Anti-sleep (Windows) ─────────────────────────────────────────────────────
// Si la PC del vendedor se SUSPENDE, el proceso Node se congela: deja de mandar
// heartbeats y el gateway lo da por caído a los 45s (es el flapping nocturno). No
// hay arreglo posible desde el heartbeat — un proceso suspendido no puede enviar
// nada, y WhatsApp tampoco corre con la PC dormida. La única solución real es
// impedir que la PC se duerma mientras el agente vive. Le pedimos a Windows que
// mantenga el SISTEMA despierto (no la pantalla) vía SetThreadExecutionState,
// sostenido por un PowerShell hijo. Best-effort / fail-open: si algo falla, el
// agente sigue igual (a lo sumo vuelve el flapping si la PC se duerme).
let keepAwakeProc = null;
function startKeepAwake() {
    if (process.platform !== 'win32' || keepAwakeProc) return;
    // ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1) = 2147483649. NO usamos
    // ES_DISPLAY_REQUIRED: la pantalla puede apagarse; solo evitamos el suspend.
    const ps = `$sig='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);';$t=Add-Type -MemberDefinition $sig -Name Power -Namespace Win32Agent -PassThru;while($true){$t::SetThreadExecutionState([uint32]2147483649)|Out-Null;Start-Sleep -Seconds 60}`;
    try {
        const { spawn } = require('child_process');
        keepAwakeProc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
        keepAwakeProc.on('error', (e) => { log('keep-awake no disponible:', e.message); keepAwakeProc = null; });
        keepAwakeProc.on('exit', () => { keepAwakeProc = null; });
        log('keep-awake activado: la PC no se va a suspender mientras corra el agente');
    } catch (e) { log('keep-awake falló (sigo igual):', e.message); keepAwakeProc = null; }
}
function stopKeepAwake() { if (keepAwakeProc) { try { keepAwakeProc.kill(); } catch { /* noop */ } keepAwakeProc = null; } }

// ── Arranque ─────────────────────────────────────────────────────────────────
(async () => {
    log(`iniciando agente para seller "${cfg.sellerId}"…`);
    // Instancia única ANTES de tocar nada (update, Chromium): si ya hay otro agente
    // de este seller corriendo, cerramos limpio en vez de flapear y matarle el Chrome.
    if (!(await acquireSingleInstanceLock())) {
        log('⛔ Ya hay otro "Bot Herbalis" de este vendedor abierto — cerrá esta ventana. Me cierro para no duplicar.');
        process.exit(0);
    }
    // Auto-update ANTES de lanzar Chromium: si hay versión nueva en Railway, se
    // baja y se sale con 99 — run.bat relanza con el código nuevo. Fail-open: un
    // updater caído (Railway deployando, sin internet) nunca bloquea el boot.
    try {
        if (await checkAndUpdate(cfg)) {
            log('✓ actualizado — saliendo con código 99 para que run.bat relance la versión nueva');
            process.exit(99);
        }
    } catch (e) { log('updater falló (sigo con la versión actual):', e.message); }
    startKeepAwake();   // evitar que la PC se suspenda y tire el agente (flapping)
    connectGateway();
    // Matar cualquier Chromium zombie que haya quedado con el perfil bloqueado —
    // si no, initialize() tira "The browser is already running" y entramos en el
    // loop de reinicio (ver cleanupStaleProfile). Sincrónico y fail-open.
    cleanupStaleProfile();
    client.initialize().catch((e) => fail(`no pude iniciar WhatsApp: ${e.message}`));
    startStuckWatchdog();   // vigila "gateway conectado pero WA nunca ready" y relanza si se cuelga

    // Apenas exista la ventana de Chrome (antes del QR/ready), abrir el dashboard al lado.
    const dashTimer = setInterval(() => {
        if (client.pupBrowser && client.pupPage) {
            clearInterval(dashTimer);
            try { const p = client.pupBrowser.process(); if (p && p.pid) browserPid = p.pid; } catch { /* noop */ }
            openDashboardTab();
        }
    }, 700);
})();

// Errores transitorios de puppeteer/wwebjs (ej. "Execution context was destroyed" cuando
// WhatsApp se recarga mientras wwebjs inyecta) NO deben tumbar el agente. Los logueamos;
// wwebjs maneja la reconexión por su cuenta.
process.on('unhandledRejection', (reason) => {
    log('unhandledRejection (ignorado):', (reason && reason.message) || String(reason));
});
process.on('uncaughtException', (e) => {
    log('uncaughtException (ignorado):', (e && e.message) || String(e));
});

process.on('exit', stopKeepAwake);   // no dejar el PowerShell de keep-awake colgado
process.on('SIGINT', async () => { log('cerrando…'); stopKeepAwake(); try { singleInstanceServer && singleInstanceServer.close(); } catch {} try { await client.destroy(); } catch {} killBrowserSync(); process.exit(0); });
