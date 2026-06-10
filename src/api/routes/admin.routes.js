const logger = require('../../utils/logger');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../../../db');
const { authMiddleware } = require('../../middleware/auth');
const validate = require('../../middleware/validate');
const { configSchema } = require('../../schemas/admin.schema');
const { adminCommandSchema } = require('../../schemas/system.schema');

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller, getInstanceId } = require('./routeHelpers');
    const { requireAdmin } = require('../../middleware/jwtAuth');

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

    // POST /admin-command (admin only)
    router.post('/admin-command', ...withSeller(clientPool), requireAdmin, validate(adminCommandSchema), async (req, res) => {
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

    // POST /mp-link — generate MercadoPago payment link. Sellers can use it for their own chats.
    // If `sendToChat: true` and `userPhone` is provided, the link is also sent via WhatsApp.
    router.post('/mp-link', ...withSeller(clientPool), async (req, res) => {
        const amount = parseFloat(req.body?.amount);
        const userPhone = req.body?.userPhone || null;
        const sendToChat = !!req.body?.sendToChat;
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto inválido' });
        if (sendToChat && !userPhone) return res.status(400).json({ error: 'userPhone requerido para enviar al chat' });

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
                    instanceId: getInstanceId(req),
                }
            });

            const ctx = getCtx(req);
            if (ctx.io) {
                const sellerId = req.sellerId;
                if (sellerId) ctx.io.to(sellerId).emit('payment_created', record);
                ctx.io.to('admin').emit('payment_created', { ...record, sellerId });
            }

            let sent = false;
            if (sendToChat) {
                const client = req.sellerInstance?.client;
                const chatId = userPhone.includes('@') ? userPhone : `${userPhone.replace(/\D/g, '')}@c.us`;
                const msg = `💳 *Pago con tarjeta de crédito*\n\n` +
                    `Total: *$${amount.toLocaleString('es-AR')}*\n\n` +
                    `👇 Hacé clic para pagar de forma segura:\n${link}\n\n` +
                    `Es un pago 100% protegido: si por algo no te llega, te devuelven la plata.\n\n` +
                    `✅ Cuando completes el pago, avisame por acá y seguimos con el envío.`;
                try {
                    if (!client) throw new Error('Cliente WhatsApp no disponible');
                    await client.sendMessage(chatId, msg);
                    sent = true;
                    // Log the outgoing message so it appears in the chat history
                    if (ctx.sharedState?.logAndEmit) {
                        ctx.sharedState.logAndEmit(chatId, 'bot', msg, 'mp_link_manual');
                    }
                } catch (e) {
                    logger.error(`[MP] Failed to send link to ${chatId}:`, e.message);
                    return res.status(200).json({ link, amount, paymentId: record.id, sent: false, sendError: e.message });
                }
            }

            res.json({ link, amount, paymentId: record.id, sent });
        } catch (e) {
            logger.error('[MP] Error creating preference:', e);
            res.status(500).json({ error: e?.message || 'Error generando enlace' });
        }
    });

    // POST /config — sellers can configure their own alert numbers, admins can configure any seller's
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

    // POST /agent/update — empuja {t:'update'} al agente remoto del seller (PC del
    // vendedor). El agente baja los archivos nuevos de /agent-dist y se relanza
    // (exit 99 → run.bat). Uso típico tras deployar un cambio de agent/sidebar.js:
    //   POST /api/agent/update?sellerId=horacio  (con JWT de admin)
    router.post('/agent/update', ...withSeller(clientPool), requireAdmin, (req, res) => {
        const { agentHub } = require('../../services/agentBridge');
        const sellerId = req.sellerId;
        if (!sellerId) return res.status(400).json({ error: 'sellerId requerido (?sellerId=… para admins)' });
        if (!agentHub.isOnline(sellerId)) return res.status(404).json({ error: `Agente de ${sellerId} no conectado` });
        const sent = agentHub.send(sellerId, { t: 'update' });
        logger.info(`[AGENT-DIST] Push de update a ${sellerId}: ${sent ? 'enviado' : 'falló'}`);
        res.json({ ok: sent });
    });

    // GET /agent/installer — genera el instalador del agente para el seller y lo
    // sirve como un .bat autocontenido (un archivo, doble click). El config (URLs,
    // WA_AGENT_TOKEN, y un JWT fresco de 365d para los botones del panel) se arma
    // al vuelo desde el entorno — el container NO tiene agent/config.json. Sin
    // requireAdmin: cada seller queda lockeado a su sellerId (descarga el propio);
    // un admin global pasa ?sellerId. Es SU token, no hay escalación.
    router.get('/agent/installer', ...withSeller(clientPool), async (req, res) => {
        const fs = require('fs');
        const path = require('path');
        const jwt = require('jsonwebtoken');
        const sellerId = req.sellerId;
        if (!sellerId) return res.status(400).json({ error: 'sellerId requerido (?sellerId=… para admins globales)' });

        const agentToken = process.env[`WA_AGENT_TOKEN_${sellerId.toUpperCase()}`] || process.env.WA_AGENT_TOKEN;
        if (!agentToken) return res.status(400).json({ error: `Falta WA_AGENT_TOKEN_${sellerId.toUpperCase()} en el entorno` });

        const secret = process.env.JWT_SECRET || process.env.API_KEY;
        if (!secret) return res.status(500).json({ error: 'JWT_SECRET no configurado' });

        try {
            // apiToken: JWT del seller para los botones del panel. 365d — si expira,
            // el panel deja de operar. Se firma con los datos reales del account.
            const acc = await prisma.account.findFirst({
                where: { sellerId }, select: { id: true, role: true, sellerId: true, name: true },
            });
            if (!acc) return res.status(404).json({ error: `No hay cuenta para el seller ${sellerId}` });
            const apiToken = jwt.sign(
                { accountId: acc.id, role: acc.role, sellerId: acc.sellerId, name: acc.name },
                secret, { expiresIn: '365d' },
            );

            // URLs derivadas del host del request (no hardcodeadas) — funciona en
            // cualquier deploy. ws/http solo en local; wss/https en producción.
            const host = req.get('host');
            const local = /localhost|127\.0\.0\.1/.test(host);
            const cfg = {
                gatewayUrl: `${local ? 'ws' : 'wss'}://${host}/agent`,
                sellerId,
                token: agentToken,
                apiBase: `${local ? 'http' : 'https'}://${host}`,
                apiToken,
            };
            const b64 = Buffer.from(JSON.stringify(cfg, null, 2), 'utf8').toString('base64');

            const tpl = fs.readFileSync(path.join(__dirname, '../../../agent/installer/install.ps1'), 'utf8');
            const ps1 = tpl.replace(/__CONFIG_B64__/g, b64);

            // .bat polyglot: cmd corre la 1ra línea; PowerShell se lee a sí mismo
            // (%~f0), corta tras el marcador #PS# y ejecuta el resto. El marcador en
            // la línea de comando va como [char]35 para no aparecer literal antes
            // del real. chcp 65001 = acentos OK en consola.
            const bat = [
                '@echo off',
                'chcp 65001 >nul',
                `powershell -NoProfile -ExecutionPolicy Bypass -Command "$f=[IO.File]::ReadAllText('%~f0');iex $f.Substring($f.IndexOf([char]35+'PS'+[char]35)+4)"`,
                'echo.',
                'pause',
                'exit /b',
                '#PS#',
                ps1,
            ].join('\r\n');

            logger.info(`[AGENT-DIST] Instalador generado para ${sellerId} (host ${host})`);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="Instalar Bot Herbalis - ${sellerId}.bat"`);
            res.setHeader('Cache-Control', 'no-store');
            res.send(Buffer.from(bat, 'utf8'));
        } catch (e) {
            logger.error('[AGENT-DIST] installer:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
