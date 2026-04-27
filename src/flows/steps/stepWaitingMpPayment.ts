import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _cleanPhone } from '../utils/flowHelpers';
import { calculateTotal, _recalcAdicionalMAX } from '../utils/cartHelpers';
import { randomUUID } from 'crypto';
import logger from '../../utils/logger';

const PAID_KEYWORDS = /\b(listo|pague|pagu[eé]|pago hecho|hice el pago|ya pague|ya pagu[eé]|realice|realic[eé]|confirmo|listo el pago|pago listo|lo hice|hecho|ok listo)\b/i;
const TRANSFER_FALLBACK_KEYWORDS = /\b(transfer[ei]ncia|transf|alias|3|tercero|tercera)\b/i;
const CASH_FALLBACK_KEYWORDS = /\b(efectivo|contra.?reembolso|contrarembolso|1|cartero|al recibir|no puedo|no tengo|no me sale|error|problema|no funciona|cancelar)\b/i;

export async function handleWaitingMpPayment(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // ── ENTRY: Sin link todavía — generar y enviar ─────────────────────────────
    if (!currentState.mpPaymentLinkUrl) {
        await _generateAndSendLink(userId, currentState, knowledge, dependencies);
        return { matched: true };
    }

    // ── Cliente dice que pagó ──────────────────────────────────────────────────
    const normalizedForPaid = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (PAID_KEYWORDS.test(text) || PAID_KEYWORDS.test(normalizedForPaid)) {
        const verified = await _verifyPayment(currentState);

        if (verified === 'approved') {
            const addr = currentState.partialAddress || {};
            const hasAddress = !!(addr.nombre && addr.calle && addr.ciudad);

            if (hasAddress) {
                await _finalizeOrderAndNotifyAdmin(userId, currentState, dependencies);
            } else {
                const msg = '¡Perfecto, el pago fue confirmado! 🎉\n\nAhora necesito los datos de envío para despachar tu pedido 👇\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:';
                _setStep(currentState, FlowStep.WAITING_DATA);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, msg);
            }
            return { matched: true };

        } else if (verified === 'pending') {
            const msg = '⏳ Todavía no veo el pago confirmado en el sistema.\n\nEsperá unos minutos y escribime *"listo"* cuando esté acreditado. Los pagos con tarjeta de crédito pueden demorar hasta 5 minutos.';
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            return { matched: true };

        } else {
            // rejected o error — ofrecer transferencia primero.
            // Restaurar adicionalMAX: cuando el cliente eligió MP, se waived
            // el adicional. Si MP rechaza y el cliente luego elige contra
            // reembolso, el adicional debe volver a aplicarse. _recalcAdicionalMAX
            // es idempotente y recalcula desde el cart actual.
            _recalcAdicionalMAX(currentState);
            calculateTotal(currentState);

            const msg = '⚠️ Hubo un problema con el pago de MercadoPago.\n\nNo te preocupes, tenemos otras opciones:\n\n3️⃣ *Transferencia bancaria* — alias *CHILE.TEXTO.CASINO*\n1️⃣ *Contra reembolso* — pagás al cartero cuando llega\n\n¿Cuál preferís?';
            currentState.paymentMethod = null;
            currentState.mpPaymentLinkId = null;
            currentState.mpPaymentLinkUrl = null;
            _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            return { matched: true };
        }
    }

    // ── Cliente pide transferencia ─────────────────────────────────────────────
    if (TRANSFER_FALLBACK_KEYWORDS.test(normalizedText)) {
        const msg = `¡Perfecto! Para transferir usá el alias *CHILE.TEXTO.CASINO*. Una vez que realicés la transferencia avisanos por acá y coordinamos el envío 😊`;
        currentState.paymentMethod = 'transferencia';
        currentState.mpPaymentLinkId = null;
        currentState.mpPaymentLinkUrl = null;

        // adicionalMAX ya estaba bonificado por MP — transferencia también lo bonifica
        // Avanzar al step correcto. Antes quedaba en waiting_mp_payment y, si admin
        // despausaba al cliente, el siguiente mensaje volvía a generar link MP.
        _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente cambió de MP a transferencia. Alias enviado, esperando confirmación.');
        return { matched: true };
    }

    // ── Cliente quiere contra reembolso ────────────────────────────────────────
    if (CASH_FALLBACK_KEYWORDS.test(normalizedText)) {
        // Restaurar adicionalMAX (plan 60 → vuelve a tener adicional) — fue waiveado
        // al elegir MP en el paso anterior.
        currentState.paymentMethod = 'contrarembolso';
        currentState.mpPaymentLinkId = null;
        currentState.mpPaymentLinkUrl = null;
        _recalcAdicionalMAX(currentState);
        calculateTotal(currentState);
        const msg = _getClosingMsg(knowledge);
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // ── Cliente pide que le reenvíen el link ───────────────────────────────────
    if (/\b(link|enlace|reenv[ií]a|reenviar|de nuevo|el link|manda|m[áa]ndame)\b/i.test(text) && currentState.mpPaymentLinkUrl) {
        const msg = `Acá está tu enlace de pago:\n\n${currentState.mpPaymentLinkUrl}\n\nCuando completes el pago escribime *"listo"* 👍`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // ── Captura de dirección en paralelo ───────────────────────────────────────
    // El cliente puede mandar los datos de envío junto con (o antes de) confirmar el pago.
    // Parseamos y guardamos en partialAddress para que, cuando el pago se confirme,
    // saltemos directo a WAITING_FINAL_CONFIRMATION sin volver a pedir datos.
    const looksLikeAddress = /\d/.test(text) && text.split(/\s+/).length >= 3;
    if (looksLikeAddress) {
        try {
            const parsed = await aiService.parseAddress(text);
            if (parsed && !parsed._error && (parsed.nombre || parsed.calle || parsed.ciudad || parsed.cp || parsed.provincia)) {
                if (!currentState.partialAddress) currentState.partialAddress = {} as any;
                const pa: any = currentState.partialAddress;
                if (parsed.nombre && !pa.nombre) { pa.nombre = parsed.nombre; if (!currentState.userName) currentState.userName = parsed.nombre; }
                if (parsed.calle && !pa.calle) pa.calle = parsed.calle;
                if (parsed.ciudad && !pa.ciudad) pa.ciudad = parsed.ciudad;
                if (parsed.cp && !pa.cp) pa.cp = parsed.cp;
                if (parsed.provincia && !pa.provincia) pa.provincia = parsed.provincia;

                // ¿El pago ya se confirmó (via webhook) mientras mandaban datos?
                const verified = await _verifyPayment(currentState);
                const hasAddress = !!(pa.nombre && pa.calle && pa.ciudad);

                if (verified === 'approved' && hasAddress) {
                    await _finalizeOrderAndNotifyAdmin(userId, currentState, dependencies);
                    return { matched: true };
                }

                // Pago todavía no confirmado: guardamos datos y seguimos esperando
                const missing: string[] = [];
                if (!pa.nombre) missing.push('Nombre completo');
                if (!pa.calle) missing.push('Calle y número');
                if (!pa.ciudad) missing.push('Localidad');
                if (!pa.cp) missing.push('Código postal');

                const ackMsg = missing.length > 0
                    ? `¡Gracias! Ya tengo tus datos. Me faltaría:\n\n${missing.map(m => `• ${m}`).join('\n')}\n\nY avisame cuando completes el pago 💳`
                    : `¡Perfecto! Ya tengo todos los datos de envío anotados 📦\n\nEn cuanto se acredite el pago armo el pedido. Avisame con *"listo"* cuando completes el pago 💳`;
                currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, ackMsg);
                return { matched: true };
            }
        } catch (e: any) {
            logger.warn('[MP_PAYMENT] parseAddress falló, cayendo a AI fallback:', e.message);
        }
    }

    // ── AI fallback ────────────────────────────────────────────────────────────
    const aiRes = await aiService.chat(text, {
        step: 'waiting_mp_payment',
        goal: `El cliente tiene un enlace de pago de MercadoPago y debe completarlo. Enlace ya enviado: ${currentState.mpPaymentLinkUrl}\n\nSi tiene dudas, explicale cómo pagar (tarjeta, app MP, QR). Si quiere cambiar a transferencia, decile que el alias es CHILE.TEXTO.CASINO. Si quiere contra reembolso, aclará que se paga al cartero. NUNCA reenvíes el link a menos que lo pida. Esperá que confirme con "listo" o "ya pagué".`,
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

// ── Helpers ────────────────────────────────────────────────────────────────────

async function _generateAndSendLink(
    userId: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<void> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const instanceId = dependencies.sellerId || 'default';

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) {
        logger.warn('[MP_PAYMENT] MP_ACCESS_TOKEN no configurado — fallback a contra reembolso');
        currentState.paymentMethod = 'contrarembolso';
        // adicionalMAX fue waiveado al elegir MP — restaurarlo ahora que volvemos a CR
        _recalcAdicionalMAX(currentState);
        calculateTotal(currentState);
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

        // Persistir en DB
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
                instanceId,
            }
        });

        currentState.mpPaymentLinkId = record.id;
        currentState.mpPaymentLinkUrl = link;
        saveState(userId);

        const productName = currentState.cart?.map((i: any) => i.product).join(' + ')
            || currentState.selectedProduct?.split(' de ')[0]
            || 'Herbalis';

        const msg = `💳 *Pago online via MercadoPago*\n\n` +
            `Pedido: *${productName}* — Plan ${currentState.selectedPlan} días\n` +
            `Total: *$${currentState.totalPrice}*\n\n` +
            `👇 Hacé clic para pagar de forma segura:\n${link}\n\n` +
            `Podés pagar con tarjeta, desde la app de MercadoPago o escaneando el QR.\n\n` +
            `✅ Cuando completes el pago, enviame el comprobante y pasame los datos de envío 👇\n\n` +
            `Nombre completo:\nCalle y número:\nLocalidad:\nCódigo postal:\nProvincia:`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
        logger.info(`[MP_PAYMENT] Link creado para ${userId} — $${amount} ARS — ${link}`);

    } catch (e: any) {
        logger.error('[MP_PAYMENT] Error generando link:', e.message);
        // Fallback: ofrecer transferencia o contra reembolso
        currentState.paymentMethod = null;
        currentState.mpPaymentLinkId = null;
        currentState.mpPaymentLinkUrl = null;
        const msg = '⚠️ Tuve un problema generando el enlace de pago 😓\n\nNo te preocupes, podés pagar de otra forma:\n\n3️⃣ *Transferencia* — alias *CHILE.TEXTO.CASINO*\n1️⃣ *Contra reembolso* — le pagás al cartero\n\n¿Cuál preferís?';
        _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
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

        // Webhook ya actualizó el estado
        if (record.status === 'approved') return 'approved';
        if (record.status === 'rejected' || record.status === 'expired') return 'rejected';

        // Consultar MP directamente
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
        logger.error('[MP_PAYMENT] Error verificando pago:', e.message);
        return 'pending';
    }
}

async function _finalizeOrderAndNotifyAdmin(
    userId: string,
    currentState: UserState,
    dependencies: any
): Promise<void> {
    const { sendMessageWithDelay, saveState, notifyAdmin, saveOrderToLocal, config, effectiveScript } = dependencies;
    const addr: any = currentState.partialAddress || {};

    calculateTotal(currentState);
    currentState.pendingOrder = {
        nombre: addr.nombre,
        calle: addr.calle,
        ciudad: addr.ciudad,
        cp: addr.cp,
        provincia: addr.provincia,
        calleOriginal: addr.calleOriginal || addr.calle,
        cart: currentState.cart
    };

    const cart = currentState.cart || [];
    const phone = userId.split('@')[0];
    const orderData = {
        cliente: phone,
        nombre: addr.nombre,
        calle: addr.calle,
        ciudad: addr.ciudad,
        cp: addr.cp,
        provincia: addr.provincia,
        calleOriginal: addr.calleOriginal || null,
        producto: cart.map((i: any) => i.product).join(' + ') || currentState.selectedProduct || '',
        plan: cart.map((i: any) => `${i.plan} días`).join(' + ') || `${currentState.selectedPlan || '60'} días`,
        precio: currentState.totalPrice || '0',
        postdatado: currentState.postdatado || null,
        paymentMethod: 'mercadopago'
    };
    currentState.hasSoldBefore = true;
    if (saveOrderToLocal) saveOrderToLocal(orderData);

    const postdataLabel = currentState.postdatado ? `\n📅 POSTDATADO: ${currentState.postdatado}` : '';
    const payLabel = '\n💳 PAGO: MercadoPago (ya abonado)';
    if (notifyAdmin) {
        await notifyAdmin(
            `⌛ Pedido Requiere Aprobación`,
            userId,
            `Datos: ${addr.nombre}, ${addr.calle}\nCiudad: ${addr.ciudad} | CP: ${addr.cp}\nProvincia: ${addr.provincia || '?'}\nItems: ${orderData.producto}\nTotal: $${currentState.totalPrice || '0'}${postdataLabel}${payLabel}`
        );
    }

    const _trackScript = effectiveScript || config?.activeScript;
    if (config && config.scriptStats && _trackScript && _trackScript !== 'rotacion') {
        if (!config.scriptStats[_trackScript]) config.scriptStats[_trackScript] = { started: 0, completed: 0 };
        config.scriptStats[_trackScript].completed++;
    }

    _setStep(currentState, FlowStep.WAITING_ADMIN_VALIDATION);
    const msg = '¡Perfecto, el pago fue confirmado y ya tengo tus datos! 🎉\n\nAguardame un instante que verificamos todo y te confirmamos el ingreso ⏳';
    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, msg);
}

function _getClosingMsg(knowledge: any): string {
    return knowledge?.flow?.closing?.response ||
        'Perfecto! Pasame los datos para armar la etiqueta de envío 👇\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:';
}
