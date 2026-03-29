const express = require('express');
const { prisma } = require('../../db');
const { authMiddleware } = require('../../middleware/auth');
const logger = require('../../utils/logger');

module.exports = (client, sharedState) => {
    const router = express.Router();

    // GET /payments — list all payment links, newest first
    router.get('/payments', authMiddleware, async (req, res) => {
        try {
            const { status } = req.query;
            const where = {};
            if (status && status !== 'all') where.status = status;

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
    router.post('/payments/:id/refresh', authMiddleware, async (req, res) => {
        try {
            const payment = await prisma.paymentLink.findUnique({ where: { id: req.params.id } });
            if (!payment) return res.status(404).json({ error: 'Enlace no encontrado' });

            const mpToken = process.env.MP_ACCESS_TOKEN;
            if (!mpToken) return res.status(500).json({ error: 'MP_ACCESS_TOKEN no configurado' });

            const { MercadoPagoConfig, Payment } = require('mercadopago');
            const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
            const mpPayment = new Payment(mpClient);

            const result = await mpPayment.search({
                options: { filters: { external_reference: payment.externalRef } }
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

            if (sharedState.io) sharedState.io.emit('payment_updated', updated);
            res.json({ payment: updated, changed: updated.status !== payment.status });
        } catch (e) {
            logger.error('[PAYMENTS] Error refreshing payment:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /mp-webhook — IPN from MercadoPago (no auth)
    router.post('/mp-webhook', async (req, res) => {
        res.sendStatus(200); // Respond immediately to MP
        try {
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

            if (sharedState.io) sharedState.io.emit('payment_updated', updated);
            logger.info(`[MP-WEBHOOK] Payment ${payment.id} updated to ${newStatus}`);
        } catch (e) {
            logger.error('[MP-WEBHOOK] Error processing webhook:', e);
        }
    });

    return router;
};
