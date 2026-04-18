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
const { createMessageHandler } = require('../handlers/messageHandler');
const { createQueue, createWorker, shutdownSellerQueue } = require('./queueService');
const { processSalesFlow } = require('../flows/salesFlow');
const { aiService } = require('./ai');
const { startScheduler } = require('./scheduler');
const { restorePausedUsersFromDB } = require('./pauseService');
const { handleAdminCommand: handleAdminCommandCtrl } = require('./adminService');
const { buildConfirmationMessage } = require('../utils/messageTemplates');
const { vncManager } = require('./vncManager');

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
    headful: boolean;  // true = Xvfb+x11vnc+headful Chromium, false = plain headless
    stop: () => Promise<void>;
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
    private switchingPromises: Map<string, Promise<void>> = new Map(); // headful↔headless mutex
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

    async startSeller(sellerId: string, opts?: { headful?: boolean }): Promise<void> {
        if (this.instances.has(sellerId)) {
            logger.warn(`[POOL] Seller ${sellerId} already running`);
            return;
        }

        const wantHeadful = !!opts?.headful;
        logger.info(`[POOL] Starting seller: ${sellerId}${wantHeadful ? ' (headful/VNC)' : ''}`);
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

        // Start per-seller Xvfb+x11vnc only when the caller explicitly asks for
        // headful mode (lazy: only while a viewer is connected). Returns null
        // when ENABLE_VNC != 'true' so Chromium falls back to headless mode.
        const vnc = wantHeadful ? await vncManager.startForSeller(sellerId) : null;

        // WhatsApp client — config aligned with main branch (proven to persist sessions)
        const webCachePath = path.join(dataDir, '.wwebjs_cache');
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: sellerId, dataPath: authPath }),
            deviceName: 'Herbalis CRM',
            browserName: 'Panel Empresarial',
            webVersionCache: {
                type: 'local',
                path: webCachePath,
            },
            puppeteer: {
                headless: vnc ? false : true,
                ...(vnc && { env: { ...process.env, DISPLAY: vnc.display } }),
                ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
                args: [
                    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas', '--disable-gpu',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--no-first-run', '--disable-features=NetworkService', '--no-experiments',
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
                    // Memory limits per Chromium — prevent one instance from starving others
                    '--js-flags=--max-old-space-size=512',
                    // Fixed window size so Chromium fills the Xvfb screen (no WM exists).
                    // --kiosk hides tabs/address bar so the viewer sees only WA content.
                    ...(vnc ? ['--window-size=1920,1080', '--window-position=0,0', '--kiosk'] : []),
                ],
                timeout: 120000
            }
        });

        // SharedState
        const sharedState: any = {
            sellerId,  // seller identity — used by services (pauseService, adminService, etc.)
            get userState() { return stateManager.userState; },
            get chatResets() { return stateManager.chatResets; },
            get pausedUsers() { return stateManager.pausedUsers; },
            sessionAlerts: [] as any[],
            get config() { return stateManager.config; },
            get knowledge() { return stateManager.multiKnowledge[stateManager.config.activeScript || 'v3']; },
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
            headful: !!vnc,
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
            sharedState.connectedAt = Math.floor(Date.now() / 1000);
            instance.reconnectAttempts = 0;
            // Cancel QR timeout — session is now active
            if (instance.qrTimer) { clearTimeout(instance.qrTimer); instance.qrTimer = null; }

            if (this.io) {
                this.io.to(sellerId).emit('ready', { info: client.info, sellerId });
                this.io.to('admin').emit('ready', { info: client.info, sellerId });
            }

            const phoneNumber = client.info?.wid?.user || null;
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
            try { vncManager.stopForSeller(sellerId); } catch (e) { /* ignore */ }
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
        // Tear down Xvfb + x11vnc for this seller (no-op if VNC is disabled)
        try { vncManager.stopForSeller(sellerId); } catch (e) { /* ignore */ }

        await prisma.whatsAppSession.upsert({
            where: { sellerId },
            create: { sellerId, status: 'disconnected' },
            update: { status: 'disconnected', lastSeen: new Date() }
        }).catch(() => {});

        this.instances.delete(sellerId);
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
     * Swap a running seller into headful+VNC mode. Idempotent: if already
     * headful, returns the existing VNC port. Serialized per-seller via
     * switchingPromises to prevent concurrent stops/starts from racing.
     *
     * Note: returns as soon as Xvfb+x11vnc are up and the new Chromium has been
     * spawned. WhatsApp Web still needs ~10-20s after that to reconnect via
     * LocalAuth; the noVNC client will show a blank/grey screen until then.
     */
    async enableHeadful(sellerId: string): Promise<{ port: number } | null> {
        if (!vncManager.isEnabled()) return null;

        const existing = this.switchingPromises.get(sellerId);
        if (existing) await existing;

        const current = this.instances.get(sellerId);
        if (current?.headful) {
            const port = vncManager.getPort(sellerId);
            return port ? { port } : null;
        }

        const p = (async () => {
            if (this.instances.has(sellerId)) {
                await this.stopSeller(sellerId);
                await new Promise(r => setTimeout(r, 2000));
            }
            this.knownSellers.add(sellerId);
            await this.startSeller(sellerId, { headful: true });
        })();
        this.switchingPromises.set(sellerId, p);
        try { await p; } finally { this.switchingPromises.delete(sellerId); }

        const port = vncManager.getPort(sellerId);
        return port ? { port } : null;
    }

    /**
     * Tear down headful/VNC for a seller and return it to plain headless.
     * No-op if the seller is already headless or not running.
     */
    async disableHeadful(sellerId: string): Promise<void> {
        const existing = this.switchingPromises.get(sellerId);
        if (existing) await existing;

        const current = this.instances.get(sellerId);
        if (!current || !current.headful) return;

        const p = (async () => {
            await this.stopSeller(sellerId);
            await new Promise(r => setTimeout(r, 2000));
            this.knownSellers.add(sellerId);
            await this.startSeller(sellerId, { headful: false });
        })();
        this.switchingPromises.set(sellerId, p);
        try { await p; } finally { this.switchingPromises.delete(sellerId); }
    }

    /** Wipe session directory and start fresh (forces new QR scan). */
    async wipeSessionAndRestart(sellerId: string): Promise<void> {
        if (this.instances.has(sellerId)) {
            await this.stopSeller(sellerId);
        }
        const dataDir = getDataDir(sellerId);
        const authPath = path.join(dataDir, '.wwebjs_auth');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            logger.info(`[POOL] Wiped session for ${sellerId}: ${authPath}`);
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
