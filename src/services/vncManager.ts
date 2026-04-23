import { spawn, ChildProcess } from 'child_process';
const logger = require('../utils/logger');

/**
 * VNC manager — spawns a dedicated Xvfb + x11vnc per seller so a headful
 * Chromium can render to a virtual display and be viewed remotely.
 *
 * Gated by ENABLE_VNC=true. When disabled, start() returns null and clientPool
 * launches Chromium in its original headless mode.
 *
 * Each seller gets:
 *   - Xvfb on display :(99+slot) with a 1280x900x24 screen
 *   - x11vnc on 127.0.0.1:(5900+slot), listen-localhost only (proxied via Express WS)
 *
 * Slots are assigned sequentially per process. A freed slot is NOT reused in
 * the same process to avoid racing xvfb tear-down — restart of the seller
 * allocates a new one. Long-lived process growth is bounded by seller count.
 */

interface SellerVnc {
    slot: number;
    displayNum: number;
    vncPort: number;
    xvfb: ChildProcess;
    x11vnc: ChildProcess;
}

const ENABLED = process.env.ENABLE_VNC === 'true';
const DISPLAY_BASE = 99;
const PORT_BASE = 5900;
// 1366x768 is half the framebuffer of 1920x1080 (~3 MB vs ~6 MB) and aligns
// with the typical admin laptop viewport — less letterboxing than it looks.
// Override with VNC_SCREEN_SIZE if you need the full 1080p surface.
const SCREEN_SIZE = process.env.VNC_SCREEN_SIZE || '1366x768x24';

class VncManager {
    private sessions: Map<string, SellerVnc> = new Map();
    private nextSlot = 0;

    isEnabled(): boolean {
        return ENABLED;
    }

    async startForSeller(sellerId: string): Promise<{ display: string; port: number } | null> {
        if (!ENABLED) return null;
        const existing = this.sessions.get(sellerId);
        if (existing) {
            return { display: `:${existing.displayNum}`, port: existing.vncPort };
        }

        const slot = this.nextSlot++;
        const displayNum = DISPLAY_BASE + slot;
        const vncPort = PORT_BASE + slot;

        // Xvfb — virtual framebuffer. -ac disables host-based access control.
        // +extension RANDR lets x11vnc advertise ExtendedDesktopSize so the
        // noVNC client can request a resize that matches its window.
        const xvfb = spawn('Xvfb', [
            `:${displayNum}`,
            '-screen', '0', SCREEN_SIZE,
            '-nolisten', 'tcp',
            '-ac',
            '+extension', 'RANDR',
        ], { stdio: 'ignore' });
        xvfb.on('exit', (code) => logger.warn(`[VNC][${sellerId}] Xvfb :${displayNum} exited (${code})`));
        xvfb.on('error', (err) => logger.error(`[VNC][${sellerId}] Xvfb spawn error: ${err.message}`));

        // Give Xvfb a moment to bind the display before x11vnc tries to attach.
        await new Promise(r => setTimeout(r, 1000));

        const x11vnc = spawn('x11vnc', [
            '-display', `:${displayNum}`,
            '-forever',        // don't exit after the first viewer disconnects
            '-shared',         // allow multiple simultaneous viewers
            '-noxdamage',      // more stable in headless envs
            '-nopw',           // no VNC password — auth is enforced in the Express WS proxy
            '-rfbport', String(vncPort),
            '-localhost',      // listen only on 127.0.0.1; external access is via the authenticated WS proxy
            '-quiet',
            '-xkb',
            '-xrandr', 'resize',  // honour client-initiated resize via RandR
        ], { stdio: 'ignore' });
        x11vnc.on('exit', (code) => logger.warn(`[VNC][${sellerId}] x11vnc exited (${code})`));
        x11vnc.on('error', (err) => logger.error(`[VNC][${sellerId}] x11vnc spawn error: ${err.message}`));

        this.sessions.set(sellerId, { slot, displayNum, vncPort, xvfb, x11vnc });
        logger.info(`[VNC][${sellerId}] Started — display :${displayNum}, port ${vncPort}`);
        return { display: `:${displayNum}`, port: vncPort };
    }

    stopForSeller(sellerId: string): void {
        const s = this.sessions.get(sellerId);
        if (!s) return;
        this.sessions.delete(sellerId);
        try { s.x11vnc.kill('SIGTERM'); } catch { /* ignore */ }
        try { s.xvfb.kill('SIGTERM'); } catch { /* ignore */ }
        // Force-kill fallback in case SIGTERM is ignored
        setTimeout(() => {
            try { if (!s.x11vnc.killed) s.x11vnc.kill('SIGKILL'); } catch { /* ignore */ }
            try { if (!s.xvfb.killed) s.xvfb.kill('SIGKILL'); } catch { /* ignore */ }
        }, 3000);
        logger.info(`[VNC][${sellerId}] Stopped (display :${s.displayNum})`);
    }

    getPort(sellerId: string): number | null {
        return this.sessions.get(sellerId)?.vncPort ?? null;
    }

    getActiveSellers(): string[] {
        return Array.from(this.sessions.keys());
    }

    isActive(sellerId: string): boolean {
        return this.sessions.has(sellerId);
    }
}

export const vncManager = new VncManager();
