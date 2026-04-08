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

            const updated = await prisma.paymentLink.update({
                where: { id: payment.id },
                data: {
                    status: newStatus,
                    paidAt: newStatus === 'approved' ? new Date(latest.date_approved || Date.now()) : payment.paidAt,
                }
            });

            if (io) io.emit('payment_updated', updated);
            res.json({ payment: updated, changed: updated.status !== payment.status });
        } catch (e) {
            logger.error(`[PAYMENTS] Error refreshing payment: ${e?.message || e} | status: ${e?.status} | cause: ${JSON.stringify(e?.cause || e?.response?.data || '')}`);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /mp-webhook — IPN from MercadoPago (no auth, verified by HMAC)
    router.post('/mp-webhook', async (req, res) => {
        res.sendStatus(200); // Respond immediately to MP
        try {
            // --- HMAC Signature Verification ---
            const mpWebhookSecret = process.env.MP_WEBHOOK_SECRET;
            if (mpWebhookSecret) {
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
            } else {
                logger.warn('[MP-WEBHOOK] MP_WEBHOOK_SECRET not set — skipping signature verification');
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

            const updated = await prisma.paymentLink.update({
                where: { id: payment.id },
                data: {
                    status: newStatus,
                    paidAt: newStatus === 'approved' ? new Date(mpData.date_approved || Date.now()) : payment.paidAt,
                }
            });

            // Emit to any available seller's socket (MP is global, emit to all)
            const anyInstance = clientPool.getAllSellers()?.[0];
            const io = anyInstance?.sharedState?.io;
            if (io) io.emit('payment_updated', updated);
            logger.info(`[MP-WEBHOOK] Payment ${payment.id} updated to ${newStatus}`);
        } catch (e) {
            logger.error('[MP-WEBHOOK] Error processing webhook:', e);
        }
    });

    return router;
};
