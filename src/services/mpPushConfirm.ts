import logger from '../utils/logger';
import { FlowStep } from '../types/state';
import { confirmApprovedMpPayment } from '../flows/steps/stepWaitingMpPayment';

/**
 * mpPushConfirm — confirmación PUSH de compra cuando un PaymentLink pasa a approved.
 *
 * Hasta jul-2026 el bot solo confirmaba la compra si el cliente escribía "listo"
 * (pull). Si el cliente pagaba y no volvía a escribir —o su "listo" caía en el
 * hueco antes de que el webhook marcara la fila— la venta quedaba muda para
 * siempre (caso Rosa 5492994553847: pagó, mandó comprobante en PDF y estuvo
 * 3 días preguntando "¿es real la compra?").
 *
 * Este módulo es el camino inverso: lo llaman los TRES detectores de pago
 * (webhook de MP, cron refreshPendingPayments, botón refresh del dashboard)
 * apenas ven la transición a approved. Si el dueño del link sigue esperando en
 * waiting_mp_payment, cerramos la venta sin depender del "listo".
 *
 * Deps mínimas a propósito: son exactamente las que ya tienen tanto el
 * scheduler (SchedulerDependencies) como las rutas (instance.helpers), así
 * ambos mundos llaman igual.
 */
export interface MpPushDeps {
    sharedState: any;  // userState, pausedUsers, knowledge, config, sellerId
    sendMessageWithDelay: (userId: string, msg: string) => Promise<void>;
    notifyAdmin: (title: string, userId: string, msg: string) => Promise<void>;
    saveState: (userId?: string) => void;
    saveOrderToLocal?: (order: any) => void;
}

export async function onPaymentLinkApproved(record: any, deps: MpPushDeps): Promise<void> {
    try {
        const { sharedState } = deps;
        // Links manuales del dashboard / tienda web no tienen chat asociado.
        if (!record?.userPhone) return;

        const userId = `${record.userPhone}@c.us`;
        const state: any = sharedState?.userState?.[userId];
        if (!state) return;

        // Solo actuamos si el cliente sigue esperando un pago MP.
        if (state.step !== FlowStep.WAITING_MP_PAYMENT) return;

        // Avisar UNA sola vez por link: el sweep de refreshPendingPayments
        // reintenta este push cada 5 min, así que sin dedupe los branches de
        // notifyAdmin de abajo spamearían al vendedor en cada tick.
        const alreadyNotified = state._mpPushNotifiedFor === record.id;
        const amountFmt = Number(record.amount || 0).toLocaleString('es-AR');
        const notifyOnce = async (title: string, msg: string) => {
            if (alreadyNotified) return;
            state._mpPushNotifiedFor = record.id;
            // El pago YA está acreditado: cualquier nudge futuro de "pago con
            // tarjeta pendiente" sería falso. Sentinel 99 apaga los recordatorios
            // de checkPendingMpPayments para este chat.
            state.mpReminderStage = 99;
            deps.saveState(userId);
            await deps.notifyAdmin(title, userId, msg);
        };

        // El check de id descarta links viejos (retry regeneró otro) o de flujos
        // ya cambiados (pasó a transferencia/retiro → mpPaymentLinkId en null).
        // Pero NO en silencio: es plata del cliente acreditada sobre un link que
        // el chat ya no está trackeando — el vendedor tiene que verificar a mano
        // (el monto del link viejo puede no coincidir con el pedido vigente).
        if (state.mpPaymentLinkId !== record.id) {
            await notifyOnce(
                '💳 Pago MP acreditado (link no vigente)',
                `MercadoPago acreditó $${amountFmt} sobre un link (${record.id}) que el chat ya no está esperando (esperando: ${state.mpPaymentLinkId || 'ninguno — retry en curso'}). El bot NO confirmó nada — verificá el pago en MP y confirmale la compra a mano.`
            );
            return;
        }

        // Pausa global del bot: no mensajeamos a nadie. NO mutamos el step así,
        // cuando se levante la pausa, el sweep del scheduler (o el "listo" del
        // cliente) retoma y confirma — la fila ya quedó approved en DB.
        if (sharedState.config?.globalPause) {
            await notifyOnce(
                '💳 Pago MP acreditado (BOT EN PAUSA GLOBAL)',
                `MercadoPago acreditó $${amountFmt} pero la pausa global está activa, así que el bot NO le confirmó al cliente. Al desactivar la pausa el bot lo confirma solo (reintenta cada 5 min); si preferís, confirmalo a mano.`
            );
            return;
        }

        // Sesión de WhatsApp caída: el send fallaría en silencio DESPUÉS de
        // avanzar el estado y crear la orden. Mejor no tocar nada: la fila queda
        // approved y el sweep confirma solo cuando vuelva la conexión.
        if (sharedState.isConnected === false) {
            await notifyOnce(
                '💳 Pago MP acreditado (WhatsApp DESCONECTADO)',
                `MercadoPago acreditó $${amountFmt} pero la sesión de WhatsApp está caída — el bot no puede mandarle la confirmación. Al reconectar la confirma solo (reintenta cada 5 min).`
            );
            return;
        }

        // Pausas NO se auto-liberan (convención del repo): si está pausado no le
        // mensajeamos — pero el pago acreditado es plata del cliente, así que
        // avisamos al vendedor para que confirme a mano.
        if (sharedState.pausedUsers?.has(userId)) {
            await notifyOnce(
                '💳 Pago MP acreditado (cliente PAUSADO)',
                `MercadoPago acreditó $${amountFmt} pero el cliente está pausado (${state.pauseReason || 'sin razón registrada'}). El bot NO le confirmó nada — confirmale la compra manualmente, o despausalo y el bot la confirma y carga solo.`
            );
            return;
        }

        logger.info(`[MP-PUSH] Pago acreditado para ${userId} ($${record.amount}) — confirmando compra sin esperar "listo"`);
        await confirmApprovedMpPayment(userId, state, sharedState.knowledge, {
            sendMessageWithDelay: deps.sendMessageWithDelay,
            saveState: deps.saveState,
            notifyAdmin: deps.notifyAdmin,
            saveOrderToLocal: deps.saveOrderToLocal,
            config: sharedState.config,
            sellerId: sharedState.sellerId,
            sharedState,
        });
    } catch (e: any) {
        logger.error(`[MP-PUSH] Error confirmando pago acreditado (link ${record?.id}): ${e?.message || e}`);
    }
}
