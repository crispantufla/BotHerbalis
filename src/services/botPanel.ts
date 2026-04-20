/**
 * botPanel.ts
 *
 * Injects a floating control panel into web.whatsapp.com inside the bot's
 * Puppeteer Chromium so that a seller/admin watching via VNC can trigger
 * bot actions (pause, resume, change step, send quick reply, approve admin
 * validation) without leaving WhatsApp Web.
 *
 * Transport: `page.exposeFunction('__botPanelCmd', handler)` bridges panel UI
 * calls directly into the Node backend. No HTTP, no auth — access control is
 * already enforced upstream (only users authorised via VNC reach this Chromium).
 *
 * Injection strategy: `evaluateOnNewDocument` so the panel survives reloads
 * and SPA navigations. Guarded by a window flag so double-installs are no-ops.
 */
import type { SellerInstance } from './clientPool';
const logger = require('../utils/logger');
const { pauseUser, unpauseUser } = require('./pauseService');
const { _setStep } = require('../flows/utils/flowHelpers');
const { FlowStep } = require('../types/state');
const { prisma } = require('../../db');

interface PanelCommand {
    action: string;
    payload?: any;
}

const VALID_STEPS: Set<string> = new Set(Object.values(FlowStep) as string[]);

// Per-instance cache of @lid → @c.us resolutions so we don't hit
// Puppeteer.getContactById every poll tick. Only *successful* resolutions are
// cached; failures are dropped so a transient getContactById hiccup doesn't
// trap the chat in "user_has_no_state" until the seller restarts.
const lidCache: WeakMap<SellerInstance, Map<string, string>> = new WeakMap();

/**
 * Normalise whatever identifier `window.Store.Chat.getActive()` handed the
 * panel into a `<phone>@c.us` JID that the rest of the bot uses as the key
 * for userState, pausedUsers, orders, etc.
 *
 * Modern WhatsApp Web returns `<random>@lid` for chats that came through
 * Meta's LID system; the bot's state is keyed by the real phone. Same
 * resolution path as `messageHandler.ts` uses when a message arrives from
 * an @lid — we just hit it lazily here when the panel requests state.
 */
async function resolveToCus(instance: SellerInstance, raw: string): Promise<string> {
    const id = (raw || '').trim();
    if (!id) return id;
    if (id.endsWith('@c.us')) return id;
    if (!id.includes('@')) return `${id.replace(/\D/g, '')}@c.us`;
    if (!id.includes('@lid')) return id; // leave @g.us / @broadcast as-is; caller will reject

    let cache = lidCache.get(instance);
    if (!cache) { cache = new Map(); lidCache.set(instance, cache); }
    const cached = cache.get(id);
    if (cached) return cached;

    try {
        const contact = await (instance.client as any)?.getContactById(id);
        const number = contact?.number || contact?.id?.user;
        if (number) {
            const resolved = `${String(number).replace(/\D/g, '')}@c.us`;
            cache.set(id, resolved);
            return resolved;
        }
        logger.debug(`[BOT_PANEL][${instance.sellerId}] getContactById(${id}) returned no number — will retry on next tick`);
    } catch (e: any) {
        logger.warn(`[BOT_PANEL][${instance.sellerId}] LID resolve failed for ${id}: ${e.message}`);
    }
    // Don't cache the failure — the next tick will retry and eventually
    // succeed once WA Web finishes populating its contact store.
    return id;
}

// Fields from UserState exposed to the panel. Kept lean to minimise payload
// over the bridge (it runs every few seconds per connected viewer).
function summariseUserState(instance: SellerInstance, phone: string): any {
    const state = instance.stateManager?.userState?.[phone];
    if (!state) return { known: false };
    const address = state.partialAddress || {};
    return {
        known: true,
        step: state.step,
        weightGoal: state.weightGoal ?? null,
        selectedProduct: state.selectedProduct ?? null,
        selectedPlan: state.selectedPlan ?? null,
        totalPrice: state.totalPrice ?? state.price ?? null,
        paymentMethod: state.paymentMethod ?? null,
        isContraReembolsoMAX: !!state.isContraReembolsoMAX,
        address: {
            nombre: address.nombre || null,
            calle: address.calle || null,
            ciudad: address.ciudad || null,
            provincia: address.provincia || null,
            cp: address.cp || null,
        },
        cartItems: Array.isArray(state.cart) ? state.cart.length : 0,
    };
}

async function handlePanelCommand(instance: SellerInstance, cmd: PanelCommand): Promise<any> {
    try {
        switch (cmd.action) {
            case 'ping':
                return { ok: true, sellerId: instance.sellerId };

            case 'getState': {
                const raw = String(cmd.payload?.phone || '').trim();
                if (!raw) return { ok: false, error: 'missing_phone' };
                const phone = await resolveToCus(instance, raw);
                const paused = instance.sharedState?.pausedUsers?.has(phone) || false;
                const summary = summariseUserState(instance, phone);
                return { ok: true, phone, paused, ...summary };
            }

            case 'pause': {
                const raw = String(cmd.payload?.phone || '').trim();
                if (!raw) return { ok: false, error: 'missing_phone' };
                const phone = await resolveToCus(instance, raw);
                const reason = String(cmd.payload?.reason || 'Pausa manual desde panel').slice(0, 200);
                await pauseUser(phone, reason, {
                    sharedState: instance.sharedState,
                    notifyAdmin: instance.helpers?.notifyAdmin,
                    instanceId: instance.sellerId,
                });
                logger.info(`[BOT_PANEL][${instance.sellerId}] Paused ${phone} via panel`);
                return { ok: true };
            }

            case 'resume': {
                const raw = String(cmd.payload?.phone || '').trim();
                if (!raw) return { ok: false, error: 'missing_phone' };
                const phone = await resolveToCus(instance, raw);
                await unpauseUser(phone, instance.sharedState, instance.sellerId);
                logger.info(`[BOT_PANEL][${instance.sellerId}] Resumed ${phone} via panel`);
                return { ok: true };
            }

            case 'setStep': {
                const raw = String(cmd.payload?.phone || '').trim();
                const step = String(cmd.payload?.step || '').trim();
                if (!raw) return { ok: false, error: 'missing_phone' };
                if (!VALID_STEPS.has(step)) return { ok: false, error: `invalid_step: ${step}` };
                const phone = await resolveToCus(instance, raw);
                const state = instance.stateManager?.userState?.[phone];
                if (!state) return { ok: false, error: 'user_has_no_state' };
                _setStep(state, step);
                try { await instance.stateManager.saveState(phone); } catch { /* debounced, ok */ }
                logger.info(`[BOT_PANEL][${instance.sellerId}] Set step of ${phone} to ${step}`);
                return { ok: true };
            }

            case 'resetFlow': {
                const raw = String(cmd.payload?.phone || '').trim();
                if (!raw) return { ok: false, error: 'missing_phone' };
                const phone = await resolveToCus(instance, raw);
                const state = instance.stateManager?.userState?.[phone];
                if (!state) return { ok: false, error: 'user_has_no_state' };
                delete instance.stateManager.userState[phone];
                try { await instance.stateManager.saveState(phone); } catch { /* ignore */ }
                logger.info(`[BOT_PANEL][${instance.sellerId}] Reset flow for ${phone}`);
                return { ok: true };
            }

            case 'listSteps':
                return { ok: true, steps: Array.from(VALID_STEPS).sort() };

            case 'listQuickReplies': {
                const replies = await prisma.quickReply.findMany({
                    where: { instanceId: instance.sellerId },
                    orderBy: { title: 'asc' },
                    select: { id: true, title: true, message: true },
                });
                return { ok: true, replies };
            }

            case 'adminApprove': {
                const raw = String(cmd.payload?.phone || '').trim();
                if (!raw) return { ok: false, error: 'missing_phone' };
                const phone = await resolveToCus(instance, raw);
                const runner = instance.sharedState?.handleAdminCommand;
                if (typeof runner !== 'function') return { ok: false, error: 'handler_unavailable' };
                const reply = await runner(phone, 'ok', true);
                logger.info(`[BOT_PANEL][${instance.sellerId}] Admin approved ${phone} via panel`);
                return { ok: true, message: String(reply || '').slice(0, 400) };
            }

            case 'sendQuickReply': {
                const raw = String(cmd.payload?.phone || '').trim();
                const replyId = String(cmd.payload?.replyId || '').trim();
                if (!raw) return { ok: false, error: 'missing_phone' };
                if (!replyId) return { ok: false, error: 'missing_replyId' };
                const phone = await resolveToCus(instance, raw);
                const reply = await prisma.quickReply.findUnique({ where: { id: replyId } });
                if (!reply) return { ok: false, error: 'reply_not_found' };
                if (reply.instanceId !== instance.sellerId) return { ok: false, error: 'forbidden' };
                const send = instance.helpers?.sendMessageWithDelay;
                if (typeof send !== 'function') return { ok: false, error: 'helpers_unavailable' };
                // Fire and forget — the helper applies its own humanised delay.
                send(phone, reply.message).catch((e: any) =>
                    logger.warn(`[BOT_PANEL][${instance.sellerId}] sendQuickReply failed: ${e.message}`)
                );
                logger.info(`[BOT_PANEL][${instance.sellerId}] Sent quick reply ${reply.title} to ${phone}`);
                return { ok: true };
            }

            default:
                return { ok: false, error: `unknown_action: ${cmd.action}` };
        }
    } catch (e: any) {
        logger.error(`[BOT_PANEL][${instance.sellerId}] Command ${cmd.action} failed: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// CSS as a string; injected into <style> so it survives WA Web's DOM churn.
const PANEL_CSS = `
#__bot-panel {
    position: fixed; top: 12px; right: 12px; z-index: 2147483647;
    background: #0f172a; color: #e5e7eb;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px; line-height: 1.4;
    border: 1px solid #334155; border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    width: 280px; pointer-events: auto;
}
#__bot-panel .__bp-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; border-bottom: 1px solid #1e293b;
    cursor: move; user-select: none;
}
#__bot-panel .__bp-collapse {
    background: transparent; border: none; color: #64748b; cursor: pointer;
    font-size: 16px; line-height: 1; padding: 0 2px;
}
#__bot-panel .__bp-collapse:hover { color: #e2e8f0; }
#__bot-panel.collapsed {
    width: auto; height: auto;
}
#__bot-panel.collapsed .__bp-body { display: none; }
#__bot-panel.collapsed .__bp-header { border-bottom: none; padding: 8px 12px; }
#__bot-panel .__bp-dot {
    width: 7px; height: 7px; border-radius: 50%; background: #10b981;
    flex-shrink: 0;
}
#__bot-panel .__bp-dot.paused { background: #f59e0b; }
#__bot-panel .__bp-dot.unknown { background: #64748b; }
#__bot-panel .__bp-title { flex: 1; font-weight: 600; color: #a5b4fc; font-size: 12px; }
#__bot-panel .__bp-body { padding: 10px 14px; }
#__bot-panel .__bp-chat {
    padding-bottom: 8px; margin-bottom: 8px; border-bottom: 1px solid #1e293b;
}
#__bot-panel .__bp-chat-label { color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
#__bot-panel .__bp-chat-value { color: #e2e8f0; font-weight: 500; margin-top: 2px; word-break: break-all; }
#__bot-panel .__bp-row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; }
#__bot-panel .__bp-row > span:first-child { color: #94a3b8; }
#__bot-panel .__bp-row > strong { color: #e2e8f0; font-weight: 500; text-align: right; word-break: break-word; }
#__bot-panel .__bp-step {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    background: #1e293b; color: #a5b4fc; font-size: 11px; font-family: monospace;
}
#__bot-panel .__bp-empty { color: #64748b; font-style: italic; text-align: center; padding: 12px 0; }
#__bot-panel .__bp-paused-banner {
    margin-top: 8px; padding: 6px 10px; background: #451a03;
    border: 1px solid #f59e0b; border-radius: 6px;
    color: #fbbf24; font-size: 11px;
}
#__bot-panel .__bp-actions {
    margin-top: 10px; padding-top: 10px; border-top: 1px solid #1e293b;
    display: flex; flex-direction: column; gap: 6px;
}
#__bot-panel .__bp-btn {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 6px 10px; border-radius: 6px; border: 1px solid #334155;
    background: #1e293b; color: #e2e8f0; font-size: 11px; font-weight: 500;
    cursor: pointer; transition: all 0.15s; width: 100%;
}
#__bot-panel .__bp-btn:hover { background: #334155; border-color: #475569; }
#__bot-panel .__bp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
#__bot-panel .__bp-btn.danger { background: #7f1d1d; border-color: #991b1b; color: #fca5a5; }
#__bot-panel .__bp-btn.danger:hover { background: #991b1b; }
#__bot-panel .__bp-btn.warn { background: #78350f; border-color: #92400e; color: #fcd34d; }
#__bot-panel .__bp-btn.warn:hover { background: #92400e; }
#__bot-panel .__bp-btn.success { background: #14532d; border-color: #166534; color: #86efac; }
#__bot-panel .__bp-btn.success:hover { background: #166534; }
#__bot-panel .__bp-select-row { display: flex; gap: 6px; }
#__bot-panel select {
    flex: 1; padding: 5px 8px; border-radius: 6px; border: 1px solid #334155;
    background: #1e293b; color: #e2e8f0; font-size: 11px;
    font-family: inherit;
}
#__bot-panel .__bp-toast {
    position: absolute; bottom: -30px; left: 0; right: 0;
    padding: 6px 10px; border-radius: 6px; text-align: center; font-size: 11px;
    background: #1e293b; color: #e2e8f0; opacity: 0; transition: opacity 0.2s;
    pointer-events: none;
}
#__bot-panel .__bp-toast.show { opacity: 1; }
#__bot-panel .__bp-toast.error { background: #7f1d1d; color: #fecaca; }
#__bot-panel .__bp-toast.success { background: #14532d; color: #bbf7d0; }
#__bot-panel .__bp-section {
    margin-top: 10px; padding-top: 10px; border-top: 1px solid #1e293b;
}
#__bot-panel .__bp-section-title {
    color: #94a3b8; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;
}
#__bot-panel .__bp-qr-search {
    width: 100%; padding: 5px 8px; border-radius: 6px; border: 1px solid #334155;
    background: #1e293b; color: #e2e8f0; font-size: 11px; font-family: inherit;
    margin-bottom: 6px;
}
#__bot-panel .__bp-qr-list { max-height: 160px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
#__bot-panel .__bp-qr-item {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-radius: 6px; border: 1px solid #334155;
    background: #1e293b; color: #e2e8f0; cursor: pointer; transition: all 0.15s;
    text-align: left;
}
#__bot-panel .__bp-qr-item:hover { background: #334155; border-color: #6366f1; }
#__bot-panel .__bp-qr-item .__bp-qr-title { flex: 1; font-weight: 500; font-size: 11px; }
#__bot-panel .__bp-qr-item .__bp-qr-preview { color: #64748b; font-size: 10px; margin-top: 2px; }
`;

// Panel HTML skeleton. Actions are populated dynamically from JS based on the
// currently-open chat's state (disabled when no chat is open).
const PANEL_HTML = `
<div class="__bp-header">
    <span class="__bp-dot"></span>
    <span class="__bp-title">Bot Panel</span>
    <button class="__bp-collapse" title="Minimizar (Ctrl+Shift+B)">─</button>
</div>
<div class="__bp-body" style="position:relative">
    <div class="__bp-chat">
        <div class="__bp-chat-label">Chat abierto</div>
        <div class="__bp-chat-value">—</div>
    </div>
    <div class="__bp-state"></div>
    <div class="__bp-actions"></div>
    <div class="__bp-quickreplies"></div>
    <div class="__bp-toast"></div>
</div>
`;

// Script injected into every new document. Waits for the Puppeteer-exposed
// bridge (`window.__botPanelCmd`) to become available, mounts the panel, then
// polls for the active chat and its bot state every 2s.
//
// Chat detection: reads `window.Store.Chat` (exposed by whatsapp-web.js's
// internal init) to find the currently active chat and extract its JID.
// Falls back gracefully if Store isn't ready — the panel just shows "Ninguno".
const INJECT_SCRIPT = `
(function(){
    if (window.__botPanelInjected) return;
    window.__botPanelInjected = true;

    const POLL_MS = 2000;
    const STEP_LABELS = {
        greeting: 'Saludo', general: 'General',
        waiting_weight: 'Peso', waiting_preference: 'Preferencia',
        waiting_preference_consultation: 'Consulta pref.',
        waiting_plan_choice: 'Plan', waiting_price_confirmation: 'Confirmar precio',
        waiting_ok: 'Ok', waiting_data: 'Datos',
        waiting_final_confirmation: 'Confirmación final',
        waiting_admin_ok: 'Admin OK',
        waiting_admin_validation: 'Validación admin',
        waiting_maps_confirmation: 'Confirmar dirección',
        waiting_payment_method: 'Método de pago',
        waiting_mp_payment: 'Esperando MP',
        waiting_transfer_confirmation: 'Confirmar transferencia',
        post_sale: 'Post-venta', safety_check: 'Safety',
        closing: 'Cierre', completed: 'Completado',
        rejected_medical: 'Rechazo médico',
        rejected_abusive: 'Rechazo abuso',
        rejected_geo: 'Rechazo geo',
    };

    function installStyle() {
        if (document.getElementById('__bot-panel-style')) return;
        const s = document.createElement('style');
        s.id = '__bot-panel-style';
        s.textContent = ${JSON.stringify(PANEL_CSS)};
        (document.head || document.documentElement).appendChild(s);
    }

    const STORE_KEY = '__botPanelPrefs_v1';
    function loadPrefs() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
    }
    function savePrefs(p) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch {}
    }

    function applyPrefs(panel) {
        const p = loadPrefs();
        if (typeof p.top === 'number') { panel.style.top = p.top + 'px'; panel.style.bottom = 'auto'; }
        if (typeof p.left === 'number') { panel.style.left = p.left + 'px'; panel.style.right = 'auto'; }
        if (p.collapsed) panel.classList.add('collapsed');
    }

    function attachDrag(panel) {
        const header = panel.querySelector('.__bp-header');
        if (!header) return;
        let startX = 0, startY = 0, origTop = 0, origLeft = 0, dragging = false;
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('.__bp-collapse')) return;
            const rect = panel.getBoundingClientRect();
            origTop = rect.top; origLeft = rect.left;
            startX = e.clientX; startY = e.clientY;
            dragging = true;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            let newTop = Math.max(0, Math.min(window.innerHeight - 40, origTop + (e.clientY - startY)));
            let newLeft = Math.max(0, Math.min(window.innerWidth - 60, origLeft + (e.clientX - startX)));
            panel.style.top = newTop + 'px'; panel.style.bottom = 'auto';
            panel.style.left = newLeft + 'px'; panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            const p = loadPrefs();
            const rect = panel.getBoundingClientRect();
            p.top = Math.round(rect.top); p.left = Math.round(rect.left);
            savePrefs(p);
        });
    }

    function attachCollapse(panel) {
        const btn = panel.querySelector('.__bp-collapse');
        if (!btn) return;
        btn.addEventListener('click', () => toggleCollapse(panel));
    }

    function toggleCollapse(panel) {
        panel.classList.toggle('collapsed');
        const p = loadPrefs();
        p.collapsed = panel.classList.contains('collapsed');
        savePrefs(p);
    }

    function attachShortcut() {
        if (window.__botPanelShortcut) return;
        window.__botPanelShortcut = true;
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
                const panel = document.getElementById('__bot-panel');
                if (panel) { toggleCollapse(panel); e.preventDefault(); }
            }
        });
    }

    function mountPanel() {
        if (!document.body) return false;
        if (document.getElementById('__bot-panel')) return true;
        const panel = document.createElement('div');
        panel.id = '__bot-panel';
        panel.innerHTML = ${JSON.stringify(PANEL_HTML)};
        document.body.appendChild(panel);
        applyPrefs(panel);
        attachDrag(panel);
        attachCollapse(panel);
        attachShortcut();
        startLoop();
        return true;
    }

    // Try to read WA Web's internal Store (exposed by wwebjs) to find the
    // chat the user has currently selected. Returns its _serialized JID.
    function getActiveChatId() {
        try {
            const Store = window.Store;
            if (!Store || !Store.Chat) return null;
            let active = null;
            if (typeof Store.Chat.getActive === 'function') {
                active = Store.Chat.getActive();
            }
            if (!active && Store.Chat.getModelsArray) {
                const arr = Store.Chat.getModelsArray();
                active = arr && arr.find && arr.find(function(c){ return c.active; });
            }
            if (!active && Store.Chat._models) {
                active = Store.Chat._models.find && Store.Chat._models.find(function(c){ return c.active; });
            }
            return active && active.id ? (active.id._serialized || null) : null;
        } catch (e) { return null; }
    }

    function fmt(v) { return (v === null || v === undefined || v === '') ? '—' : String(v); }

    function showToast(msg, kind) {
        const toast = document.querySelector('#__bot-panel .__bp-toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.className = '__bp-toast show' + (kind ? ' ' + kind : '');
        setTimeout(() => { toast.className = '__bp-toast'; }, 2200);
    }

    async function cmd(action, payload) {
        if (typeof window.__botPanelCmd !== 'function') throw new Error('bridge_unavailable');
        const r = await window.__botPanelCmd({ action, payload });
        if (!r || !r.ok) throw new Error((r && r.error) || 'command_failed');
        return r;
    }

    let stepsCache = null;
    async function getSteps() {
        if (stepsCache) return stepsCache;
        try {
            const r = await cmd('listSteps');
            stepsCache = r.steps || [];
        } catch { stepsCache = []; }
        return stepsCache;
    }

    let quickRepliesCache = null;
    let quickRepliesFetchedAt = 0;
    async function getQuickReplies(forceRefresh) {
        const now = Date.now();
        if (!forceRefresh && quickRepliesCache && (now - quickRepliesFetchedAt) < 60000) return quickRepliesCache;
        try {
            const r = await cmd('listQuickReplies');
            quickRepliesCache = r.replies || [];
            quickRepliesFetchedAt = now;
        } catch { quickRepliesCache = []; }
        return quickRepliesCache;
    }

    function renderQuickReplies(data) {
        const el = document.querySelector('#__bot-panel .__bp-quickreplies');
        if (!el) return;
        if (!data || !data.phone) { el.innerHTML = ''; return; }

        if (!el.dataset.inited) {
            el.dataset.inited = '1';
            el.innerHTML =
                '<div class="__bp-section">' +
                    '<div class="__bp-section-title">Respuestas rápidas <a href="#" class="__bp-qr-refresh" style="color:#64748b;text-decoration:none;font-size:10px;">↻</a></div>' +
                    '<input class="__bp-qr-search" placeholder="Buscar…" />' +
                    '<div class="__bp-qr-list"></div>' +
                '</div>';
            const search = el.querySelector('.__bp-qr-search');
            search.addEventListener('input', () => paintQuickReplyList(data.phone, search.value));
            el.querySelector('.__bp-qr-refresh').addEventListener('click', async (e) => {
                e.preventDefault();
                await getQuickReplies(true);
                paintQuickReplyList(data.phone, search.value);
            });
        }
        paintQuickReplyList(data.phone, (el.querySelector('.__bp-qr-search') || {}).value || '');
    }

    async function paintQuickReplyList(phone, filterText) {
        const list = document.querySelector('#__bot-panel .__bp-qr-list');
        if (!list) return;
        const all = await getQuickReplies(false);
        const q = (filterText || '').trim().toLowerCase();
        const filtered = q
            ? all.filter(r => r.title.toLowerCase().includes(q) || r.message.toLowerCase().includes(q))
            : all;
        if (filtered.length === 0) {
            list.innerHTML = '<div class="__bp-empty" style="padding:6px 0">' +
                (all.length === 0 ? 'No hay respuestas rápidas' : 'Sin coincidencias') + '</div>';
            return;
        }
        list.innerHTML = filtered.map(r =>
            '<button class="__bp-qr-item" data-id="' + r.id + '">' +
                '<div style="flex:1;min-width:0">' +
                    '<div class="__bp-qr-title">' + escapeHtml(r.title) + '</div>' +
                    '<div class="__bp-qr-preview">' + escapeHtml(r.message.slice(0, 60)) + (r.message.length > 60 ? '…' : '') + '</div>' +
                '</div>' +
            '</button>'
        ).join('');
        list.querySelectorAll('.__bp-qr-item').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-id');
                btn.disabled = true;
                try {
                    await cmd('sendQuickReply', { phone, replyId: id });
                    showToast('Enviado', 'success');
                } catch (e) {
                    showToast('Error: ' + (e.message || e), 'error');
                } finally { btn.disabled = false; }
            });
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function renderActions(data) {
        const el = document.querySelector('#__bot-panel .__bp-actions');
        if (!el) return;
        if (!data || !data.phone || !data.known) {
            el.innerHTML = '';
            return;
        }

        const phone = data.phone;
        const pauseBtn = data.paused
            ? '<button class="__bp-btn success" data-act="resume">▶ Reanudar bot</button>'
            : '<button class="__bp-btn warn" data-act="pause">⏸ Pausar bot</button>';

        const needsApproval = data.step === 'waiting_admin_ok' || data.step === 'waiting_admin_validation';
        const approveBtn = needsApproval
            ? '<button class="__bp-btn success" data-act="approve" style="font-weight:600;padding:8px 10px">✅ Aprobar pedido</button>'
            : '';

        el.innerHTML =
            approveBtn +
            pauseBtn +
            '<div class="__bp-select-row">' +
                '<select class="__bp-step-select"><option value="">Cambiar step…</option></select>' +
                '<button class="__bp-btn" data-act="applyStep" style="width:auto;padding:5px 10px">Ir</button>' +
            '</div>' +
            '<button class="__bp-btn danger" data-act="reset">↺ Reiniciar conversación</button>';

        // Populate step select
        getSteps().then(steps => {
            const sel = el.querySelector('.__bp-step-select');
            if (!sel) return;
            const current = data.step;
            sel.innerHTML = '<option value="">Cambiar step…</option>' +
                steps.map(s => '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + (STEP_LABELS[s] || s) + '</option>').join('');
        });

        el.querySelectorAll('[data-act]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const act = btn.getAttribute('data-act');
                btn.disabled = true;
                try {
                    if (act === 'approve') {
                        if (!confirm('¿Aprobar este pedido? Se enviará la confirmación al cliente.')) { btn.disabled = false; return; }
                        const r = await cmd('adminApprove', { phone });
                        showToast(r.message ? r.message.split('\\n')[0].slice(0, 60) : 'Pedido aprobado', 'success');
                    } else if (act === 'pause') {
                        await cmd('pause', { phone });
                        showToast('Bot pausado', 'success');
                    } else if (act === 'resume') {
                        await cmd('resume', { phone });
                        showToast('Bot reanudado', 'success');
                    } else if (act === 'applyStep') {
                        const sel = el.querySelector('.__bp-step-select');
                        const step = sel && sel.value;
                        if (!step) { showToast('Elegí un step', 'error'); btn.disabled = false; return; }
                        await cmd('setStep', { phone, step });
                        showToast('Step → ' + (STEP_LABELS[step] || step), 'success');
                    } else if (act === 'reset') {
                        if (!confirm('¿Borrar todo el estado de este chat? Esto reinicia el flujo.')) { btn.disabled = false; return; }
                        await cmd('resetFlow', { phone });
                        showToast('Flujo reiniciado', 'success');
                    }
                    // Force immediate refresh
                    tick();
                } catch (e) {
                    showToast('Error: ' + (e.message || e), 'error');
                } finally {
                    btn.disabled = false;
                }
            });
        });
    }

    function renderState(data) {
        const panel = document.getElementById('__bot-panel');
        if (!panel) return;
        const dot = panel.querySelector('.__bp-dot');
        const chatValue = panel.querySelector('.__bp-chat-value');
        const stateEl = panel.querySelector('.__bp-state');

        if (!data || !data.phone) {
            dot.className = '__bp-dot unknown';
            chatValue.textContent = 'Ninguno';
            stateEl.innerHTML = '<div class="__bp-empty">Abrí un chat para ver su estado</div>';
            renderActions(data);
            renderQuickReplies(data);
            return;
        }

        // Reset the quick-replies widget when switching chats so its internal
        // state (search box, focus) doesn't leak between contacts.
        const qrEl = panel.querySelector('.__bp-quickreplies');
        if (qrEl && qrEl.dataset.lastPhone && qrEl.dataset.lastPhone !== data.phone) {
            qrEl.innerHTML = ''; delete qrEl.dataset.inited;
        }
        if (qrEl) qrEl.dataset.lastPhone = data.phone;

        const phoneDisplay = data.phone.replace(/@c\\.us$/, '').replace(/^(\\d{2})(\\d{1,2})(\\d+)$/, '+$1 $2 $3');
        chatValue.textContent = phoneDisplay;

        if (!data.known) {
            dot.className = '__bp-dot unknown';
            stateEl.innerHTML = '<div class="__bp-empty">El bot aún no interactuó con este chat</div>';
            renderActions(data);
            return;
        }

        dot.className = data.paused ? '__bp-dot paused' : '__bp-dot';

        const stepLabel = STEP_LABELS[data.step] || data.step || '—';
        const pref = data.selectedProduct || null;
        const plan = data.selectedPlan ? 'Plan ' + data.selectedPlan : null;
        const price = data.totalPrice ? '$' + data.totalPrice : null;
        const payment = data.paymentMethod || null;
        const weight = data.weightGoal ? data.weightGoal + ' kg' : null;
        const addr = data.address || {};
        const addrLine = [addr.calle, addr.ciudad].filter(Boolean).join(', ') || null;

        let html = '<div class="__bp-row"><span>Step</span><span class="__bp-step">' + stepLabel + '</span></div>';
        if (weight) html += '<div class="__bp-row"><span>Peso</span><strong>' + fmt(weight) + '</strong></div>';
        if (pref) html += '<div class="__bp-row"><span>Preferencia</span><strong>' + fmt(pref) + '</strong></div>';
        if (plan) html += '<div class="__bp-row"><span>Plan</span><strong>' + fmt(plan) + '</strong></div>';
        if (price) html += '<div class="__bp-row"><span>Precio</span><strong>' + fmt(price) + '</strong></div>';
        if (payment) html += '<div class="__bp-row"><span>Pago</span><strong>' + fmt(payment) + '</strong></div>';
        if (addrLine) html += '<div class="__bp-row"><span>Dirección</span><strong>' + fmt(addrLine) + '</strong></div>';
        if (data.cartItems > 0) html += '<div class="__bp-row"><span>Carrito</span><strong>' + data.cartItems + ' item(s)</strong></div>';
        if (data.paused) html += '<div class="__bp-paused-banner">Pausado — el bot no responderá</div>';
        stateEl.innerHTML = html;

        renderActions(data);
        renderQuickReplies(data);
    }

    let lastFetched = null;
    async function tick() {
        if (typeof window.__botPanelCmd !== 'function') return;
        const jid = getActiveChatId();
        if (!jid) { renderState({ phone: null }); lastFetched = null; return; }
        try {
            const data = await window.__botPanelCmd({ action: 'getState', payload: { phone: jid } });
            lastFetched = jid;
            // Backend returns the resolved @c.us phone in data.phone; prefer
            // that over the raw @lid jid so userState lookups and action
            // buttons operate on the canonical identifier.
            renderState(data && data.phone ? data : { ...data, phone: jid });
        } catch (e) {
            const panel = document.getElementById('__bot-panel');
            if (panel) panel.querySelector('.__bp-state').innerHTML = '<div class="__bp-empty">Error: ' + (e.message || e) + '</div>';
        }
    }

    function startLoop() {
        tick();
        setInterval(tick, POLL_MS);
    }

    function boot() {
        installStyle();
        if (mountPanel()) return;
        const mo = new MutationObserver(() => {
            installStyle();
            if (mountPanel()) mo.disconnect();
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
`;

/**
 * Wire the panel into a running seller's Chromium. Idempotent — safe to call
 * multiple times (e.g. after a reconnect); only the first call registers the
 * exposeFunction/evaluateOnNewDocument hooks.
 */
export async function attachBotPanel(instance: SellerInstance): Promise<void> {
    const client: any = instance.client;
    const page = client?.pupPage;
    if (!page) {
        logger.warn(`[BOT_PANEL][${instance.sellerId}] No page available, skipping panel attach`);
        return;
    }

    const sellerAny = instance as any;
    if (sellerAny._panelAttached) return;
    sellerAny._panelAttached = true;

    try {
        await page.exposeFunction('__botPanelCmd', async (cmd: PanelCommand) => {
            return await handlePanelCommand(instance, cmd);
        });
    } catch (e: any) {
        if (!String(e.message).includes('already exists')) {
            logger.warn(`[BOT_PANEL][${instance.sellerId}] exposeFunction failed: ${e.message}`);
        }
    }

    try {
        await page.evaluateOnNewDocument(INJECT_SCRIPT);
    } catch (e: any) {
        logger.warn(`[BOT_PANEL][${instance.sellerId}] evaluateOnNewDocument failed: ${e.message}`);
    }

    try {
        await page.evaluate(INJECT_SCRIPT);
    } catch (e: any) {
        // Page may not be fully loaded — evaluateOnNewDocument will cover the next load.
    }

    logger.info(`[BOT_PANEL][${instance.sellerId}] Panel attached`);
}
