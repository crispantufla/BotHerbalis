const express = require('express');
const { prisma } = require('../../../db');
const logger = require('../../utils/logger');

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller, getInstanceId } = require('./routeHelpers');

    // GET /payments — list payment links scoped by seller
    router.get('/payments', ...withSeller(clientPool), async (req, res) => {
        try {
            const { status } = req.query;
            const where = {};
            if (status && status !== 'all') where.status = status;

            // Scope by instanceId — sellers see only their own, admins see all (or selected seller)
            const instanceId = getInstanceId(req);
            if (instanceId) where.instanceId = instanceId;

            const payments = await prisma.paymentLink.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: 200,
            });
            res.json({ payments });
        } catch (e) {
            logger.error('[PAYMENTS] Error listing payments:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /payments/:id/refresh — query real status from MercadoPago
    router.post('/payments/:id/refresh', ...withSeller(clientPool), async (req, res) => {
        try {
            const io = req.sellerInstance?.sharedState?.io;
            const payment = await prisma.paymentLink.findUnique({ where: { id: req.params.id } });
            if (!payment) return res.status(404).json({ error: 'Enlace no encontrado' });

            // Verify payment belongs to this seller
            const instanceId = getInstanceId(req);
            if (instanceId && payment.instanceId !== instanceId) return res.status(403).json({ error: 'No autorizado' });

            const mpToken = process.env.MP_ACCESS_TOKEN;
            if (!mpToken) return res.status(500).json({ error: 'MP_ACCESS_TOKEN no configurado' });

            const { MercadoPagoConfig, Payment } = require('mercadopago');
            const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
            const mpPayment = new Payment(mpClient);

            const result = await mpPayment.search({
                options: { external_reference: payment.externalRef }
            });

            const results = result?.results || [];
            if (results.length === 0) {
                return res.json({ payment, changed: false, message: 'Sin pagos encontrados aún' });
            }

            // Pick the most recent approved payment, otherwise most recent overall
            const approved = results.find(p => p.status === 'approved');
            const latest = approved || results[0];
            const newStatus = latest.status === 'approved' ? 'approved'
                : latest.status === 'rejected' ? 'rejected'
                : latest.status === 'cancelled' ? 'expired'
                : 'pending';

            // Flip a approved con CAS (mismo patrón que el webhook): solo el
            // ganador de la transición dispara el push al chat.
            let updated;
            let wonApprovedFlip = false;
            if (newStatus === 'approved') {
                const paidAt = new Date(latest.date_approved || Date.now());
                const casRes = await prisma.paymentLink.updateMany({
                    where: { id: payment.id, status: { not: 'approved' } },
                    data: { status: 'approved', paidAt },
                });
                wonApprovedFlip = casRes.count === 1;
                updated = { ...payment, status: 'approved', paidAt: wonApprovedFlip ? paidAt : payment.paidAt };
            } else {
                updated = await prisma.paymentLink.update({
                    where: { id: payment.id },
                    data: { status: newStatus, paidAt: payment.paidAt }
                });
            }

            if (io) {
                const sellerId = req.sellerId || payment.instanceId;
                if (sellerId) io.to(sellerId).emit('payment_updated', updated);
                io.to('admin').emit('payment_updated', { ...updated, sellerId });
            }

            // Mismo push que el webhook: si el refresh manual descubrió el approved,
            // confirmarle la compra al cliente sin esperar el "listo". El dueño se
            // resuelve por instanceId del link (no por req.sellerInstance: un admin
            // global puede refrescar links de cualquier seller).
            if (wonApprovedFlip) {
                const ownerInstance = payment.instanceId ? clientPool.getSeller(payment.instanceId) : null;
                if (ownerInstance) {
                    const { onPaymentLinkApproved } = require('../../services/mpPushConfirm');
                    onPaymentLinkApproved(updated, {
                        sharedState: ownerInstance.sharedState,
                        sendMessageWithDelay: ownerInstance.helpers.sendMessageWithDelay,
                        notifyAdmin: ownerInstance.helpers.notifyAdmin,
                        saveState: ownerInstance.sharedState.saveState,
                        saveOrderToLocal: ownerInstance.helpers.saveOrderToLocal,
                    }).catch((e) => logger.error('[PAYMENTS] push confirm error:', e?.message || e));
                } else {
                    logger.error(`[PAYMENTS] Pago ${payment.id} approved pero el seller ${payment.instanceId} no está en el pool — push diferido al sweep del scheduler.`);
                }
            }
            res.json({ payment: updated, changed: updated.status !== payment.status });
        } catch (e) {
            logger.error(`[PAYMENTS] Error refreshing payment: ${e?.message || e} | status: ${e?.status} | cause: ${JSON.stringify(e?.cause || e?.response?.data || '')}`);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /payments/manual-link — admin/seller genera un link MP manualmente
    // desde el dashboard (ej: panel Asistente IA, modal de Payment MP Link).
    // Recibe { amount } y devuelve { link } tras crear la preferencia en MP +
    // persistir el PaymentLink. NO se asocia a un chat específico —
    // sellerPhone queda null y el seller pega el link manualmente en el chat.
    router.post('/payments/manual-link', ...withSeller(clientPool), async (req, res) => {
        try {
            const { amount, title } = req.body || {};
            const amt = parseFloat(String(amount || '').replace(',', '.').replace(/[^\d.]/g, ''));
            if (!amt || isNaN(amt) || amt <= 0) {
                return res.status(400).json({ error: 'Monto inválido' });
            }

            const mpToken = process.env.MP_ACCESS_TOKEN;
            if (!mpToken) return res.status(503).json({ error: 'MP_ACCESS_TOKEN no configurado' });

            const { MercadoPagoConfig, Preference } = require('mercadopago');
            const { randomUUID } = require('crypto');
            const externalRef = randomUUID();
            const webhookUrl = process.env.MP_WEBHOOK_URL;
            const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
            const preference = new Preference(mpClient);
            const body = {
                items: [{
                    title: (title || 'Pago Herbalis').toString().slice(0, 80),
                    quantity: 1, unit_price: amt, currency_id: 'ARS',
                }],
                back_urls: {
                    success: 'https://herbalis.com.ar',
                    failure: 'https://herbalis.com.ar',
                    pending: 'https://herbalis.com.ar',
                },
                auto_return: 'approved',
                external_reference: externalRef,
            };
            if (webhookUrl) body.notification_url = webhookUrl;
            const response = await preference.create({ body });
            const link = response.init_point;

            const instanceId = getInstanceId(req);
            const record = await prisma.paymentLink.create({
                data: {
                    preferenceId: response.id,
                    externalRef,
                    amount: amt,
                    link,
                    source: 'manual_dashboard',
                    status: 'pending',
                    instanceId: instanceId || 'default',
                },
            });

            // Emitir socket event para refrescar PaymentsView en vivo.
            const io = req.sellerInstance?.sharedState?.io;
            if (io && instanceId) {
                io.to(instanceId).emit('payment_created', record);
                io.to('admin').emit('payment_created', { ...record, sellerId: instanceId });
            }

            logger.info(`[PAYMENTS] Manual link created: $${amt} ARS (instance=${instanceId})`);
            res.json({ link, amount: amt, id: record.id });
        } catch (e) {
            logger.error(`[PAYMENTS] Error creating manual link: ${e?.message || e}`);
            res.status(500).json({ error: e?.message || 'Error generando link MP' });
        }
    });

    // POST /mp-webhook — IPN from MercadoPago (no auth, verified by HMAC)
    router.post('/mp-webhook', async (req, res) => {
        res.sendStatus(200); // Respond immediately to MP
        try {
            // --- HMAC Signature Verification (fail-closed) ---
            // Si el secret no está seteado, RECHAZAMOS el webhook. Antes hacíamos
            // skip con un warn, lo cual permitía que un atacante con un
            // externalRef forjara webhooks "approved". Fail-closed por defecto.
            const mpWebhookSecret = process.env.MP_WEBHOOK_SECRET;
            if (!mpWebhookSecret) {
                logger.error('[MP-WEBHOOK] MP_WEBHOOK_SECRET no seteado — rechazando webhook (fail-closed). Configurar el secret en env vars para habilitar.');
                return;
            }
            const xSignature = req.headers['x-signature'];
            const xRequestId = req.headers['x-request-id'];
            if (!xSignature || !xRequestId) {
                logger.warn('[MP-WEBHOOK] Missing x-signature or x-request-id headers. Ignoring.');
                return;
            }
            // Parse ts and hash from header: "ts=...,v1=..."
            const parts = {};
            xSignature.split(',').forEach(p => {
                const [k, v] = p.trim().split('=', 2);
                parts[k] = v;
            });
            const ts = parts['ts'];
            const v1 = parts['v1'];
            if (!ts || !v1) {
                logger.warn('[MP-WEBHOOK] Malformed x-signature header. Ignoring.');
                return;
            }
            // Build the manifest string as per MP docs
            const dataId = req.query['data.id'] || req.body?.data?.id || '';
            const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
            const crypto = require('crypto');
            const hmac = crypto.createHmac('sha256', mpWebhookSecret).update(manifest).digest('hex');
            if (hmac !== v1) {
                logger.warn('[MP-WEBHOOK] HMAC verification failed. Possible spoofed request.');
                return;
            }

            const { type, data } = req.body;
            if (type !== 'payment' || !data?.id) return;

            const mpToken = process.env.MP_ACCESS_TOKEN;
            if (!mpToken) return;

            const { MercadoPagoConfig, Payment } = require('mercadopago');
            const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
            const mpPayment = new Payment(mpClient);

            const mpData = await mpPayment.get({ id: data.id });
            if (!mpData?.external_reference) return;

            const payment = await prisma.paymentLink.findUnique({
                where: { externalRef: mpData.external_reference }
            });
            if (!payment) return;

            const newStatus = mpData.status === 'approved' ? 'approved'
                : mpData.status === 'rejected' ? 'rejected'
                : mpData.status === 'cancelled' ? 'expired'
                : 'pending';

            // Flip a approved con CAS (un solo ganador): webhook, cron y refresh
            // manual pueden correr a la vez (o duplicarse tras un restart) — el
            // updateMany condicionado garantiza que UNO solo vea la transición y
            // dispare el push, sin depender de guards en memoria.
            let updated;
            let wonApprovedFlip = false;
            if (newStatus === 'approved') {
                const paidAt = new Date(mpData.date_approved || Date.now());
                const res = await prisma.paymentLink.updateMany({
                    where: { id: payment.id, status: { not: 'approved' } },
                    data: { status: 'approved', paidAt },
                });
                wonApprovedFlip = res.count === 1;
                updated = { ...payment, status: 'approved', paidAt: wonApprovedFlip ? paidAt : payment.paidAt };
            } else {
                updated = await prisma.paymentLink.update({
                    where: { id: payment.id },
                    data: { status: newStatus, paidAt: payment.paidAt }
                });
            }

            // Route the update to the seller that owns the payment link, plus admin room
            const sellerId = payment.instanceId;
            const ownerInstance = sellerId ? clientPool.getSeller(sellerId) : null;
            const io = ownerInstance?.sharedState?.io || clientPool.getAllSellers()?.[0]?.sharedState?.io;
            if (io) {
                if (sellerId) io.to(sellerId).emit('payment_updated', updated);
                io.to('admin').emit('payment_updated', { ...updated, sellerId });
            }
            logger.info(`[MP-WEBHOOK] Payment ${payment.id} updated to ${newStatus}`);

            // Push al chat: si el dueño del link sigue en waiting_mp_payment,
            // confirmarle la compra SIN esperar a que escriba "listo". Solo el
            // ganador del CAS pushea (MP reintenta webhooks — sin re-trabajo;
            // además onPaymentLinkApproved es idempotente por step/link).
            if (wonApprovedFlip && ownerInstance) {
                const { onPaymentLinkApproved } = require('../../services/mpPushConfirm');
                onPaymentLinkApproved(updated, {
                    sharedState: ownerInstance.sharedState,
                    sendMessageWithDelay: ownerInstance.helpers.sendMessageWithDelay,
                    notifyAdmin: ownerInstance.helpers.notifyAdmin,
                    saveState: ownerInstance.sharedState.saveState,
                    saveOrderToLocal: ownerInstance.helpers.saveOrderToLocal,
                }).catch((e) => logger.error('[MP-WEBHOOK] push confirm error:', e?.message || e));
            } else if (wonApprovedFlip && !ownerInstance) {
                // El seller no está en el pool (restart del watchdog, boot). El
                // sweep de refreshPendingPayments reconcilia esta fila approved
                // cuando la instancia vuelva — acá solo dejamos rastro.
                logger.error(`[MP-WEBHOOK] Pago ${payment.id} approved pero el seller ${sellerId} no está en el pool — push diferido al sweep del scheduler.`);
            }
        } catch (e) {
            logger.error('[MP-WEBHOOK] Error processing webhook:', e);
        }
    });

    return router;
};
