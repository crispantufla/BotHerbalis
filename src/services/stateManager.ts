/**
 * stateManager.ts
 * Per-seller state management factory.
 * Creates isolated NodeCache, userState Proxy, and persistence logic for each seller.
 */

import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
const logger = require('../utils/logger');
const { atomicWriteFile } = require('../../safeWrite');
const { prisma } = require('../../db');

interface BotConfig {
    alertNumbers: string[];
    activeScript: string;
    scriptStats: { [script: string]: { started: number; completed: number } };
    alertNumber?: string;
    globalPause?: boolean;
    [key: string]: any;
}

export interface SellerStateManager {
    sellerId: string;
    dataDir: string;
    userState: any;
    chatResets: Record<string, number>;
    pausedUsers: Set<string>;
    config: BotConfig;
    multiKnowledge: Record<string, any>;
    availableScripts: string[];
    saveState: (changedUserId?: string | null) => void;
    flushState: () => Promise<void>;
    saveKnowledge: (scriptName?: string | null) => void;
    loadKnowledge: (scriptName?: string | null) => void;
    loadState: () => Promise<void>;
}

export function createStateManager(sellerId: string, dataDir: string): SellerStateManager {
    const stateFile = path.join(dataDir, `persistence_${sellerId}.json`);

    // Per-seller NodeCache (30-day TTL, no cloning)
    const userCache = new NodeCache({ stdTTL: 2592000, checkperiod: 3600, useClones: false });
    userCache.on('expired', (key: string) => {
        logger.info(`[CACHE][${sellerId}] User state expired for ${key}`);
    });

    // Proxy over cache — same API as before
    const userState = new Proxy({}, {
        get: (_t, prop) => {
            if (prop === 'constructor' || typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
            return userCache.get(prop as string);
        },
        set: (_t, prop: string | symbol, value: any) => {
            if (typeof prop === 'symbol') return true;
            return userCache.set(prop as string, value);
        },
        deleteProperty: (_t, prop) => userCache.del(prop as string) > 0,
        has: (_t, prop) => userCache.has(prop as string),
        ownKeys: () => userCache.keys(),
        getOwnPropertyDescriptor: (_t, prop) => {
            if (userCache.has(prop as string)) return { enumerable: true, configurable: true, value: userCache.get(prop as string) };
            return undefined;
        }
    });

    const chatResets: Record<string, number> = {};
    const pausedUsers = new Set<string>();
    const config: BotConfig = {
        alertNumbers: [],
        activeScript: 'v3',
        scriptStats: { v3: { started: 0, completed: 0 }, v4: { started: 0, completed: 0 } }
    };

    // Knowledge files: load from DATA_DIR first, fallback to source root
    const sourceRoot = path.join(__dirname, '../..');
    const multiKnowledge: Record<string, any> = { v3: { flow: {}, faq: [] }, v4: { flow: {}, faq: [] } };
    const knowledgeFiles: Record<string, { save: string; source: string }> = {
        v3: {
            save: path.join(dataDir, `knowledge_v3_${sellerId}.json`),
            source: path.join(sourceRoot, 'knowledge_v3.json')
        },
        v4: {
            save: path.join(dataDir, `knowledge_v4_${sellerId}.json`),
            source: path.join(sourceRoot, 'knowledge_v4.json')
        }
    };
    const availableScripts = Object.keys(knowledgeFiles);

    function loadKnowledge(_scriptName: string | null = null) {
        try {
            Object.keys(knowledgeFiles).forEach(name => {
                const paths = knowledgeFiles[name];
                const filePath = fs.existsSync(paths.save) ? paths.save : paths.source;
                if (fs.existsSync(filePath)) {
                    multiKnowledge[name] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                    logger.info(`[STATE][${sellerId}] Knowledge loaded: ${name} from ${path.basename(filePath)}`);
                }
            });
        } catch (e: any) {
            logger.error(`[STATE][${sellerId}] Error loading knowledge:`, e.message);
        }
    }

    function saveKnowledge(scriptName: string | null = null) {
        try {
            const name = scriptName || config.activeScript || 'v3';
            const paths = knowledgeFiles[name];
            if (paths && multiKnowledge[name]) {
                atomicWriteFile(paths.save, JSON.stringify(multiKnowledge[name], null, 2));
            }
        } catch (e: any) {
            logger.error(`[STATE][${sellerId}] Error saving knowledge:`, e.message);
        }
    }

    // Debounced persistence with proper serialization (no concurrent writes)
    let _saveTimeout: ReturnType<typeof setTimeout> | null = null;
    const _pendingUsers = new Set<string>();
    let _persistPromise: Promise<void> | null = null;
    let _pendingRetry = false;

    async function _persistState(): Promise<void> {
        // If already running, mark for retry after current finishes (no concurrent writes)
        if (_persistPromise) {
            _pendingRetry = true;
            return;
        }
        _persistPromise = _doPersist();
        try {
            await _persistPromise;
        } finally {
            _persistPromise = null;
            // If another save was requested while we were writing, run it after a short delay
            if (_pendingRetry) {
                _pendingRetry = false;
                setTimeout(() => _persistState(), 1000);
            }
        }
    }

    async function _doPersist(): Promise<void> {
        try {
            const snapshot = { userState, chatResets, pausedUsers: Array.from(pausedUsers), config };
            atomicWriteFile(stateFile, JSON.stringify(snapshot, null, 2));

            const usersToProcess = Array.from(_pendingUsers);
            _pendingUsers.clear();

            const usersToSave = usersToProcess.length > 0
                ? usersToProcess.map(id => [id, userState[id]]).filter(([, v]) => v)
                : Object.entries(userState);

            const userPromises = usersToSave.map(([phone, data]) => {
                const cleanPhone = (phone as string).replace('@c.us', '');
                const lastSeenDate = (data as any)?.lastActivityAt ? new Date((data as any).lastActivityAt) : new Date();
                return prisma.user.upsert({
                    where: { phone_instanceId: { phone: cleanPhone, instanceId: sellerId } },
                    update: { profileData: JSON.stringify(data), lastSeen: lastSeenDate },
                    create: { phone: cleanPhone, instanceId: sellerId, profileData: JSON.stringify(data), lastSeen: lastSeenDate }
                });
            });

            const configPromises = Object.entries(config).map(([key, value]) =>
                prisma.botConfig.upsert({
                    where: { instanceId_key: { instanceId: sellerId, key } },
                    update: { value: JSON.stringify(value) },
                    create: { instanceId: sellerId, key, value: JSON.stringify(value) }
                })
            );

            await Promise.all([...userPromises, ...configPromises]);
        } catch (e: any) {
            logger.error(`[STATE][${sellerId}] Error saving state:`, e.message);
        }
    }

    function saveState(changedUserId: string | null = null): void {
        if (changedUserId) _pendingUsers.add(changedUserId);
        if (_saveTimeout) clearTimeout(_saveTimeout);
        _saveTimeout = setTimeout(() => _persistState(), 5000);
    }

    async function flushState(): Promise<void> {
        if (_saveTimeout) { clearTimeout(_saveTimeout); _saveTimeout = null; }
        await _persistState();
    }

    async function loadState(): Promise<void> {
        try {
            logger.info(`[STATE][${sellerId}] Loading state from PostgreSQL...`);
            let dbUsers: any[] = [];
            let dbConfig: any[] = [];

            try {
                [dbUsers, dbConfig] = await Promise.all([
                    prisma.user.findMany({ where: { instanceId: sellerId } }),
                    prisma.botConfig.findMany({ where: { instanceId: sellerId } })
                ]);
            } catch (dbErr: any) {
                logger.warn(`[STATE][${sellerId}] DB failed, falling back to file: ${dbErr.message}`);
                if (fs.existsSync(stateFile)) {
                    const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
                    Object.assign(config, data.config || {});
                }
                return;
            }

            // Hydrate config
            dbConfig.forEach((c: any) => {
                try { config[c.key] = JSON.parse(c.value); } catch (e) { /* skip malformed */ }
            });

            // Hydrate users
            dbUsers.forEach((u: any) => {
                if (u.profileData) {
                    try { userState[u.phone + '@c.us'] = JSON.parse(u.profileData); } catch (e) { /* skip */ }
                }
            });

            // Load transient state (pausedUsers, chatResets) from file
            if (fs.existsSync(stateFile)) {
                try {
                    const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
                    (data.pausedUsers || []).forEach((id: string) => pausedUsers.add(id));
                    Object.assign(chatResets, data.chatResets || {});
                } catch (e) { /* ignore corrupt file */ }
            }

            // Migrate legacy single alertNumber
            if (config.alertNumber && !config.alertNumbers) {
                config.alertNumbers = [config.alertNumber];
                delete config.alertNumber;
            }
            if (!config.alertNumbers) config.alertNumbers = [];

            logger.info(`[STATE][${sellerId}] Loaded ${dbUsers.length} users, config synced`);
        } catch (e: any) {
            logger.error(`[STATE][${sellerId}] Error loading state:`, e.message);
        }
    }

    return {
        sellerId, dataDir, userState, chatResets, pausedUsers, config,
        multiKnowledge, availableScripts,
        saveState, flushState, saveKnowledge, loadKnowledge, loadState
    };
}
