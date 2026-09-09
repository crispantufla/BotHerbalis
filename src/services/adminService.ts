import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { UserState, SharedState, AlertEntry, AlertOrderData, BotConfig, QuickReply } from '../types/state';
import { aiService } from './ai';
import { _getQuickReplies } from '../flows/utils/messages';
import { _setStep } from '../flows/utils/flowHelpers';
import { getArgentinaMidnight } from './timeUtils';
import logger from '../utils/logger';

const { prisma } = require('../../db');

/**
 * Módulo de Servicios de Administrador
 * Refactorizado de src/controllers/admin.js a services/adminService.ts
 *
 * Sistema de alertas con cola numerada:
 *   - Cada alerta recibe un #N visible para el admin
 *   - Admin puede dirigir comandos: "1 ok", "2 me encargo"
 *   - Sin número → se usa la alerta más reciente (backward compat)
 */

/**
 * Emit a Socket.IO event scoped to this seller's room + the admin room.
 * Prevents cross-tenant leakage of per-seller events in the multi-tenant setup.
 */
export function _emitScoped(sharedState: SharedState, event: string, payload: any): void {
    if (!sharedState.io) return;
    const sellerId = (sharedState as any).sellerId;
    if (sellerId) {
        sharedState.io.to(sellerId).emit(event, payload);
        sharedState.io.to('admin').emit(event, { ...payload, sellerId });
    } else {
        // No sellerId context (legacy single-instance mode) — fall back to broadcast
        sharedState.io.emit(event, payload);
    }
}

/** Helper: remove ALL alerts for a user and emit update to dashboard */
export function _dismissAlert(userPhone: string, sharedState: SharedState): void {
    const before = sharedState.sessionAlerts.length;
    sharedState.sessionAlerts = sharedState.sessionAlerts.filter((a: AlertEntry) => a.userPhone !== userPhone);
    if (sharedState.sessionAlerts.length !== before) {
        _emitScoped(sharedState, 'alerts_updated', sharedState.sessionAlerts);
    }
}

// Public wrapper — used by outgoing-message handler to clear notifications
// when the admin replies manually to a chat (no need to keep the alert queued).
export function dismissAlertsForUser(userPhone: string, sharedState: SharedState): void {
    _dismissAlert(userPhone, sharedState);
}

/**
 * Parse admin input to extract optional alert selector and the actual command.
 *   "1 ok"           → { selector: "1", command: "ok" }
 *   "ok"             → { selector: null, command: "ok" }
 *   "2 me encargo"   → { selector: "2", command: "me encargo" }
 *   "!alertas"       → { selector: null, command: "!alertas" }
 */
export function parseAdminInput(text: string): { selector: string | null; command: string } {
    const trimmed = text.trim();
    // Quick reply shorthand: "1r2" → selector "1", command "r2"
    const qrMatch = trimmed.match(/^(\d{1,2})(r\d+)$/i);
    if (qrMatch) return { selector: qrMatch[1], command: qrMatch[2].toLowerCase() };
    // Match: starts with 1-2 digit number, then a space, then the rest
    const match = trimmed.match(/^(\d{1,2})\s+(.+)$/);
    if (match) return { selector: match[1], command: match[2].trim() };
    return { selector: null, command: trimmed };
}

/**
 * Resolve which alert/user the admin is targeting.
 * Priority: explicit selector (#N or phone fragment) > targetChatId from API > lastAlertUser fallback
 */
export function resolveAlertTarget(
    selector: string | null,
    targetChatId: string | null,
    sharedState: SharedState
): string | null {
    // 1. Explicit selector from parsed input
    if (selector) {
        const idx = parseInt(selector) - 1;
        if (!isNaN(idx) && idx >= 0 && idx < sharedState.sessionAlerts.length) {
            return sharedState.sessionAlerts[idx].userPhone;
        }
        // Try as partial phone match
        const byPhone = sharedState.sessionAlerts.find(a => a.userPhone.includes(selector));
        if (byPhone) return byPhone.userPhone;
    }
    // 2. Explicit targetChatId (from API/dashboard)
    if (targetChatId) return targetChatId;
    // 3. Fallback: most recent alert (backward compat)
    if (sharedState.sessionAlerts.length > 0) return sharedState.sessionAlerts[0].userPhone;
    // 4. Legacy fallback
    return sharedState.lastAlertUser || null;
}

/** Format the active alerts list for WhatsApp */
export function _formatAlertsList(sharedState: SharedState): string {
    if (sharedState.sessionAlerts.length === 0) return '✅ No hay alertas activas.';

    const lines = sharedState.sessionAlerts.map((a, i) => {
        const ago = _timeAgo(a.timestamp);
        const name = a.userName && a.userName !== a.userPhone ? a.userName : '';
        const product = a.orderData?.product || '';
        const cleanPhone = a.userPhone.split('@')[0];
        return `*#${i + 1}* — ${name ? name + ' ' : ''}(${cleanPhone})${product ? ' — ' + product : ''} — _${ago}_`;
    });

    return `📋 *Alertas activas (${sharedState.sessionAlerts.length}):*\n\n${lines.join('\n')}\n\n_Respondé con el # + comando, ej: "1 ok", "2 me encargo"_`;
}

/** Human-friendly relative time */
export function _timeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return `hace ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `hace ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `hace ${hours}h ${minutes % 60}m`;
}

// Helper: Notify Admin
export async function notifyAdmin(
    reason: string,
    userPhone: string,
    details: string | null = null,
    sharedState: SharedState,
    client: Record<string, any>,
    config: BotConfig
): Promise<void> {
    // Beep only in dev — spawning powershell on every alert exhausts the libuv thread pool in prod
    if (process.platform === 'win32' && process.env.NODE_ENV !== 'production') {
        exec('powershell "[console]::beep(1000, 500)"', (err) => { if (err) logger.error('Beep failed:', err); });
    }
    logger.info(`[ADMIN ALERT] ${reason} (User: ${userPhone})`);

    const now = Date.now();
    // Dedup por (userPhone + reason) en ventana de 8s — evita duplicar
    // ráfagas del mismo evento.
    const lastSameReason: AlertEntry | undefined = sharedState.sessionAlerts.find(
        (a: AlertEntry) => a.userPhone === userPhone && a.reason === reason
    );
    if (lastSameReason && (now - lastSameReason.id < 8000)) return;

    // Reemplazo por userPhone: si ya hay alertas de este cliente (sin importar
    // la razón), las eliminamos antes de pushear la nueva. El admin debe ver
    // SOLO la más reciente — antes se acumulaban "Cliente en pausa te escribió"
    // + "BOT PAUSADO — Necesita intervención" para el mismo chat y confundían.
    // El frontend hace la misma dedup al recibir new_alert (CorporateDashboard).
    if (sharedState.sessionAlerts.some((a: AlertEntry) => a.userPhone === userPhone)) {
        sharedState.sessionAlerts = sharedState.sessionAlerts.filter(
            (a: AlertEntry) => a.userPhone !== userPhone
        );
    }

    sharedState.lastAlertUser = userPhone;

    // Extract order data from user state for rich alerts
    const state: Partial<UserState> = sharedState.userState[userPhone] || {};
    const orderData: AlertOrderData = {
        product: state.selectedProduct || null,
        plan: state.selectedPlan || null,
        price: state.totalPrice || state.price || null,
        address: state.partialAddress || state.pendingOrder || null,
        step: state.step || null
    };

    // Generate contextual quick replies based on step + last user message
    const lastUserMsg = (state.history as any[])?.filter((h: any) => h.role === 'user').pop()?.content || '';
    const quickReplies: QuickReply[] = _getQuickReplies(state.step || '', lastUserMsg);

    const newAlert: AlertEntry = {
        id: Date.now(),
        timestamp: new Date(),
        reason,
        userPhone,
        userName: state.userName || userPhone,
        details: details || '',
        orderData,
        quickReplies
    };

    sharedState.sessionAlerts.unshift(newAlert);
    if (sharedState.sessionAlerts.length > 50) sharedState.sessionAlerts.pop();

    _emitScoped(sharedState, 'new_alert', newAlert);

    if (config.alertNumbers && config.alertNumbers.length > 0) {
        // The new alert is at index 0 (unshifted), so its queue number is #1
        const alertNum = 1;
        const totalAlerts = sharedState.sessionAlerts.length;
        const addrStr = orderData.address
            ? `${orderData.address.nombre || '?'}, ${orderData.address.calle || '?'}, ${orderData.address.ciudad || '?'}, CP ${orderData.address.cp || '?'}`
            : 'Sin dirección';
        const cleanPhone = userPhone.split('@')[0];

        // Quick reply section
        const qrText = quickReplies.length > 0
            ? `\n\n💬 *Respuestas rápidas:*\n${quickReplies.map((qr, i) => `  *r${i + 1}*: ${qr.label}`).join('\n')}`
            : '';

        const alertMsg = `⚠️ *ALERTA #${alertNum}* ${totalAlerts > 1 ? `(${totalAlerts} activas)` : ''}\n\n*Motivo:* ${reason}\n*Cliente:* ${state.userName || cleanPhone} (${cleanPhone})\n${orderData.product ? `*Producto:* ${orderData.product} (${orderData.plan || '?'} días) - $${orderData.price || '?'}\n*Dirección:* ${addrStr}\n` : ''}*Detalles:* ${details || 'Sin detalles'}${qrText}\n\n_"${alertNum} ok" confirmar | "${alertNum} me encargo" intervenir | "${alertNum} r1/r2/r3" respuesta rápida${totalAlerts > 1 ? ' | "!alertas" ver todas' : ''}_`;
        for (const num of config.alertNumbers) {
            const targetAlert = `${num}@c.us`;
            client.sendMessage(targetAlert, alertMsg).catch((e: Error) => logger.error(`[ALERT] Failed to forward to ${num}:`, e.message));
        }
    }
}

// Helper: Build the WhatsApp confirmation sent to client after admin approves
export function buildAdminApprovalMessage(clientState: UserState): string {
    if (!clientState.pendingOrder) return 'Pedido confirmado.';

    const { nombre, calle, ciudad, provincia, cp } = clientState.pendingOrder;
    const prod: string = clientState.selectedProduct || 'Producto desconocido';
    const planDays: string = clientState.selectedPlan
        ? `${clientState.selectedPlan} días`
        : (clientState.cart?.[0]?.plan ? `${clientState.cart[0].plan} días` : '');
    const details = [prod, planDays].filter(Boolean).join(' - ');
    const priceText = clientState.totalPrice ? `Total a pagar: $${clientState.totalPrice}` : '';

    const addrObj = clientState.partialAddress || clientState.pendingOrder || {};
    const deliveryNotes = addrObj.postdatado || clientState.postdatado
        ? `\n\n📌 *Nota de entrega:* ${addrObj.postdatado || clientState.postdatado}`
        : '';

    return `✅ *¡Genial! Pedido en preparación.*\n\nRecibió este mensaje porque su pedido fue aprobado.\n\n*Detalle:*\n${details}\n\n*Envío a:*\n${nombre || 'Sin nombre'}\n${calle || ''}\n${ciudad || ''}${provincia ? ', ' + provincia : ''}\nCP: ${cp || '?'}\n${priceText}${deliveryNotes}\n\nEn las próximas 24/48hs hábiles te enviaremos el código de seguimiento. ¡Gracias por confiar en Herbalis! 🌱`;
}

// handleAdminCommand vive ahora en adminCommands.ts (registro de comandos "!" +
// acciones sobre la cola de alertas). NO se re-exporta desde acá a propósito:
// adminCommands importa helpers de este módulo, así que re-exportarlo cerraría
// un ciclo de imports. Los consumidores requieren './adminCommands' directo.
