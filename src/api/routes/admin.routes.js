const logger = require('../../utils/logger');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../../../db');
const { authMiddleware } = require('../../middleware/auth');
const validate = require('../../middleware/validate');
const { configSchema, scriptSchema } = require('../../schemas/admin.schema');
const { adminCommandSchema } = require('../../schemas/system.schema');

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller } = require('./routeHelpers');

    const getCtx = (req) => {
        const ss = req.sellerInstance?.sharedState;
        return {
            client: req.sellerInstance?.client,
            sharedState: ss,
            config: ss?.config || {},
            knowledge: ss?.knowledge || {},
            pausedUsers: ss?.pausedUsers || new Set(),
            saveState: ss?.saveState?.bind(ss) || (() => {}),
            saveKnowledge: ss?.saveKnowledge?.bind(ss) || (() => {}),
            io: ss?.io || null,
        };
    };

    // POST /admin-command
    router.post('/admin-command', ...withSeller(clientPool), validate(adminCommandSchema), async (req, res) => {
        const { chatId, command } = req.body;
        const { sharedState } = getCtx(req);
        try {
            if (sharedState?.handleAdminCommand) {
                const result = await sharedState.handleAdminCommand(chatId, command, true);
                res.json({ success: true, message: result });
            } else {
                res.status(501).json({ error: 'Handler not attached' });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /script
    router.get('/script', ...withSeller(clientPool), (req, res) => res.json(getCtx(req).knowledge));

    // POST /script
    router.post('/script', ...withSeller(clientPool), validate(scriptSchema), (req, res) => {
        try {
            const { sharedState, config, knowledge, saveKnowledge } = getCtx(req);
            const { version } = req.body;
            const targetVersion = version || config.activeScript || 'v3';

            if (sharedState?.multiKnowledge && sharedState.multiKnowledge[targetVersion]) {
                Object.assign(sharedState.multiKnowledge[targetVersion], req.body);
                saveKnowledge(targetVersion);
                res.json({ success: true, message: `Script ${targetVersion} updated successfully` });
            } else {
                Object.assign(knowledge, req.body);
                saveKnowledge();
                res.json({ success: true, message: 'Script updated successfully (fallback)' });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /mp-link — generate MercadoPago payment link
    router.post('/mp-link', ...withSeller(clientPool), async (req, res) => {
        const amount = parseFloat(req.body?.amount);
        const userPhone = req.body?.userPhone || null;
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto inválido' });

        const mpToken = process.env.MP_ACCESS_TOKEN;
        if (!mpToken) return res.status(500).json({ error: 'MP_ACCESS_TOKEN no configurado' });

        try {
            const { MercadoPagoConfig, Preference } = require('mercadopago');
            const externalRef = uuidv4();
            const webhookUrl = process.env.MP_WEBHOOK_URL;
            const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
            const preference = new Preference(mpClient);
            const body = {
                items: [{ title: 'Pago Herbalis', quantity: 1, unit_price: amount, currency_id: 'ARS' }],
                back_urls: { success: 'https://herbalis.com.ar', failure: 'https://herbalis.com.ar', pending: 'https://herbalis.com.ar' },
                auto_return: 'approved',
                external_reference: externalRef,
            };
            if (webhookUrl) body.notification_url = webhookUrl;

            const response = await preference.create({ body });
            const link = response.init_point;

            const record = await prisma.paymentLink.create({
                data: {
                    preferenceId: response.id,
                    externalRef,
                    amount,
                    link,
                    userPhone,
                    source: 'dashboard',
                    status: 'pending',
                }
            });

            const ctx = getCtx(req);
            if (ctx.io) ctx.io.emit('payment_created', record);
            res.json({ link, amount, paymentId: record.id });
        } catch (e) {
            logger.error('[MP] Error creating preference:', e);
            res.status(500).json({ error: e?.message || 'Error generando enlace' });
        }
    });

    // POST /config
    router.post('/config', ...withSeller(clientPool), validate(configSchema), async (req, res) => {
        const { client, config, saveState } = getCtx(req);
        const { alertNumber, action, number } = req.body;

        if (action && number) {
            if (!config.alertNumbers) config.alertNumbers = [];
            const cleanNum = number.replace(/\D/g, '');
            if (cleanNum.length < 8) return res.status(400).json({ error: 'Invalid phone number' });

            if (action === 'add') {
                if (!config.alertNumbers.includes(cleanNum)) {
                    config.alertNumbers.push(cleanNum);
                    try {
                        await client?.sendMessage(`${cleanNum}@c.us`, '✅ *HERBALIS BOT*\n\nEste número fue registrado como *administrador*.\n\nRecibiras alertas de:\n• 🛒 Nuevos pedidos\n• ⚠️ Intervenciones requeridas\n• 🔧 Errores del sistema\n\n_Podés ser removido desde el panel de control._');
                    } catch (e) { logger.error(`[CONFIG] Failed to send welcome to ${cleanNum}:`, e.message); }
                }
            } else if (action === 'remove') {
                config.alertNumbers = config.alertNumbers.filter(n => n !== cleanNum);
                try {
                    await client?.sendMessage(`${cleanNum}@c.us`, '🔕 *HERBALIS BOT*\n\nEste número fue *removido* de la lista de administradores.\n\nYa no recibirás alertas del sistema.');
                } catch (e) { logger.error(`[CONFIG] Failed to send removal notice to ${cleanNum}:`, e.message); }
            }

            saveState();
            return res.json({ success: true, config });
        }

        if (alertNumber !== undefined) {
            if (!config.alertNumbers) config.alertNumbers = [];
            const newNum = alertNumber ? alertNumber.replace(/\D/g, '') : null;
            if (newNum && !config.alertNumbers.includes(newNum)) config.alertNumbers.push(newNum);
            saveState();
            return res.json({ success: true, config });
        }

        res.status(400).json({ error: 'Missing action/number or alertNumber' });
    });

    return router;
};
