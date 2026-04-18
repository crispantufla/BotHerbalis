import logger from '../utils/logger';

/**
 * WhatsApp Web viewer stream manager.
 *
 * Reuses the existing Puppeteer Chromium that whatsapp-web.js is running,
 * and streams its page via CDP `Page.startScreencast` to authorized sockets.
 * Input events (mouse / keyboard) are dispatched back via CDP `Input.dispatch*`.
 *
 * One CDP session per sellerId. Screencast only runs while watchers > 0,
 * so idle sellers pay zero cost.
 *
 * Authorization: gated by WA_VIEWER_USERS env var (comma-separated Account.name list).
 */

type InputEvent =
    | { type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button?: 'left' | 'middle' | 'right' | 'none'; clickCount?: number; modifiers?: number }
    | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
    | { type: 'keyDown' | 'keyUp' | 'char'; key?: string; code?: string; text?: string; modifiers?: number; windowsVirtualKeyCode?: number };

interface SellerStream {
    cdp: any;
    watchers: Set<string>;
    starting: boolean;
}

// Optional allow-list of Account.name values. Empty = any authenticated account
// can view WhatsApp Web (per-seller scoping still enforced by canViewSeller).
const ALLOWED_USERS = (process.env.WA_VIEWER_USERS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

export function isAuthorizedUser(account: { name?: string | null; role?: string; sellerId?: string | null } | null | undefined): boolean {
    if (!account || !account.name) return false;
    if (ALLOWED_USERS.length === 0) return true;  // no whitelist → allow everyone
    return ALLOWED_USERS.includes(account.name.toLowerCase());
}

export function canViewSeller(
    account: { name?: string | null; sellerId?: string | null } | null | undefined,
    targetSellerId: string
): boolean {
    if (!isAuthorizedUser(account)) return false;
    if (!targetSellerId) return false;
    // Tenant user: locked to their own seller. Global (sellerId=null) can view any.
    if (account?.sellerId && account.sellerId !== targetSellerId) return false;
    return true;
}

export class WaStreamManager {
    private streams: Map<string, SellerStream> = new Map();
    private socketToSeller: Map<string, string> = new Map();

    constructor(private clientPool: any, private io: any) {}

    async start(sellerId: string, socketId: string): Promise<{ ok: boolean; error?: string }> {
        const seller = this.clientPool.getSeller?.(sellerId);
        const page = seller?.client?.pupPage;
        if (!page) return { ok: false, error: 'seller_not_running' };

        // Already streaming for this seller — just add the watcher
        let stream = this.streams.get(sellerId);
        if (stream) {
            stream.watchers.add(socketId);
            this.socketToSeller.set(socketId, sellerId);
            return { ok: true };
        }

        // Create CDP session + start screencast
        stream = { cdp: null, watchers: new Set([socketId]), starting: true };
        this.streams.set(sellerId, stream);
        this.socketToSeller.set(socketId, sellerId);

        try {
            const cdp = await page.target().createCDPSession();
            stream.cdp = cdp;

            cdp.on('Page.screencastFrame', async ({ data, sessionId }: any) => {
                // Broadcast to this seller's watchers only
                const s = this.streams.get(sellerId);
                if (!s) return;
                for (const sid of s.watchers) {
                    this.io.to(sid).emit('wa_view:frame', { sellerId, data });
                }
                try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}
            });

            await cdp.send('Page.startScreencast', {
                format: 'jpeg',
                quality: 55,
                maxWidth: 1280,
                maxHeight: 900,
                everyNthFrame: 2,
            });

            stream.starting = false;
            logger.info(`[WA_STREAM] Started screencast for ${sellerId} (watcher ${socketId})`);
            return { ok: true };
        } catch (e: any) {
            logger.error(`[WA_STREAM] Failed to start for ${sellerId}:`, e.message);
            this.streams.delete(sellerId);
            this.socketToSeller.delete(socketId);
            return { ok: false, error: 'cdp_failed' };
        }
    }

    stopForSocket(socketId: string): void {
        const sellerId = this.socketToSeller.get(socketId);
        if (!sellerId) return;
        this.socketToSeller.delete(socketId);

        const stream = this.streams.get(sellerId);
        if (!stream) return;
        stream.watchers.delete(socketId);

        if (stream.watchers.size === 0) {
            this._teardown(sellerId).catch(e => logger.warn(`[WA_STREAM] teardown error for ${sellerId}:`, e.message));
        }
    }

    private async _teardown(sellerId: string): Promise<void> {
        const stream = this.streams.get(sellerId);
        if (!stream) return;
        this.streams.delete(sellerId);
        try {
            if (stream.cdp) {
                await stream.cdp.send('Page.stopScreencast').catch(() => {});
                await stream.cdp.detach().catch(() => {});
            }
            logger.info(`[WA_STREAM] Stopped screencast for ${sellerId}`);
        } catch (e: any) {
            logger.warn(`[WA_STREAM] cleanup error for ${sellerId}:`, e.message);
        }
    }

    async sendInput(sellerId: string, event: InputEvent): Promise<void> {
        const stream = this.streams.get(sellerId);
        if (!stream?.cdp) return;
        const cdp = stream.cdp;

        try {
            if (event.type === 'mousePressed' || event.type === 'mouseReleased' || event.type === 'mouseMoved') {
                await cdp.send('Input.dispatchMouseEvent', {
                    type: event.type,
                    x: Math.round(event.x),
                    y: Math.round(event.y),
                    button: event.button || 'left',
                    clickCount: event.clickCount ?? (event.type === 'mousePressed' ? 1 : 0),
                    modifiers: event.modifiers || 0,
                });
            } else if (event.type === 'mouseWheel') {
                await cdp.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: Math.round(event.x),
                    y: Math.round(event.y),
                    deltaX: event.deltaX || 0,
                    deltaY: event.deltaY || 0,
                    modifiers: event.modifiers || 0,
                });
            } else if (event.type === 'keyDown' || event.type === 'keyUp' || event.type === 'char') {
                await cdp.send('Input.dispatchKeyEvent', {
                    type: event.type === 'char' ? 'char' : event.type,
                    key: event.key,
                    code: event.code,
                    text: event.text,
                    modifiers: event.modifiers || 0,
                    windowsVirtualKeyCode: event.windowsVirtualKeyCode,
                });
            }
        } catch (e: any) {
            logger.warn(`[WA_STREAM] Input dispatch failed for ${sellerId}: ${e.message}`);
        }
    }
}

let managerSingleton: WaStreamManager | null = null;

export function initWaStream(clientPool: any, io: any): WaStreamManager {
    if (!managerSingleton) {
        managerSingleton = new WaStreamManager(clientPool, io);
    }
    return managerSingleton;
}

export function getWaStream(): WaStreamManager | null {
    return managerSingleton;
}
