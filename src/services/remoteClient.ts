/**
 * remoteClient.ts
 * Adaptador que imita la superficie de `whatsapp-web.js` Client usada por el bot,
 * pero en vez de manejar un Chromium headless local, habla con el "cliente fino"
 * (extensión Chrome + wa-js) que corre en la PC del vendedor vía el AgentHub
 * (ver agentBridge.ts).
 *
 * Objetivo: que `clientPool` pueda hacer `new RemoteClient(...)` en lugar de
 * `new Client({...})` y que TODO lo de abajo (messageHandler, salesFlow,
 * adminService, chat.routes) siga funcionando sin cambios, porque la superficie
 * (eventos + métodos) calza con la de whatsapp-web.js.
 *
 * Superficie replicada (lo que el bot realmente usa — verificado por grep):
 *   eventos:  qr, ready, change_state, auth_failure, disconnected, message, message_create
 *   métodos:  sendMessage, getChatById().{sendStateTyping,sendSeen,fetchMessages},
 *             getChats, getContactById, initialize, destroy, removeAllListeners, resetState
 *   props:    info.wid.user
 */

import { EventEmitter } from 'events';
import { agentHub, AgentFrame, AgentSink } from './agentBridge';
const logger = require('../utils/logger');

const RPC_TIMEOUT_MS = 30000;

/** Proxy de un mensaje entrante con la forma que espera el bot (campos wwebjs). */
interface RemoteMessage {
    getChat: () => Promise<any>;
    getContact: () => Promise<any>;
    id: { _serialized: string };
    from: string;
    to?: string;
    body: string;
    type: string;
    hasMedia: boolean;
    timestamp: number;
    author?: string;
    fromMe: boolean;
    downloadMedia: () => Promise<{ mimetype: string; data: string; filename?: string } | undefined>;
}

export class RemoteClient extends EventEmitter implements AgentSink {
    private sellerId: string;
    private rpcSeq = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
    private _info: { wid: { user: string } } | null = null;
    private _ready = false;

    constructor(sellerId: string) {
        super();
        this.sellerId = sellerId;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Ciclo de vida (imita Client.initialize / destroy)
    // ─────────────────────────────────────────────────────────────────────────

    /** No lanza ningún Chromium: solo se registra para recibir frames del agente. */
    async initialize(): Promise<void> {
        agentHub.bind(this.sellerId, this);
        logger.info(`[REMOTE][${this.sellerId}] Adaptador listo — esperando agente (extensión)`);
        // No emitimos 'ready' acá: se emite cuando el agente reporta `ready`
        // (WA Web logueado). Si el agente ya estaba online, onAgentOnline ya corrió.
    }

    async destroy(): Promise<void> {
        agentHub.unbind(this.sellerId);
        this._rejectAllPending('client destroyed');
        this._ready = false;
    }

    /** Compat: en remoto no hay estado de Puppeteer que resetear. No-op resuelto
     *  para que el handler de change_state no caiga al safeInit (que asume Chrome). */
    async resetState(): Promise<void> { /* no aplica en modo remoto */ }

    get info(): { wid: { user: string } } | null { return this._info; }
    get pupBrowser(): undefined { return undefined; }
    get pupPage(): undefined { return undefined; }

    // ─────────────────────────────────────────────────────────────────────────
    // Envío (imita Client.sendMessage)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * content puede ser un string o un MessageMedia (objeto con {mimetype,data,filename}).
     * options: { caption, sendAudioAsVoice }.
     * Devuelve { id: { _serialized } } como wwebjs (el wrap de clientPool lo usa
     * para trackear botSentMessageIds).
     */
    async sendMessage(chatId: string, content: any, options: any = {}): Promise<{ id: { _serialized: string } }> {
        const isMedia = content && typeof content === 'object' && content.data && content.mimetype;
        let result: any;
        if (isMedia) {
            result = await this._rpc({
                t: 'send_media',
                chatId,
                mimetype: content.mimetype,
                data: content.data,
                filename: content.filename || undefined,
                opts: {
                    caption: options.caption ?? '',
                    isPtt: !!options.sendAudioAsVoice,
                },
            });
        } else {
            result = await this._rpc({ t: 'send_text', chatId, text: String(content) });
        }
        const msgId = result?.msgId || `remote_${Date.now()}`;
        return { id: { _serialized: msgId } };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Chat (imita Client.getChatById(...).{sendStateTyping,sendSeen,fetchMessages})
    // ─────────────────────────────────────────────────────────────────────────

    async getChatById(chatId: string): Promise<any> {
        const self = this;
        return {
            id: { _serialized: chatId },
            sendStateTyping: () => { agentHub.send(self.sellerId, { t: 'typing', chatId }); return Promise.resolve(); },
            clearState: () => { agentHub.send(self.sellerId, { t: 'clear_state', chatId }); return Promise.resolve(); },
            sendSeen: () => { agentHub.send(self.sellerId, { t: 'seen', chatId }); return Promise.resolve(); },
            fetchMessages: async (opts: { limit?: number } = {}) => {
                const r = await self._rpc({ t: 'fetch_messages', chatId, limit: opts.limit ?? 50 });
                return (r?.messages || []).map((m: any) => self._wrapMessage(m));
            },
        };
    }

    /** Lista de chats — la usa GET /api/chats del dashboard. El agente manda los
     *  campos que la ruta lee; acá solo les damos la forma wwebjs (id objeto). */
    async getChats(): Promise<any[]> {
        const r = await this._rpc({ t: 'get_chats' });
        return (r?.chats || []).map((c: any) => ({
            id: { _serialized: c.id, user: String(c.id || '').split('@')[0] },
            name: c.name || '',
            isGroup: !!c.isGroup,
            timestamp: c.timestamp || 0,
            unreadCount: c.unreadCount || 0,
            lastMessage: c.lastMessage
                ? {
                      body: c.lastMessage.body || '',
                      hasMedia: !!c.lastMessage.hasMedia,
                      timestamp: c.lastMessage.timestamp || c.timestamp || 0,
                  }
                : null,
        }));
    }

    /** Contacto por id — lo usan resolveChatId y /api/chats para resolver
     *  @lid → @c.us (sin esto las pausas quedaban clavadas bajo el lid). */
    async getContactById(contactId: string): Promise<any> {
        const r = await this._rpc({ t: 'get_contact', contactId });
        if (!r || !r.found) throw new Error(`contacto ${contactId} no encontrado`);
        return {
            id: { _serialized: r.id || contactId },
            number: r.number || null,
            name: r.name || undefined,
            pushname: r.pushname || undefined,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AgentSink — callbacks del AgentHub
    // ─────────────────────────────────────────────────────────────────────────

    onAgentOnline(): void {
        logger.info(`[REMOTE][${this.sellerId}] Agente online`);
        // No es 'ready' todavía: WA Web puede estar pidiendo QR. Esperamos el
        // frame `ready` o `qr` del agente para emitir el evento correspondiente.
        //
        // PERO: en una RECONEXIÓN del WS, wwebjs NO vuelve a disparar 'ready' (ya
        // estaba logueado), así que el agente no manda 'ready' por su cuenta y el
        // flag isConnected queda en false PARA SIEMPRE — el bot vende OK (fluyen los
        // 'incoming') pero el dashboard queda OFFLINE y /chats vacío (caso 2026-06-21).
        // Fix: pedimos un `sync`; el agente responde con un frame `ready` si WA está
        // listo (agent.js case 'sync'), y ahí recién marcamos online. Si NO está listo,
        // no responde 'ready' → seguimos offline (correcto). Fire-and-forget.
        try { agentHub.send(this.sellerId, { t: 'sync' }); }
        catch (e: any) { logger.warn(`[REMOTE][${this.sellerId}] sync on online falló: ${e.message}`); }
    }

    onAgentOffline(reason: string): void {
        this._ready = false;
        this._rejectAllPending(`agent offline: ${reason}`);
        this.emit('disconnected', reason === 'hb timeout' ? 'TIMEOUT' : 'NAVIGATION');
    }

    onAgentFrame(frame: AgentFrame): void {
        switch (frame.t) {
            case 'qr':
                this.emit('qr', frame.data);
                break;
            case 'ready':
                this._info = { wid: { user: frame.phone || '' } };
                this._ready = true;
                this.emit('ready');
                break;
            case 'state':
                this.emit('change_state', frame.state);
                break;
            case 'auth_failure':
                this.emit('auth_failure', frame.message || 'auth failure');
                break;
            case 'incoming':
                this.emit('message', this._wrapMessage(frame.msg));
                break;
            case 'outgoing':
                this.emit('message_create', this._wrapMessage(frame.msg));
                break;
            case 'ack':
                this._resolveRpc(frame);
                break;
            default:
                // frame desconocido — ignorar (forward-compat)
                break;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internos
    // ─────────────────────────────────────────────────────────────────────────

    /** Construye el proxy de mensaje con la forma wwebjs que espera el bot. */
    private _wrapMessage(m: any): RemoteMessage {
        const self = this;
        const serialized = m.id?._serialized || m.id || `remote_${Date.now()}`;
        return {
            id: { _serialized: serialized },
            from: m.from,
            to: m.to,
            body: m.body ?? '',
            type: m.type ?? 'chat',
            hasMedia: !!m.hasMedia,
            timestamp: m.timestamp ?? Math.floor(Date.now() / 1000),
            author: m.author,
            fromMe: !!m.fromMe,
            downloadMedia: async () => {
                if (!m.hasMedia) return undefined;
                const r = await self._rpc({ t: 'download', msgId: serialized });
                if (!r || !r.data) return undefined;
                return { mimetype: r.mimetype, data: r.data, filename: r.filename };
            },
            // messageHandler llama msg.getChat() (isGroup + sendStateRecording) y
            // msg.getContact() (resolución @lid → teléfono real). Sin esto, TODO
            // mensaje entrante moría con "msg.getChat is not a function".
            getChat: async () => {
                const chat = await self.getChatById(m.from);
                return {
                    ...chat,
                    isGroup: String(m.from || '').endsWith('@g.us'),
                    sendStateRecording: () => Promise.resolve(),  // cosmético — no hay comando remoto
                };
            },
            getContact: async () => {
                const r = await self._rpc({ t: 'get_contact', contactId: m.author || m.from });
                if (!r || !r.found) return null;
                return {
                    id: { _serialized: r.id || m.from },
                    number: r.number || null,
                    name: r.name || undefined,
                    pushname: r.pushname || undefined,
                };
            },
        };
    }

    /** RPC request/response sobre el AgentHub, correlacionado por `id`. */
    private _rpc(frame: AgentFrame): Promise<any> {
        const id = ++this.rpcSeq;
        const sent = agentHub.send(this.sellerId, { ...frame, id });
        if (!sent) return Promise.reject(new Error(`Agente de ${this.sellerId} no conectado`));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RPC '${frame.t}' timeout (${RPC_TIMEOUT_MS}ms)`));
            }, RPC_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
        });
    }

    private _resolveRpc(frame: AgentFrame): void {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(frame.id);
        if (frame.ok === false) entry.reject(new Error(frame.error || 'RPC failed'));
        else entry.resolve(frame.result || {});
    }

    private _rejectAllPending(reason: string): void {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        }
        this.pending.clear();
    }
}
