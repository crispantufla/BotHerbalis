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
    private io: any = null;
    private redlock: any = null;

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
        // Deduplicate concurrent start requests
        if (this.startingPromises.has(sellerId)) {
            return this.startingPromises.get(sellerId);
        }
        const p = this.startSeller(sellerId).finally(() => this.startingPromises.delete(sellerId));
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

        // Restore paused users
        await restorePausedUsersFromDB({ pausedUsers: stateManager.pausedUsers }).catch((e: any) =>
            logger.error(`[POOL][${sellerId}] Failed to restore paused users:`, e.message)
        );

        // Pending messages map for debounce
        const pendingMessages = new Map<string, any>();

        // Queue + Worker
        const queue = createQueue(sellerId);

        // WhatsApp client
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: sellerId, dataPath: authPath }),
            deviceName: 'Herbalis CRM',
            browserName: 'Panel Empresarial',
            puppeteer: {
                headless: true,
                ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
                args: [
                    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas', '--disable-gpu', '--no-zygote',
                    '--single-process', '--disable-features=IsolateOrigins,site-per-process',
                    '--no-first-run', '--disable-features=NetworkService', '--no-experiments',
                    '--ignore-certificate-errors', '--disable-extensions',
                    '--disable-background-networking', '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-client-side-phishing-detection', '--disable-default-apps',
                ]
            }
        });

        // SharedState
        const sharedState: any = {
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
            _io: null as any,
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
            stop: async () => this.stopSeller(sellerId)
        };

        // --- CLIENT EVENTS ---
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
        });

        client.on('ready', () => {
            logger.info(`[POOL][${sellerId}] ✅ WhatsApp ready!`);
            sharedState.isConnected = true;
            sharedState.qrCodeData = null;
            sharedState.connectedAt = Math.floor(Date.now() / 1000);
            instance.reconnectAttempts = 0;

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

        client.on('auth_failure', (msg: string) => {
            logger.error(`[POOL][${sellerId}] Auth failure: ${msg}`);
            sharedState.isConnected = false;
            if (this.io) this.io.to(sellerId).emit('status_change', { status: 'auth_failure', sellerId });
            const authDir = path.join(dataDir, '.wwebjs_auth');
            try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
            setTimeout(() => safeInit().catch(() => {}), 5000);
        });

        const MAX_RECONNECT = 5;
        const BASE_DELAY = 3000;

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
                logger.error(`[POOL][${sellerId}] Max reconnect attempts reached`);
                helpers.notifyAdmin('❌ Bot desconectado', 'system', `El bot de ${sellerId} no pudo reconectar. Razón: ${reason}.`).catch(() => {});
                return;
            }

            const delay = BASE_DELAY * Math.pow(2, instance.reconnectAttempts);
            instance.reconnectAttempts++;
            logger.info(`[POOL][${sellerId}] Reconnect ${instance.reconnectAttempts}/${MAX_RECONNECT} in ${delay / 1000}s...`);
            setTimeout(() => client.initialize().catch((e: any) => logger.error(`[POOL][${sellerId}] Re-init failed:`, e.message)), delay);
        });

        client.on('message', messageHandler);

        async function safeInit(attempt: number = 1): Promise<void> {
            const MAX_INIT = 3;
            try {
                logger.info(`[POOL][${sellerId}] Initializing (attempt ${attempt}/${MAX_INIT})...`);
                await client.initialize();
            } catch (err: any) {
                logger.error(`[POOL][${sellerId}] Init failed (${attempt}): ${err.message}`);
                if (attempt < MAX_INIT) {
                    cleanChromeLocks(authPath);
                    await new Promise(r => setTimeout(r, 5000 * attempt));
                    return safeInit(attempt + 1);
                } else {
                    logger.error(`[POOL][${sellerId}] All init attempts failed. Bot offline.`);
                }
            }
        }

        this.instances.set(sellerId, instance);
        this.knownSellers.add(sellerId);

        // Start initialization
        safeInit().catch(e => logger.error(`[POOL][${sellerId}] Fatal init error:`, e.message));

        logger.info(`[POOL] Seller ${sellerId} started`);
    }

    async stopSeller(sellerId: string): Promise<void> {
        const instance = this.instances.get(sellerId);
        if (!instance) return;

        logger.info(`[POOL] Stopping seller: ${sellerId}`);
        try { await instance.stateManager.flushState(); } catch (e) { /* ignore */ }
        try { await Promise.race([instance.client.destroy(), new Promise(r => setTimeout(r, 5000))]); } catch (e) { /* ignore */ }
        try { await shutdownSellerQueue(instance.queue, instance.worker); } catch (e) { /* ignore */ }

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
        await this.startSeller(sellerId);
    }

    async stopAll(): Promise<void> {
        await Promise.all(Array.from(this.instances.keys()).map(id => this.stopSeller(id)));
    }

    /** Register Socket.IO server (called after startServer) */
    registerIo(io: any): void {
        this.io = io;
        // Inject io into all running instances
        for (const instance of this.instances.values()) {
            instance.sharedState._io = io;
        }
    }
}

// Singleton export
export const clientPool = new ClientPool();
