import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _cleanPhone } from '../utils/flowHelpers';
import { randomUUID } from 'crypto';
import logger from '../../utils/logger';

const PAID_KEYWORDS = /\b(listo|pague|pagué|pago hecho|hice el pago|ya pague|ya pagué|realice|realicé|confirmo|listo el pago|pago listo|lo hice|hecho|ok listo)\b/i;
const FALLBACK_KEYWORDS = /\b(no puedo|no tengo|prefiero efectivo|efectivo|prefiero al recibir|no me sale|error|problema|no funciona|cancelar)\b/i;

export async function handleWaitingMpPayment(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // --- ENTRY: No link generated yet — generate and send ---
    if (!currentState.mpPaymentLinkUrl) {
        await _generateAndSendLink(userId, currentState, knowledge, dependencies);
        return { matched: true };
    }

    // --- Client says they paid ---
    // Check both original (for accents like "pagué") and normalized (for "pague")
    const normalizedForPaid = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (PAID_KEYWORDS.test(text) || PAID_KEYWORDS.test(normalizedForPaid)) {
        const verified = await _verifyPayment(currentState);

        if (verified === 'approved') {
            const addr = currentState.partialAddress || {};
            const hasAddress = !!(addr.nombre && addr.calle && addr.ciudad);

            if (hasAddress) {
                const { buildConfirmationMessage } = require('../../utils/messageTemplates');
                const { calculateTotal } = require('../utils/cartHelpers');
                calculateTotal(currentState);
                currentState.pendingOrder = {
                    nombre: addr.nombre,
                    calle: addr.calle,
                    ciudad: addr.ciudad,
                    cp: addr.cp,
                    provincia: addr.provincia,
                    calleOriginal: (addr as any).calleOriginal || addr.calle,
                    cart: currentState.cart
                };
                const summaryMsg = buildConfirmationMessage(currentState);
                _setStep(currentState, FlowStep.WAITING_FINAL_CONFIRMATION);
                const successMsg = '¡Perfecto, el pago fue confirmado! 🎉';
                currentState.history.push({ role: 'bot', content: successMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, successMsg);
                currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, summaryMsg);
            } else {
                const msg = '¡Perfecto, el pago fue confirmado! 🎉\n\nAhora necesito los datos de envío para despachar tu pedido 👇\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:';
                _setStep(currentState, FlowStep.WAITING_DATA);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, msg);
            }
            return { matched: true };
        } else if (verified === 'pending') {
            const msg = '⏳ Todavía no veo el pago confirmado en el sistema.\n\nEsperá unos minutos y escribime "listo" cuando esté acreditado. Los pagos con tarjeta de crédito pueden demorar hasta 5 minutos.';
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            return { matched: true };
        } else {
            // rejected or error — offer fallback
            const msg = '⚠️ Hubo un problema con el pago.\n\nNo te preocupes, podés pagar en efectivo al recibir el paquete como siempre 😊\n\nPasame los datos para armar la etiqueta de envío:\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:';
            currentState.paymentMethod = 'efectivo';
            currentState.mpPaymentLinkId = null;
            currentState.mpPaymentLinkUrl = null;
            _setStep(currentState, FlowStep.WAITING_DATA);
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            return { matched: true };
        }
    }

    // --- Client wants to switch to cash ---
    if (FALLBACK_KEYWORDS.test(normalizedText)) {
        const msg = _getClosingMsg(knowledge);
        currentState.paymentMethod = 'efectivo';
        currentState.mpPaymentLinkId = null;
        currentState.mpPaymentLinkUrl = null;
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // --- Client asks to resend the link ---
    if (/\b(link|enlace|reenviá|reenviar|de nuevo|el link|manda|mándame)\b/i.test(text) && currentState.mpPaymentLinkUrl) {
        const msg = `Acá está tu enlace de pago:\n\n${currentState.mpPaymentLinkUrl}\n\nCuando completes el pago escribime "listo" 👍`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // --- AI fallback ---
    const aiRes = await aiService.chat(text, {
        step: 'waiting_mp_payment',
        goal: `El cliente tiene un enlace de pago de MercadoPago. Necesita completar el pago y luego escribir "listo".\n\nEnlace de pago ya enviado: ${currentState.mpPaymentLinkUrl}\n\nSi tiene dudas sobre cómo pagar, explicale brevemente (con tarjeta, desde la app MP, o escaneando el QR del link). Si quiere cambiar a efectivo, decile que está bien y que lo recibe el cartero. NUNCA reenvíes el link de nuevo a menos que lo pida explícitamente. Esperá que confirme el pago con "listo" o "ya pagué".`,
        history: currentState.history,
        summary: currentState.summary,
        knowledge,
        userState: currentState
    });

    if (aiRes.response) {
        currentState.history.push({ role: 'bot', content: aiRes.response, timestamp: Date.now() });
        await sendMessageWithDelay(userId, aiRes.response);
        saveState(userId);
        return { matched: true };
    }

    await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente en waiting_mp_payment — sin respuesta del bot.');
    return { matched: true };
}

// --- Helpers ---

async function _generateAndSendLink(
    userId: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<void> {
    const { sendMessageWithDelay, saveState } = dependencies;

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) {
        // Fallback silently to efectivo
        logger.warn('[MP_PAYMENT] MP_ACCESS_TOKEN not set — falling back to efectivo');
        currentState.paymentMethod = 'efectivo';
        const msg = _getClosingMsg(knowledge);
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return;
    }

    try {
        const totalRaw = currentState.totalPrice;
        const amount = typeof totalRaw === 'string'
            ? parseFloat(totalRaw.replace(/\./g, '').replace(',', '.'))
            : Number(totalRaw || 0);

        if (!amount || amount <= 0) throw new Error('Monto inválido');

        const { MercadoPagoConfig, Preference } = require('mercadopago');
        const externalRef = randomUUID();
        const webhookUrl = process.env.MP_WEBHOOK_URL;
        const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
        const preference = new Preference(mpClient);
        const body: any = {
            items: [{ title: 'Pago Herbalis', quantity: 1, unit_price: amount, currency_id: 'ARS' }],
            back_urls: { success: 'https://herbalis.com.ar', failure: 'https://herbalis.com.ar', pending: 'https://herbalis.com.ar' },
            auto_return: 'approved',
            external_reference: externalRef,
        };
        if (webhookUrl) body.notification_url = webhookUrl;

        const response = await preference.create({ body });
        const link = response.init_point;

        // Persist to DB
        const { prisma } = require('../../../db');
        const cleanPhone = _cleanPhone(userId);
        const record = await prisma.paymentLink.create({
            data: {
                preferenceId: response.id,
                externalRef,
                amount,
                link,
                userPhone: cleanPhone,
                source: 'bot_flow',
                status: 'pending',
            }
        });

        currentState.mpPaymentLinkId = record.id;
        currentState.mpPaymentLinkUrl = link;
        saveState(userId);

        const msg = `💳 *Pago online via MercadoPago*\n\nTu pedido: *${currentState.selectedProduct?.split(' de ')[0] || 'Herbalis'}* — Plan ${currentState.selectedPlan} días\nTotal: *$${currentState.totalPrice}*\n\n👇 Hacé clic para pagar de forma segura:\n${link}\n\nPodés pagar con tarjeta, desde la app de MercadoPago o escaneando el QR.\n\n✅ Cuando completes el pago, escribime *"listo"* y seguimos con el envío.`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        logger.info(`[MP_PAYMENT] Link created for ${userId} — $${amount} ARS — ${link}`);
    } catch (e: any) {
        logger.error('[MP_PAYMENT] Error generating link:', e.message);
        // Fallback to efectivo on error
        currentState.paymentMethod = 'efectivo';
        currentState.mpPaymentLinkId = null;
        currentState.mpPaymentLinkUrl = null;
        const msg = '⚠️ Tuve un problema generando el enlace de pago 😓\n\nNo te preocupes, podés pagar en efectivo al recibir el paquete.\n\nPasame los datos para el envío:\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:';
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
    }
}

async function _verifyPayment(currentState: UserState): Promise<'approved' | 'pending' | 'rejected'> {
    if (!currentState.mpPaymentLinkId) return 'pending';

    try {
        const { prisma } = require('../../../db');
        const record = await prisma.paymentLink.findUnique({ where: { id: currentState.mpPaymentLinkId } });
        if (!record) return 'pending';

        // If webhook already updated it
        if (record.status === 'approved') return 'approved';
        if (record.status === 'rejected' || record.status === 'expired') return 'rejected';

        // Query MP directly
        const mpToken = process.env.MP_ACCESS_TOKEN;
        if (!mpToken) return 'pending';

        const { MercadoPagoConfig, Payment } = require('mercadopago');
        const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
        const mpPayment = new Payment(mpClient);
        const result = await mpPayment.search({ options: { filters: { external_reference: record.externalRef } } });
        const results = result?.results || [];
        if (results.length === 0) return 'pending';

        const approved = results.find((p: any) => p.status === 'approved');
        if (approved) {
            // Update DB
            await prisma.paymentLink.update({
                where: { id: record.id },
                data: { status: 'approved', paidAt: new Date(approved.date_approved || Date.now()) }
            });
            return 'approved';
        }

        const rejected = results.find((p: any) => p.status === 'rejected' || p.status === 'cancelled');
        if (rejected) {
            await prisma.paymentLink.update({ where: { id: record.id }, data: { status: 'rejected' } });
            return 'rejected';
        }

        return 'pending';
    } catch (e: any) {
        logger.error('[MP_PAYMENT] Error verifying payment:', e.message);
        return 'pending';
    }
}

function _getClosingMsg(knowledge: any): string {
    return knowledge?.flow?.closing?.response ||
        'Perfecto! Pasame los datos para armar la etiqueta de envío 👇\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:';
}
