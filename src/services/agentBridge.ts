/**
 * agentBridge.ts
 * Gateway WSS para el "cliente fino" (app Electron + wa-js) que corre en la PC del
 * vendedor y sostiene la sesión real de WhatsApp Web (su IP, su navegador).
 *
 * La PC del vendedor disca HACIA Railway (wss://.../agent) — cero puertos abiertos
 * en la casa del vendedor. El primer frame debe ser `auth` con sellerId + token.
 * Una vez autenticado, el socket queda asociado al sellerId y el AgentHub enruta
 * frames entre ese socket y el RemoteClient del mismo seller (ver remoteClient.ts).
 *
 * El AgentHub NO conoce la lógica del bot: solo transporta frames. La traducción
 * a la superficie de whatsapp-web.js vive en RemoteClient.
 */

import type { Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
const logger = require('../utils/logger');

export interface AgentFrame {
    t: string;
    [k: string]: any;
}

/** Interfaz que el RemoteClient implementa para recibir eventos del agente. */
export interface AgentSink {
    onAgentOnline(): void;
    onAgentOffline(reason: string): void;
    onAgentFrame(frame: AgentFrame): void;
}

const HB_TIMEOUT_MS = 45000; // sin heartbeat en 45s → agente considerado caído
// Grace inicial tras conectar: el 1er hb del agente llega recién a +15s y, con la
// PC/WA Web recién despertada, puede demorarse más. Armar el watchdog en 45s desde
// el auth mataba sockets sanos (flapping). Damos margen solo para el primer latido.
const HB_FIRST_TIMEOUT_MS = 75000;

class AgentHub {
    private wss: WebSocketServer | null = null;
    private sockets = new Map<string, WebSocket>();   // sellerId → socket activo
    private sinks = new Map<string, AgentSink>();      // sellerId → RemoteClient
    private hbTimers = new Map<string, NodeJS.Timeout>();

    /** Monta el WSS sobre el mismo httpServer de Express, en el path /agent. */
    attach(server: HttpServer): void {
        if (this.wss) return;
        this.wss = new WebSocketServer({ noServer: true });
        server.on('upgrade', (req, socket, head) => {
            let pathname = '';
            try { pathname = new URL(req.url || '', 'http://x').pathname; } catch { /* url inválida */ }
            if (pathname !== '/agent') return; // no es nuestro → lo maneja socket.io u otro
            this.wss!.handleUpgrade(req, socket as any, head, (ws) => this._onConnection(ws, req));
        });
        logger.info('[AGENT] Gateway montado en /agent');
    }

    /** El RemoteClient se registra para recibir los frames de su agente. */
    bind(sellerId: string, sink: AgentSink): void {
        this.sinks.set(sellerId, sink);
        // Si el agente ya estaba conectado (RemoteClient creado después del socket),
        // notificar online inmediatamente.
        if (this.sockets.has(sellerId)) sink.onAgentOnline();
    }

    /**
     * Cierra de verdad el socket del agente y limpia su watchdog, además de
     * soltar el sink. Lo llama RemoteClient.destroy() en un stop deliberado
     * (admin, shutdown, restart). Antes solo se soltaba el sink y el socket
     * quedaba HUÉRFANO (vivo, latiendo) — al reconectar el seller disparaba
     * doble-ready + hb-timeout (flapping). El agente reconecta solo después.
     */
    dispose(sellerId: string): void {
        this.sinks.delete(sellerId);
        const ws = this.sockets.get(sellerId);
        if (ws) {
            this.sockets.delete(sellerId);
            try { ws.close(4006, 'seller stopped'); } catch { /* noop */ }
        }
        const t = this.hbTimers.get(sellerId);
        if (t) { clearTimeout(t); this.hbTimers.delete(sellerId); }
    }

    /** ¿Hay un agente conectado para este seller? */
    isOnline(sellerId: string): boolean {
        return this.sockets.has(sellerId);
    }

    /** Envía un frame al agente del seller. Devuelve false si no hay agente. */
    send(sellerId: string, frame: AgentFrame): boolean {
        const ws = this.sockets.get(sellerId);
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify(frame));
            return true;
        } catch (e: any) {
            logger.error(`[AGENT][${sellerId}] Error enviando frame:`, e.message);
            return false;
        }
    }

    private _onConnection(ws: WebSocket, _req: IncomingMessage): void {
        let sellerId: string | null = null;
        let authed = false;

        // Timeout de auth — si no se autentica en 10s, cerrar.
        const authTimer = setTimeout(() => {
            if (!authed) { try { ws.close(4001, 'auth timeout'); } catch { /* ya cerrado */ } }
        }, 10000);

        ws.on('message', (raw) => {
            let frame: AgentFrame;
            try { frame = JSON.parse(raw.toString()); } catch { return; }

            // --- Auth (primer frame obligatorio) ---
            if (!authed) {
                if (frame.t !== 'auth' || !frame.sellerId || !frame.token) {
                    try { ws.close(4002, 'auth required'); } catch { /* noop */ }
                    return;
                }
                if (!this._validToken(frame.sellerId, frame.token)) {
                    logger.warn(`[AGENT][${frame.sellerId}] Token inválido — rechazado`);
                    try { ws.close(4003, 'invalid token'); } catch { /* noop */ }
                    return;
                }
                authed = true;
                sellerId = frame.sellerId;
                clearTimeout(authTimer);
                this._attachSocket(sellerId, ws);
                return;
            }

            // --- Heartbeat ---
            if (frame.t === 'hb') {
                this._resetHb(sellerId!, ws);
                return;
            }

            // --- Resto de frames → al RemoteClient ---
            const sink = this.sinks.get(sellerId!);
            if (sink) sink.onAgentFrame(frame);
        });

        ws.on('close', () => {
            clearTimeout(authTimer);
            if (sellerId) this._detachSocket(sellerId, ws, 'socket closed');
        });

        ws.on('error', (e) => {
            logger.warn(`[AGENT][${sellerId || '?'}] Socket error: ${e.message}`);
        });
    }

    private _attachSocket(sellerId: string, ws: WebSocket): void {
        // Reemplazar socket previo del mismo seller (reconexión).
        const prev = this.sockets.get(sellerId);
        if (prev && prev !== ws) { try { prev.close(4004, 'replaced'); } catch { /* noop */ } }
        this.sockets.set(sellerId, ws);
        this._resetHb(sellerId, ws, HB_FIRST_TIMEOUT_MS);
        logger.info(`[AGENT][${sellerId}] Agente conectado`);
        const sink = this.sinks.get(sellerId);
        if (sink) sink.onAgentOnline();
    }

    private _detachSocket(sellerId: string, ws: WebSocket, reason: string): void {
        // Solo desasociar si el que se cae es el socket vigente (no un reemplazado).
        if (this.sockets.get(sellerId) !== ws) return;
        this.sockets.delete(sellerId);
        const t = this.hbTimers.get(sellerId);
        if (t) { clearTimeout(t); this.hbTimers.delete(sellerId); }
        logger.info(`[AGENT][${sellerId}] Agente desconectado (${reason})`);
        const sink = this.sinks.get(sellerId);
        if (sink) sink.onAgentOffline(reason);
    }

    private _resetHb(sellerId: string, ws: WebSocket, timeoutMs: number = HB_TIMEOUT_MS): void {
        const prev = this.hbTimers.get(sellerId);
        if (prev) clearTimeout(prev);
        this.hbTimers.set(sellerId, setTimeout(() => {
            logger.warn(`[AGENT][${sellerId}] Sin heartbeat en ${timeoutMs / 1000}s — cerrando socket`);
            try { ws.close(4005, 'hb timeout'); } catch { /* noop */ }
            this._detachSocket(sellerId, ws, 'hb timeout');
        }, timeoutMs));
    }

    private _validToken(sellerId: string, token: string): boolean {
        const expected = process.env[`WA_AGENT_TOKEN_${sellerId.toUpperCase()}`] || process.env.WA_AGENT_TOKEN;
        if (!expected) {
            logger.error(`[AGENT][${sellerId}] No hay WA_AGENT_TOKEN configurado — se rechaza por seguridad`);
            return false;
        }
        return token === expected;
    }
}

// Singleton compartido entre clientPool (lado RemoteClient) y server.js (attach).
export const agentHub = new AgentHub();
