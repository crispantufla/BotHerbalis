/**
 * funnelLogger.ts
 * Persiste transiciones de step en la tabla FunnelEvent para luego construir
 * embudo, drop-off, tiempo a cierre y reentradas.
 *
 * API:
 *   - logStepTransition(sellerId, phone, stepFrom, stepTo) → abre row nuevo, cierra el anterior
 *   - markExit(sellerId, phone, exitType) → cierra el row abierto actual con el tipo dado
 *   - incrementMessageCount / incrementAiCallCount (usados por Fase 2, ya dejados acá)
 *
 * No bloquea el flujo: los errores se loguean y se descartan. El funnel es
 * observabilidad, nunca debe romper una venta.
 */

import logger from '../utils/logger';
const { prisma } = require('../../db');

// Orden canónico del embudo — usado para distinguir "advanced" vs "back".
// Steps fuera de este orden (rejected_*, safety_check, post_sale, etc.) se
// clasifican como "advanced" siempre (no son un retroceso lateral).
const STEP_ORDER: string[] = [
    'greeting',
    'general',
    'waiting_weight',
    'waiting_preference',
    'waiting_preference_consultation',
    'waiting_plan_choice',
    'waiting_price_confirmation',
    'waiting_ok',
    'waiting_data',
    'waiting_maps_confirmation',
    'waiting_payment_method',
    'waiting_mp_payment',
    'waiting_transfer_confirmation',
    'waiting_final_confirmation',
    'waiting_admin_ok',
    'waiting_admin_validation',
    'closing',
    'completed',
];

function classifyTransition(stepFrom: string | null, stepTo: string): 'advanced' | 'back' | 'completed' {
    if (stepTo === 'completed') return 'completed';
    if (!stepFrom) return 'advanced';
    const fromIdx = STEP_ORDER.indexOf(stepFrom);
    const toIdx = STEP_ORDER.indexOf(stepTo);
    if (fromIdx === -1 || toIdx === -1) return 'advanced';
    return toIdx < fromIdx ? 'back' : 'advanced';
}

/**
 * Registra la entrada a un nuevo step y cierra el evento anterior.
 * Idempotente a nivel DB — si falla el write lo logueamos y seguimos.
 */
export async function logStepTransition(
    sellerId: string,
    phone: string,
    stepFrom: string | null,
    stepTo: string
): Promise<void> {
    if (!sellerId || !phone || !stepTo) return;
    if (stepFrom === stepTo) return; // sin cambio real

    const exitType = classifyTransition(stepFrom, stepTo);

    try {
        // Cerrar cualquier FunnelEvent abierto del mismo (seller, phone)
        await prisma.funnelEvent.updateMany({
            where: { sellerId, phone, exitedAt: null },
            data: { exitedAt: new Date(), exitType },
        });

        // Abrir el nuevo
        await prisma.funnelEvent.create({
            data: { sellerId, phone, stepFrom, stepTo },
        });
    } catch (e: any) {
        logger.warn(`[FUNNEL] logStepTransition failed: ${e.message}`);
    }
}

/**
 * Cierra el FunnelEvent abierto actual con un tipo de salida específico
 * (paused | dropped | completed). Se usa desde _pauseAndAlert y el job de drop.
 */
export async function markExit(
    sellerId: string,
    phone: string,
    exitType: 'paused' | 'dropped' | 'completed'
): Promise<void> {
    if (!sellerId || !phone) return;
    try {
        await prisma.funnelEvent.updateMany({
            where: { sellerId, phone, exitedAt: null },
            data: { exitedAt: new Date(), exitType },
        });
    } catch (e: any) {
        logger.warn(`[FUNNEL] markExit failed: ${e.message}`);
    }
}

/** Incrementa contador de mensajes del user en el step abierto actual. */
export async function incrementMessageCount(sellerId: string, phone: string): Promise<void> {
    if (!sellerId || !phone) return;
    try {
        await prisma.funnelEvent.updateMany({
            where: { sellerId, phone, exitedAt: null },
            data: { messageCount: { increment: 1 } },
        });
    } catch (e: any) { /* best effort */ }
}

/** Incrementa contador de llamadas a AI en el step abierto actual. */
export async function incrementAiCallCount(sellerId: string, phone: string): Promise<void> {
    if (!sellerId || !phone) return;
    try {
        await prisma.funnelEvent.updateMany({
            where: { sellerId, phone, exitedAt: null },
            data: { aiCallCount: { increment: 1 } },
        });
    } catch (e: any) { /* best effort */ }
}

/**
 * Registra un mensaje del usuario. También incrementa messageCount del
 * FunnelEvent abierto.
 *
 * NOTA: retryIndex se deja en 0 al insertar. El COUNT que calculaba el
 * índice en escritura saturaba el pool bajo carga (1 query extra por
 * mensaje, con scan parcial por falta de índice compuesto con `phone`).
 * El endpoint /analytics/retries computa los retries con una agregación
 * SQL al leer, que es mucho más barato globalmente.
 */
export async function logMessage(args: {
    sellerId: string;
    phone: string;
    step: string;
    matched: boolean;
    aiCalled?: boolean;
    priceObjection?: boolean;
}): Promise<void> {
    const { sellerId, phone, step, matched, aiCalled = false, priceObjection = false } = args;
    if (!sellerId || !phone || !step) return;

    try {
        await prisma.messageEvent.create({
            data: { sellerId, phone, step, matched, aiCalled, priceObjection },
        });

        // Incrementar messageCount en el FunnelEvent abierto
        await prisma.funnelEvent.updateMany({
            where: { sellerId, phone, exitedAt: null },
            data: { messageCount: { increment: 1 } },
        });
    } catch (e: any) {
        logger.warn(`[FUNNEL] logMessage failed: ${e.message}`);
    }
}

/**
 * Cierra todos los FunnelEvent abiertos más viejos que `olderThanHours` horas
 * marcándolos como 'dropped'. Lo llama el scheduler cada 15 min.
 * Devuelve la cantidad de rows cerrados.
 */
export async function markStaleAsDropped(olderThanHours: number = 48): Promise<number> {
    try {
        const cutoff = new Date(Date.now() - olderThanHours * 3600 * 1000);
        const result = await prisma.funnelEvent.updateMany({
            where: { exitedAt: null, enteredAt: { lt: cutoff } },
            data: { exitedAt: new Date(), exitType: 'dropped' },
        });
        return result.count || 0;
    } catch (e: any) {
        logger.warn(`[FUNNEL] markStaleAsDropped failed: ${e.message}`);
        return 0;
    }
}

export { STEP_ORDER };
