/**
 * clientPool.ts
 * Multi-seller WhatsApp client orchestrator.
 * Manages multiple whatsapp-web.js Client instances, each with isolated state.
 */

import fs from 'fs';
import path from 'path';
import { Queue, Worker } from 'bullmq';
const logger = require('../utils/logger');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { prisma } = require('../../db');
const { createStateManager, SellerStateManager } = require('./stateManager');
const { createBotHelpers } = require('../handlers/botHelpers');
const { createMessageHandler, createOutgoingMessageHandler } = require('../handlers/messageHandler');
const { createQueue, createWorker, shutdownSellerQueue } = require('./queueService');
const { processSalesFlow } = require('../flows/salesFlow');
const { aiService } = require('./ai');
const { startScheduler } = require('./scheduler');
const { restorePausedUsersFromDB } = require('./pauseService');
const { handleAdminCommand: handleAdminCommandCtrl } = require('./adminService');
const { buildConfirmationMessage } = require('../utils/messageTemplates');
import { RemoteClient } from './remoteClient';

/**
 * ¿Este seller corre en "modo remoto"? En modo remoto la sesión de WhatsApp no la
 * sostiene un Chromium headless local sino el cliente fino (extensión Chrome + wa-js)
 * en la PC del vendedor, vía el AgentHub. Se activa por seller con
 * WA_MODE_<SELLER>=remote (o WA_MODE=remote global). Default: wwebjs local.
 */
function _isRemoteSeller(sellerId: string): boolean {
    const mode = process.env[`WA_MODE_${sellerId.toUpperCase()}`] || process.env.WA_MODE;
    return (mode || '').toLowerCase() === 'remote';
}

// Cache de proxies locales (proxy-chain) por seller. El reenviador local vive
// durante todo el proceso y es independiente de los reinicios de Chrome, así que
// se crea una sola vez por seller y se reusa en cada init.
const _localEgressProxies = new Map<string, string>();

/**
 * Resuelve el `--proxy-server` que se le pasa a Chrome para un seller.
 * - Sin `WA_PROXY_<SELLER>` ni `WA_PROXY` → undefined (sale por la IP del host).
 * - Proxy SIN auth (ej. `socks5://host:port`) → se usa tal cual.
 * - Proxy CON auth (`http://user:pass@host:port`) → levanta un reenviador local
 *   (proxy-chain) que escucha en 127.0.0.1 SIN auth y agrega las credenciales al
 *   upstream. Chrome habla con el local (sin 407) → el túnel/WebSocket de WhatsApp
 *   funciona, y la auth viaja desde cualquier IP (no importa que Railway rote la
 *   IP de salida). page.authenticate NO cubre el WebSocket de WA; por eso el
 *   reenviador en vez de la opción proxyAuthentication.
 */
async function _resolveEgressProxy(sellerId: string): Promise<string | undefined> {
    const raw = (process.env[`WA_PROXY_${sellerId.toUpperCase()}`] || process.env.WA_PROXY || '').trim();
    if (!raw) return undefined;

    // Guard: un valor CON esquema (`http://`, `socks5://`) DEBE tener host. Caso real:
    // `WA_PROXY_HORACIO=http://` (truncado al pegarlo en Railway) → `new URL()` tira,
    // el catch de abajo lo trataba como "sin auth" y Chrome arrancaba con
    // `--proxy-server=http://` (host vacío). Con un proxy a un host vacío Chrome no
    // alcanza NADA → WA Web no levanta el WebSocket → "Execution context was destroyed"
    // / "callFunctionOn timed out" en loop y el QR muere a los segundos con LOGOUT.
    // Fallar a "sin proxy" (Chrome al menos conecta y muestra QR) y avisar fuerte.
    if (/:\/\//.test(raw)) {
        let host = '';
        try { host = new URL(raw).hostname; } catch { /* inválido */ }
        if (!host) {
            logger.warn(`[${sellerId}] WA_PROXY mal configurado ("${raw}") — sin host. Ignorando proxy: sale por la IP del host. Corregí la variable WA_PROXY_${sellerId.toUpperCase()}.`);
            return undefined;
        }
    }
    if (_localEgressProxies.has(sellerId)) return _localEgressProxies.get(sellerId);

    let hasAuth = false;
    try { hasAuth = !!new URL(raw).username; } catch { /* formato simple host:port, sin auth */ }

    if (!hasAuth) {
        _localEgressProxies.set(sellerId, raw);
        logger.info(`[${sellerId}] Egress vía proxy ${raw} (sin auth)`);
        return raw;
    }

    const proxyChain = require('proxy-chain');
    const local = await proxyChain.anonymizeProxy(raw);
    _localEgressProxies.set(sellerId, local);
    logger.info(`[${sellerId}] Egress vía proxy ${local} → reenvía con auth a ${raw.replace(/\/\/[^@]*@/, '//***@')}`);
    return local;
}

export interface SellerInstance {
    sellerId: string;
    client: any;
    sharedState: any;
    stateManager: any;
    queue: Queue;
    worker: Worker;
    pendingMessages: Map<string, any>;
    helpers: any;
    schedulerStarted: boolean;
    reconnectAttempts: number;
    qrTimer: ReturnType<typeof setTimeout> | null;
    botSentMessageIds: Set<string>;  // IDs of messages sent via client.sendMessage — used to distinguish bot vs manual admin in 'message_create'
    stop: () => Promise<void>;
}

/**
 * Identidad del dispositivo vinculado (deviceName/browserName) que WhatsApp muestra
 * en "Dispositivos vinculados" y transmite en el handshake. Se persiste dentro de
 * `authPath` (.wwebjs_auth) para que sea estable entre reinicios de una misma sesión
 * pero se regenere cuando se wipea la sesión (el wipe borra .wwebjs_auth). Valores
 * realistas tipo PC + navegador común, para no transmitir un beacon constante que
 * delate al bot ni correlacione un número quemado con el siguiente.
 */
function _getDeviceIdentity(authPath: string): { deviceName: string; browserName: string } {
    const idFile = path.join(authPath, '.device-identity.json');
    try {
        if (fs.existsSync(idFile)) return JSON.parse(fs.readFileSync(idFile, 'utf8'));
    } catch { /* archivo corrupto → regenerar abajo */ }
    const browsers = ['Chrome', 'Microsoft Edge', 'Firefox', 'Brave', 'Opera'];
    const makes = ['DESKTOP', 'LAPTOP', 'PC'];
    const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
    const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
    const identity = { deviceName: `${pick(makes)}-${tag}`, browserName: pick(browsers) };
    try {
        fs.mkdirSync(authPath, { recursive: true });
        fs.writeFileSync(idFile, JSON.stringify(identity));
    } catch { /* no persistible → se usa igual en memoria */ }
    return identity;
}

function getDataDir(sellerId: string): string {
    const rootDataDir = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? path.join(__dirname, '../../data') : path.join(__dirname, '../..'));
    const dir = path.join(rootDataDir, sellerId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function cleanChromeLocks(authPath: string): void {
    try {
        const lockPatterns = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
        let cleared = 0;
        const checkDir = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir)) {
                const fullPath = path.join(dir, entry);
                if (lockPatterns.some(p => entry.includes(p))) {
                    try { fs.rmSync(fullPath, { force: true }); cleared++; } catch (e) { /* ignore */ }
                } else if (fs.statSync(fullPath).isDirectory()) {
                    checkDir(fullPath);
                }
            }
        };
        checkDir(authPath);
        if (cleared > 0) logger.info(`[POOL] Cleared ${cleared} stale Chrome lock(s) for ${authPath}`);
    } catch (e: any) {
        logger.error('[POOL] Failed to clean Chrome locks:', e.message);
    }
}

class ClientPool {
    private instances: Map<string, SellerInstance> = new Map();
    private knownSellers: Set<string> = new Set();
    private startingPromises: Map<string, Promise<void>> = new Map();
    private initQueue: Promise<void> = Promise.resolve(); // Serialize Chrome startups
    private io: any = null;
    private redlock: any = null;
    private watchdogInterval: ReturnType<typeof setInterval> | null = null;

    setIo(io: any) { this.io = io; }
    setRedlock(redlock: any) { this.redlock = redlock; }

    /** Register a seller as known without starting Chrome. */
    registerSeller(sellerId: string): void {
        this.knownSellers.add(sellerId);
        logger.info(`[POOL] Registered seller: ${sellerId} (lazy — Chrome not started)`);
    }

    /** Get all known seller IDs (registered, whether running or not). */
    getKnownSellers(): string[] {
        return Array.from(this.knownSellers);
    }

    /** Check if a seller is known (registered). */
    isKnown(sellerId: string): boolean {
        return this.knownSellers.has(sellerId);
    }

    /** Start seller if registered but not yet running. Returns immediately if already running. */
    async ensureStarted(sellerId: string): Promise<void> {
        if (this.instances.has(sellerId)) return;
        if (!this.knownSellers.has(sellerId)) {
            logger.warn(`[POOL] ensureStarted: ${sellerId} is not a known seller`);
            return;
        }
        // Deduplicate concurrent start requests for the SAME seller
        if (this.startingPromises.has(sellerId)) {
            return this.startingPromises.get(sellerId);
        }
        // Stagger Chrome launches — starting two at the same instant crashes both.
        // startSeller is fire-and-forget (doesn't await QR scan), so we add a 15s gap.
        const p = this.initQueue = this.initQueue
            .then(() => {
                // Re-check inside the queue — another queued start may have completed first
                if (this.instances.has(sellerId)) {
                    logger.info(`[POOL] Skipping start for ${sellerId} — already running (queued duplicate)`);
                    return;
                }
                return this.startSeller(sellerId);
            })
            .then(() => new Promise<void>(r => setTimeout(r, 15000)))
            .catch(e => logger.error(`[POOL] Failed to start ${sellerId}:`, e.message))
            .finally(() => this.startingPromises.delete(sellerId));
        this.startingPromises.set(sellerId, p);
        return p;
    }

    getSeller(sellerId: string): SellerInstance | undefined {
        return this.instances.get(sellerId);
    }

    getAllSellers(): SellerInstance[] {
        return Array.from(this.instances.values());
    }

    getSellerByPhone(phone: string): SellerInstance | undefined {
        return Array.from(this.instances.values()).find(
            i => i.client?.info?.wid?.user === phone
        );
    }

    async startSeller(sellerId: string): Promise<void> {
        if (this.instances.has(sellerId)) {
            logger.warn(`[POOL] Seller ${sellerId} already running`);
            return;
        }

        logger.info(`[POOL] Starting seller: ${sellerId}`);
        const dataDir = getDataDir(sellerId);
        const authPath = path.join(dataDir, '.wwebjs_auth');
        cleanChromeLocks(authPath);

        // Per-seller state
        const stateManager = createStateManager(sellerId, dataDir);
        await stateManager.loadState();
        stateManager.loadKnowledge();

        // Restore paused users for this specific seller
        await restorePausedUsersFromDB({ pausedUsers: stateManager.pausedUsers }, sellerId).catch((e: any) =>
            logger.error(`[POOL][${sellerId}] Failed to restore paused users:`, e.message)
        );

        // Pending messages map for debounce
        const pendingMessages = new Map<string, any>();

        // Queue + Worker
        const queue = createQueue(sellerId);

        // WhatsApp client — config aligned with main branch (proven to persist sessions)
        const webCachePath = path.join(dataDir, '.wwebjs_cache');

        // El cliente puede ser:
        //  - RemoteClient (modo remoto): la sesión la sostiene la extensión Chrome +
        //    wa-js en la PC del vendedor (su IP, su navegador). Acá no se lanza Chromium;
        //    el adaptador habla con el agente vía AgentHub. Imita la superficie wwebjs,
        //    así que todo lo de abajo (eventos, sendMessage, getChatById) no cambia.
        //  - Client (wwebjs, modo local): Chromium headless local con proxy de egress.
        let client: any;
        if (_isRemoteSeller(sellerId)) {
            logger.info(`[POOL][${sellerId}] Modo REMOTO — sesión vía extensión en la PC del vendedor`);
            client = new RemoteClient(sellerId);
        } else {
            // Egress proxy (jun-2026): rutea la sesión por una IP del mismo país que el
            // teléfono para evitar el flag "impossible travel" de WhatsApp. La resolución
            // (incluido el reenviador local con auth vía proxy-chain) vive en
            // _resolveEgressProxy. Se setea por seller: WA_PROXY_HORACIO=http://user:pass@host:puerto
            // (o WA_PROXY genérico). Sin setear → sale por la IP del host (ej. Railway).
            const proxyArg = await _resolveEgressProxy(sellerId);

            // Identidad del dispositivo vinculado. Antes era constante ('Herbalis CRM' /
            // 'Panel Empresarial') en TODOS los números → un beacon que delataba al bot y
            // correlacionaba un número quemado con el siguiente. Ahora es aleatoria y
            // realista (parece una PC/navegador comunes), estable mientras la sesión vive
            // y regenerada al wipear (vive dentro de .wwebjs_auth, que el wipe borra).
            const device = _getDeviceIdentity(authPath);

            client = new Client({
                authStrategy: new LocalAuth({ clientId: sellerId, dataPath: authPath }),
                deviceName: device.deviceName,
                browserName: device.browserName,
                webVersionCache: {
                    type: 'local',
                    path: webCachePath,
                },
                puppeteer: {
                    headless: true,
                    ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
                    args: [
                        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas', '--disable-gpu',
                        '--no-first-run', '--no-experiments',
                        '--ignore-certificate-errors', '--disable-extensions',
                        '--disable-background-networking', '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-client-side-phishing-detection', '--disable-default-apps',
                        '--disable-hang-monitor', '--disable-prompt-on-repost',
                        '--disable-sync', '--disk-cache-size=0', '--disable-gpu-shader-disk-cache',
                        // Reduce process count per Chrome — Railway containers have PID limits.
                        // Without these, 6 Chrome = ~90 processes → EAGAIN on fork().
                        '--renderer-process-limit=1',      // 1 renderer instead of ~4-6
                        '--disable-site-isolation-trials',  // don't spawn extra renderer per origin
                        // WA Web rara vez usa >150MB de heap — 256 es holgado y ahorra ~50 MB vs 512.
                        '--js-flags=--max-old-space-size=256',
                        // Free cached tiles/images when the tab is idle.
                        '--aggressive-cache-discard',
                        // Silenciar subsistemas que WA Web no usa.
                        '--mute-audio', '--disable-translate', '--disable-speech-api',
                        // Un único --disable-features consolidado (Chromium solo lee uno).
                        '--disable-features=IsolateOrigins,site-per-process,NetworkService,TranslateUI,MediaRouter,DialMediaRouteProvider,OptimizationHints,AudioServiceOutOfProcess',
                        ...(proxyArg ? [`--proxy-server=${proxyArg}`] : []),
                    ],
                    timeout: 120000
                }
            });
        }

        // Track IDs of messages that the bot itself sends via client.sendMessage.
        // Used by the 'message_create' handler to skip echoes of bot-sent messages
        // and only act on messages the admin typed manually from the WhatsApp app.
        const botSentMessageIds = new Set<string>();
        const _origSendMessage = client.sendMessage.bind(client);
        client.sendMessage = async function(...args: any[]) {
            const result = await _origSendMessage(...args);
            const id = result?.id?._serialized;
            if (id) {
                botSentMessageIds.add(id);
                // Auto-evict after 30s — the outgoing handler fires within ms, so 30s is generous.
                setTimeout(() => botSentMessageIds.delete(id), 30000);
            }
            return result;
        };

        // SharedState
        const sharedState: any = {
            sellerId,  // seller identity — used by services (pauseService, adminService, etc.)
            get userState() { return stateManager.userState; },
            get chatResets() { return stateManager.chatResets; },
            get pausedUsers() { return stateManager.pausedUsers; },
            sessionAlerts: [] as any[],
            get config() { return stateManager.config; },
            get knowledge() { return stateManager.multiKnowledge[stateManager.config.activeScript || 'v7']; },
            get multiKnowledge() { return stateManager.multiKnowledge; },
            isConnected: false,
            qrCodeData: null as string | null,
            connectedAt: undefined as number | undefined,
            manualDisconnect: false,
            saveState: stateManager.saveState.bind(stateManager),
            saveKnowledge: stateManager.saveKnowledge.bind(stateManager),
            loadKnowledge: stateManager.loadKnowledge.bind(stateManager),
            reloadKnowledge: stateManager.loadKnowledge.bind(stateManager),
            get availableScripts() { return stateManager.availableScripts; },
            handleAdminCommand: null as any,
            logAndEmit: null as any,
            requestPairingCode: null as any,
            get io() { return this._io; },
            _io: this.io,   // Inherit from pool (set by registerIo at boot)
        };

        // Bot helpers
        const helpers = createBotHelpers({
            sellerId,
            sharedState,
            client,
            userState: stateManager.userState,
            config: stateManager.config,
            pausedUsers: stateManager.pausedUsers,
            redlock: this.redlock
        });

        sharedState.logAndEmit = helpers.logAndEmit;

        // Admin command handler
        async function handleAdminCommand(targetChatId: string | null, commandText: string, isApi: boolean = false, alertSelector: string | null = null) {
            return await handleAdminCommandCtrl(targetChatId, commandText, isApi, sharedState, client, alertSelector);
        }
        sharedState.handleAdminCommand = handleAdminCommand;

        // Pairing code
        sharedState.requestPairingCode = async (phoneNumber: string) => {
            if (!client) throw new Error('Client not initialized');
            try {
                await client.pupPage.exposeFunction('onCodeReceivedEvent', (code: any) => code);
            } catch (e) { /* already exposed */ }
            for (let attempt = 1; attempt <= 5; attempt++) {
                try {
                    await new Promise(r => setTimeout(r, 2000));
                    return await client.requestPairingCode(phoneNumber);
                } catch (e: any) {
                    if (e.message === 't' || e.message.includes('CompanionHelloError') || e.message.includes('rate-overlimit')) {
                        throw new Error('WhatsApp bloqueó temporalmente el número (Rate Limit).');
                    }
                    if (attempt === 5) throw new Error('Error interno de WhatsApp Web.');
                }
            }
        };

        // Worker
        const worker = createWorker(sellerId, {
            processSalesFlow,
            userState: stateManager.userState,
            sharedState,
            client,
            notifyAdmin: helpers.notifyAdmin,
            saveState: stateManager.saveState.bind(stateManager),
            aiService,
            sendMessageWithDelay: helpers.sendMessageWithDelay,
            logAndEmit: helpers.logAndEmit,
            saveOrderToLocal: helpers.saveOrderToLocal,
            cancelLatestOrder: helpers.cancelLatestOrder,
            config: stateManager.config,
            get connectedAt() { return sharedState.connectedAt; }
        });

        // Message handler
        const messageHandler = createMessageHandler({
            sellerId,
            client,
            sharedState,
            userState: stateManager.userState,
            config: stateManager.config,
            pausedUsers: stateManager.pausedUsers,
            pendingMessages,
            botQueue: queue,
            logAndEmit: helpers.logAndEmit,
            notifyAdmin: helpers.notifyAdmin,
            handleAdminCommand,
            saveState: stateManager.saveState.bind(stateManager),
            knowledge: sharedState.knowledge,
            dataDir
        });

        const instance: SellerInstance = {
            sellerId, client, sharedState, stateManager,
            queue, worker, pendingMessages, helpers,
            schedulerStarted: false, reconnectAttempts: 0,
            qrTimer: null,
            botSentMessageIds,
            stop: async () => this.stopSeller(sellerId)
        };

        // --- CLIENT EVENTS ---
        const QR_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour — stop Chrome if QR is never scanned

        client.on('qr', (qr: string) => {
            logger.info(`[POOL][${sellerId}] QR generated`);
            qrcode.generate(qr, { small: true });
            sharedState.qrCodeData = qr;
            if (this.io) {
                this.io.to(sellerId).emit('qr', qr);
                this.io.to('admin').emit('qr', { sellerId, qr });
            }
            prisma.whatsAppSession.upsert({
                where: { sellerId },
                create: { sellerId, status: 'qr_pending' },
                update: { status: 'qr_pending' }
            }).catch(() => {});

            // Start QR timeout — if nobody scans within 10 min, stop this Chrome
            // to free resources for other sellers. It will restart on next web visit.
            if (!instance.qrTimer) {
                instance.qrTimer = setTimeout(() => {
                    if (!sharedState.isConnected && sharedState.qrCodeData) {
                        logger.warn(`[POOL][${sellerId}] QR not scanned in ${QR_TIMEOUT_MS / 60000} min — stopping Chrome to free resources`);
                        if (this.io) this.io.to(sellerId).emit('status_change', { status: 'qr_timeout', sellerId });
                        this.stopSeller(sellerId).catch(() => {});
                    }
                    instance.qrTimer = null;
                }, QR_TIMEOUT_MS);
            }
        });

        client.on('ready', () => {
            logger.info(`[POOL][${sellerId}] ✅ WhatsApp ready!`);
            sharedState.isConnected = true;
            sharedState.qrCodeData = null;
            // connectedAt marca el corte para ignorar el historial viejo del
            // teléfono. Se fija UNA SOLA VEZ por proceso. En modo remoto el agente
            // reemite 'ready' en CADA reconexión/re-emparejado; si lo reseteáramos
            // acá, los leads que escribieron justo antes de una caída quedarían
            // "antes de la conexión" y el bot los descartaría como historial →
            // leads sin responder (reporte de horacio). No se reinicia en reconexión.
            if (!sharedState.connectedAt) sharedState.connectedAt = Math.floor(Date.now() / 1000);
            instance.reconnectAttempts = 0;
            // Cancel QR timeout — session is now active
            if (instance.qrTimer) { clearTimeout(instance.qrTimer); instance.qrTimer = null; }

            const phoneNumber = client.info?.wid?.user || null;

            // Incluir phoneNumber explícito en el payload — el dashboard lo
            // usa para refrescar el header sin tener que esperar al upsert
            // de Prisma o a un fetch posterior.
            if (this.io) {
                this.io.to(sellerId).emit('ready', { info: client.info, phoneNumber, sellerId });
                this.io.to('admin').emit('ready', { info: client.info, phoneNumber, sellerId });
            }

            prisma.whatsAppSession.upsert({
                where: { sellerId },
                create: { sellerId, status: 'connected', phoneNumber, lastSeen: new Date() },
                update: { status: 'connected', phoneNumber, lastSeen: new Date() }
            }).catch(() => {});

            if (!instance.schedulerStarted) {
                startScheduler(sharedState, {
                    notifyAdmin: helpers.notifyAdmin,
                    sendMessageWithDelay: helpers.sendMessageWithDelay,
                    saveState: stateManager.saveState.bind(stateManager),
                    flushState: stateManager.flushState.bind(stateManager),
                    saveOrderToLocal: helpers.saveOrderToLocal
                });
                instance.schedulerStarted = true;
            }
        });

        // Proactive connection health monitoring.
        // WhatsApp Web degrades when the phone sleeps (battery saver / locked screen).
        // Listening to change_state lets us detect TIMEOUT/UNPAIRED early and reconnect
        // before messages start queueing on the phone.
        client.on('change_state', (state: string) => {
            logger.info(`[POOL][${sellerId}] State changed: ${state}`);
            if (this.io) {
                this.io.to(sellerId).emit('status_change', { status: state.toLowerCase(), sellerId });
                this.io.to('admin').emit('status_change', { status: state.toLowerCase(), sellerId });
            }
            if (state === 'TIMEOUT' || state === 'UNPAIRED') {
                // En modo remoto NO tocar: resetState/safeInit reinicializarían el
                // RemoteClient (recreándolo → ventana con instance.client undefined →
                // "getChats of undefined" + doble 'ready'). El UNPAIRED/TIMEOUT del
                // remoto es transitorio (pairing inicial, teléfono dormido); la
                // reconexión la maneja el agente en la PC del vendedor (wwebjs se
                // re-inicializa solo) y la liveness el heartbeat del gateway.
                if (client instanceof RemoteClient) return;
                logger.warn(`[POOL][${sellerId}] Connection degraded (${state}), attempting refresh...`);
                client.resetState().catch(() => {
                    // resetState not available in all versions — fall back to safeInit
                    // which has retry logic and zombie chrome cleanup
                    safeInit().catch((e: any) =>
                        logger.error(`[POOL][${sellerId}] Re-init after ${state} failed:`, e.message)
                    );
                });
            }
        });

        client.on('auth_failure', (msg: string) => {
            logger.error(`[POOL][${sellerId}] Auth failure: ${msg}`);
            sharedState.isConnected = false;
            if (this.io) this.io.to(sellerId).emit('status_change', { status: 'auth_failure', sellerId });
            // Don't wipe session — it may be a transient issue during redeploy.
            // Just clean Chrome locks and retry. Manual wipe is available via /whatsapp-logout.
            cleanChromeLocks(authPath);
            setTimeout(() => safeInit().catch(() => {}), 5000);
        });

        const MAX_RECONNECT = 5;
        const BASE_DELAY = 3000;
        const RECOVERY_DELAY = 5 * 60 * 1000; // 5 min between recovery cycles after MAX_RECONNECT

        client.on('disconnected', (reason: string) => {
            logger.info(`[POOL][${sellerId}] Disconnected: ${reason}`);
            sharedState.isConnected = false;
            sharedState.qrCodeData = null;
            if (this.io) this.io.to(sellerId).emit('status_change', { status: 'disconnected', sellerId });

            prisma.whatsAppSession.upsert({
                where: { sellerId },
                create: { sellerId, status: 'disconnected' },
                update: { status: 'disconnected', lastSeen: new Date() }
            }).catch(() => {});

            if (reason === 'LOGOUT' || reason === 'CONFLICT' || sharedState.manualDisconnect) {
                sharedState.manualDisconnect = false;
                instance.reconnectAttempts = 0;
                setTimeout(() => safeInit().catch(() => {}), 3000);
                return;
            }

            if (instance.reconnectAttempts >= MAX_RECONNECT) {
                logger.error(`[POOL][${sellerId}] Max reconnect attempts reached — will retry in ${RECOVERY_DELAY / 1000}s`);
                helpers.notifyAdmin('❌ Bot desconectado', 'system', `El bot de ${sellerId} no pudo reconectar tras ${MAX_RECONNECT} intentos. Razón: ${reason}. Reintentando en 5 min.`).catch(() => {});
                // Don't give up — schedule a recovery attempt with reset counter
                setTimeout(() => {
                    instance.reconnectAttempts = 0;
                    logger.info(`[POOL][${sellerId}] Recovery cycle — retrying connection...`);
                    safeInit().catch(() => {});
                }, RECOVERY_DELAY);
                return;
            }

            const delay = BASE_DELAY * Math.pow(2, instance.reconnectAttempts);
            instance.reconnectAttempts++;
            logger.info(`[POOL][${sellerId}] Reconnect ${instance.reconnectAttempts}/${MAX_RECONNECT} in ${delay / 1000}s...`);
            // Use safeInit (6 retries with backoff) instead of raw initialize()
            setTimeout(() => safeInit().catch(() => {}), delay);
        });

        client.on('message', messageHandler);

        // Outgoing handler — capta mensajes que el admin escribe manualmente
        // desde el WhatsApp del bot. El evento 'message' NO los emite (solo
        // entrantes); 'message_create' sí emite ambos. Pausa chats nuevos
        // iniciados por admin y registra (logAndEmit) los mensajes manuales para
        // que queden en el historial y se reflejen en el dashboard en tiempo real.
        const outgoingHandler = createOutgoingMessageHandler({
            sellerId,
            userState: stateManager.userState,
            pausedUsers: stateManager.pausedUsers,
            sharedState,
            botSentMessageIds,
            logAndEmit: helpers.logAndEmit,
        });
        client.on('message_create', outgoingHandler);

        const pool = this;
        async function safeInit(): Promise<void> {
            const MAX_INIT = 6;
            for (let attempt = 1; attempt <= MAX_INIT; attempt++) {
                try {
                    logger.info(`[POOL][${sellerId}] Initializing (attempt ${attempt}/${MAX_INIT})...`);
                    await client.initialize();
                    return; // Success — exit loop
                } catch (err: any) {
                    logger.error(`[POOL][${sellerId}] Init failed (${attempt}): ${err.message}`);
                    // Kill zombie Chrome processes for THIS seller only (async to avoid blocking event loop)
                    try {
                        const { exec } = require('child_process');
                        const sellerAuthPattern = path.join(authPath, sellerId).replace(/\\/g, '/');
                        exec(`pkill -9 -f "${sellerAuthPattern}" 2>/dev/null || true`, { timeout: 5000 }, () => {});
                    } catch (e) { /* no matching processes — fine */ }
                    cleanChromeLocks(authPath);

                    if (attempt < MAX_INIT) {
                        const delay = 10000 * attempt; // 10s, 20s, 30s, 40s, 50s
                        logger.info(`[POOL][${sellerId}] Retrying in ${delay / 1000}s...`);
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
            }
            // All attempts failed — do NOT wipe session (it persists across deploys).
            logger.error(`[POOL][${sellerId}] All ${MAX_INIT} init attempts failed. Session preserved. Use /whatsapp-logout to wipe manually if needed.`);
            // Clean up: remove listeners to prevent zombie event handlers, destroy client
            try { client.removeAllListeners(); } catch (e) { /* ignore */ }
            try { await Promise.race([client.destroy(), new Promise(r => setTimeout(r, 5000))]); } catch (e) { /* ignore */ }
            try { await shutdownSellerQueue(queue, worker, sellerId); } catch (e) { /* ignore */ }
            pool.instances.delete(sellerId);
            // Schedule recovery — don't let seller stay dead forever
            if (pool.knownSellers.has(sellerId)) {
                logger.info(`[POOL][${sellerId}] Scheduling recovery in 5 min...`);
                setTimeout(() => {
                    pool.ensureStarted(sellerId).catch(e =>
                        logger.error(`[POOL][${sellerId}] Recovery ensureStarted failed:`, e.message)
                    );
                }, 5 * 60 * 1000);
            }
        }

        this.instances.set(sellerId, instance);
        this.knownSellers.add(sellerId);
        logger.info(`[POOL] Seller ${sellerId} started`);

        // Fire-and-forget — don't await authentication (QR scan can take forever).
        // The initQueue in ensureStarted adds a 15s delay between launches instead.
        safeInit().catch(e => logger.error(`[POOL][${sellerId}] Fatal init error:`, e.message));
    }

    async stopSeller(sellerId: string): Promise<void> {
        const instance = this.instances.get(sellerId);
        if (!instance) return;
        // Delete from map up-front so a concurrent stopSeller (e.g. watchdog
        // racing with a restart) short-circuits instead of double-destroying
        // the same client / queue.
        this.instances.delete(sellerId);

        logger.info(`[POOL] Stopping seller: ${sellerId}`);
        if (instance.qrTimer) { clearTimeout(instance.qrTimer); instance.qrTimer = null; }
        try { await instance.stateManager.flushState(); } catch (e) { /* ignore */ }
        // Remove all listeners before destroy to prevent stale reconnect handlers from firing
        try { instance.client.removeAllListeners(); } catch (e) { /* ignore */ }
        try { await Promise.race([instance.client.destroy(), new Promise(r => setTimeout(r, 5000))]); } catch (e) { /* ignore */ }
        // Hard-kill Chrome if destroy didn't clean it up (prevents PID leaks)
        try {
            const browser = instance.client?.pupBrowser;
            if (browser?.process()) {
                browser.process().kill('SIGKILL');
                logger.info(`[POOL] Hard-killed Chrome for ${sellerId}`);
            }
        } catch (e) { /* already dead — fine */ }
        try { await shutdownSellerQueue(instance.queue, instance.worker, sellerId); } catch (e) { /* ignore */ }

        await prisma.whatsAppSession.upsert({
            where: { sellerId },
            create: { sellerId, status: 'disconnected' },
            update: { status: 'disconnected', lastSeen: new Date() }
        }).catch(() => {});

        logger.info(`[POOL] Seller ${sellerId} stopped`);
    }

    async restartSeller(sellerId: string): Promise<void> {
        await this.stopSeller(sellerId);
        await new Promise(r => setTimeout(r, 2000));
        // Go through initQueue to prevent concurrent Chrome launches
        this.knownSellers.add(sellerId);
        await this.ensureStarted(sellerId);
    }

    /**
     * Wipe session directory and start fresh (forces new QR scan).
     * Borra TANTO `.wwebjs_auth` (perfil Chromium + sesión WA, donde vive el
     * device fingerprint) COMO `.wwebjs_cache` (build de WhatsApp Web). Reusar
     * un perfil viejo entre números distintos correlaciona el dispositivo y hace
     * que WhatsApp banee el número nuevo en el handshake (ban evasion detection),
     * por eso el wipe debe dejar el perfil 100% virgen, no solo cerrar sesión.
     */
    async wipeSessionAndRestart(sellerId: string): Promise<void> {
        if (this.instances.has(sellerId)) {
            await this.stopSeller(sellerId);
        }
        const dataDir = getDataDir(sellerId);
        const authPath = path.join(dataDir, '.wwebjs_auth');
        const cachePath = path.join(dataDir, '.wwebjs_cache');
        for (const p of [authPath, cachePath]) {
            if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true, force: true });
                logger.info(`[POOL] Wiped ${path.basename(p)} for ${sellerId}: ${p}`);
            }
        }
        // Go through initQueue to prevent concurrent Chrome launches
        this.knownSellers.add(sellerId);
        await this.ensureStarted(sellerId);
    }

    async stopAll(): Promise<void> {
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);
        await Promise.all(Array.from(this.instances.keys()).map(id => this.stopSeller(id)));
    }

    /** Register Socket.IO server (called after startServer) */
    registerIo(io: any): void {
        this.io = io;
        // Inject io into all running instances
        for (const instance of this.instances.values()) {
            instance.sharedState._io = io;
        }
        // Start watchdog after IO is ready (all sellers registered by now)
        this.startWatchdog();
    }

    /**
     * Periodic health check — detects zombie Chrome (connected flag true but
     * page unresponsive) and restarts affected sellers.
     * Runs every 3 minutes. Only acts on instances that claim to be connected.
     */
    private startWatchdog(): void {
        if (this.watchdogInterval) return;
        const WATCHDOG_MS = 3 * 60 * 1000;

        this.watchdogInterval = setInterval(async () => {
            for (const [sellerId, instance] of this.instances) {
                if (!instance.sharedState.isConnected) continue;
                // Clientes remotos no tienen Chrome local que vigilar (pupPage es
                // undefined a propósito): su liveness la cubre el heartbeat del
                // gateway (onAgentOffline → 'disconnected'). Sin este skip, el
                // watchdog los mataba cada 3 min con "Page closed".
                if (instance.client instanceof RemoteClient) continue;
                try {
                    // Lightweight health check — evaluate JS in the WA page
                    const page = instance.client?.pupPage;
                    if (!page || page.isClosed()) throw new Error('Page closed');
                    await Promise.race([
                        page.evaluate(() => document.title),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
                    ]);
                } catch (e: any) {
                    logger.error(`[WATCHDOG] ${sellerId} health check failed: ${e.message} — restarting`);
                    instance.sharedState.isConnected = false;
                    if (this.io) this.io.to(sellerId).emit('status_change', { status: 'reconnecting', sellerId });
                    this.restartSeller(sellerId).catch(err =>
                        logger.error(`[WATCHDOG] ${sellerId} restart failed:`, err.message)
                    );
                }
            }
        }, WATCHDOG_MS);
    }
}

// Singleton export
export const clientPool = new ClientPool();
