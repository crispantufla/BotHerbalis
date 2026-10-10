/**
 * promo.routes.js — campañas promo (reactivación de leads que no compraron).
 *
 *   GET  /promo/audience            → cuántos recibirían la promo con estos filtros (sin crear nada)
 *   POST /promo/preview             → 5 textos de muestra (cada destinatario recibe uno distinto)
 *   GET  /promo/campaigns           → campañas del seller con sus números
 *   POST /promo/campaigns           → crea una campaña (congela la lista de destinatarios, mezclada)
 *   GET  /promo/campaigns/:id       → detalle + destinatarios (filtro ?status=)
 *   POST /promo/campaigns/:id/start | pause | resume | cancel
 *   POST /promo/campaigns/:id/send-now → manda el siguiente ya (saltea ventana y turno), para probar
 *
 * Una sola campaña `running` por seller. El envío lo hace el scheduler
 * (promoTick, cada minuto), no estas rutas.
 */

const express = require('express');
const { prisma } = require('../../../db');
const logger = require('../../utils/logger');
const validate = require('../../middleware/validate');
const { createCampaignSchema, previewSchema } = require('../../schemas/promo.schema');
const { selectPromoAudience, normalizeAudienceFilters } = require('../../services/promo/promoAudience');
const { countCombinations } = require('../../services/promo/promoTemplates');
const { normalizePromoConfig, promoTick, buildPromoText, loadPromoImage, DEFAULT_PROMO_CONFIG } = require('../../services/promo/promoDispatcher');
const { DEFAULT_BASE_MESSAGE } = require('../../services/promo/promoVariation');
const { _getPromoPrice60 } = require('../../flows/utils/pricing');

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller, getInstanceId } = require('./routeHelpers');

    const needSeller = (req, res) => {
        const instanceId = getInstanceId(req);
        if (!instanceId) { res.status(400).json({ error: 'Seleccioná un vendedor primero' }); return null; }
        return instanceId;
    };

    const adminPhones = (req) => {
        const cfg = req.sellerInstance?.sharedState?.config;
        return Array.isArray(cfg?.alertNumbers) ? cfg.alertNumbers : [];
    };

    async function campaignStats(c) {
        const rows = await prisma.promoRecipient.groupBy({ by: ['status'], where: { campaignId: c.id }, _count: { _all: true } });
        const outcomes = await prisma.promoRecipient.groupBy({ by: ['outcome'], where: { campaignId: c.id, outcome: { not: null } }, _count: { _all: true } });
        const byStatus = Object.fromEntries(rows.map(r => [r.status, r._count._all]));
        const byOutcome = Object.fromEntries(outcomes.map(r => [r.outcome, r._count._all]));
        // Conversiones: destinatarios con un pedido creado después de recibir la promo.
        const sent = await prisma.promoRecipient.findMany({ where: { campaignId: c.id, status: 'sent' }, select: { phone: true, sentAt: true } });
        let converted = 0;
        if (sent.length > 0) {
            const minSent = sent.reduce((m, r) => (r.sentAt && r.sentAt < m ? r.sentAt : m), new Date());
            const orders = await prisma.order.findMany({
                where: { instanceId: c.instanceId, userPhone: { in: sent.map(r => r.phone) }, createdAt: { gte: minSent } },
                select: { userPhone: true, createdAt: true },
            });
            const sentAt = new Map(sent.map(r => [r.phone, r.sentAt]));
            converted = new Set(orders.filter(o => sentAt.get(o.userPhone) && o.createdAt >= sentAt.get(o.userPhone)).map(o => o.userPhone)).size;
        }
        const total = rows.reduce((s, r) => s + r._count._all, 0);
        return {
            total,
            pending: byStatus.pending || 0,
            sent: byStatus.sent || 0,
            skipped: byStatus.skipped || 0,
            failed: byStatus.failed || 0,
            optedOut: (byStatus.opted_out || 0),
            replied: (byOutcome.interested || 0) + (byOutcome.declined || 0) + (byOutcome.question || 0) + (byOutcome.opted_out || 0),
            interested: byOutcome.interested || 0,
            declined: byOutcome.declined || 0,
            converted,
        };
    }

    const serialize = (c) => ({ ...c, config: (() => { try { return JSON.parse(c.config); } catch { return {}; } })() });

    // GET /promo/audience
    router.get('/promo/audience', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const filters = normalizeAudienceFilters(instanceId, { ...req.query, excludePhones: adminPhones(req) });
            const { members, summary } = await selectPromoAudience(filters);
            res.json({ filters, summary, sample: members.slice(0, 10).map(m => ({ phone: m.phone, name: m.name, step: m.step, lastSeen: m.lastSeen })) });
        } catch (e) {
            logger.error('[PROMO] audience:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /promo/preview — muestras del texto. En modo 'ai' le pide a Claude
    // `count` reescrituras del mensaje base (cada una cuesta una llamada al
    // modelo simple); en modo 'templates', variantes de las plantillas.
    router.post('/promo/preview', ...withSeller(clientPool), validate(previewSchema), async (req, res) => {
        try {
            const price = _getPromoPrice60('Gotas');
            if (!price) return res.status(400).json({ error: 'No hay precio promo cargado (Editor de Precios → promoPrice60)' });
            const instanceId = getInstanceId(req) || 'default';
            const cfg = normalizePromoConfig(req.body, instanceId);
            const count = req.body.count || 3;
            const names = ['María', null, 'Jorge', null, 'Rosa', null];
            const samples = [];
            const via = [];
            for (let i = 0; i < count; i++) {
                const built = await buildPromoText({ cfg, campaignId: `preview-${Date.now()}-${i}`, phone: `549341000${String(1000 + i * 7919).slice(-4)}`, name: names[i % names.length], price60: price });
                samples.push(built.text);
                via.push(built.via);
            }
            res.json({
                price60: price,
                mode: cfg.variationMode,
                via,
                combinations: countCombinations(req.body.templates || null),
                samples,
                defaults: { ...DEFAULT_PROMO_CONFIG, baseMessage: DEFAULT_BASE_MESSAGE },
                aiAvailable: !!(require('../../services/ai').aiService?.anthropic),
            });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // GET /promo/campaigns
    router.get('/promo/campaigns', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const campaigns = await prisma.promoCampaign.findMany({ where: { instanceId }, orderBy: { createdAt: 'desc' }, take: 50 });
            const out = [];
            for (const c of campaigns) out.push({ ...serialize(c), stats: await campaignStats(c) });
            res.json({ campaigns: out, price60: _getPromoPrice60('Gotas'), baseMessageDefault: DEFAULT_BASE_MESSAGE });
        } catch (e) {
            logger.error('[PROMO] list:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /promo/campaigns
    router.post('/promo/campaigns', ...withSeller(clientPool), validate(createCampaignSchema), async (req, res) => {
        try {
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const cfg = normalizePromoConfig(req.body.config || {}, instanceId);
            if (!_getPromoPrice60('Gotas')) return res.status(400).json({ error: 'Cargá el precio promo en el Editor de Precios antes de crear la campaña' });

            const { members, summary } = await selectPromoAudience({ instanceId, ...cfg.audience, excludePhones: adminPhones(req) });
            if (members.length === 0) return res.status(400).json({ error: 'Con estos filtros no queda nadie a quien mandarle', summary });

            const campaign = await prisma.promoCampaign.create({
                data: { instanceId, name: req.body.name.trim(), status: 'draft', config: JSON.stringify(cfg) },
            });
            const CHUNK = 500;
            for (let i = 0; i < members.length; i += CHUNK) {
                await prisma.promoRecipient.createMany({
                    data: members.slice(i, i + CHUNK).map((m, j) => ({ campaignId: campaign.id, instanceId, phone: m.phone, position: i + j })),
                    skipDuplicates: true,
                });
            }
            logger.info(`[PROMO][${instanceId}] Campaña "${campaign.name}" creada con ${members.length} destinatarios`);
            res.json({ campaign: { ...serialize(campaign), stats: await campaignStats(campaign) }, summary });
        } catch (e) {
            logger.error('[PROMO] create:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /promo/campaigns/:id
    router.get('/promo/campaigns/:id', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const c = await prisma.promoCampaign.findFirst({ where: { id: req.params.id, instanceId } });
            if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
            const where = { campaignId: c.id, ...(req.query.status ? { status: String(req.query.status) } : {}) };
            const recipients = await prisma.promoRecipient.findMany({ where, orderBy: [{ sentAt: 'desc' }, { position: 'asc' }], take: 300 });
            res.json({ campaign: { ...serialize(c), stats: await campaignStats(c) }, recipients });
        } catch (e) {
            logger.error('[PROMO] detail:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Transiciones de estado.
    const transition = (action) => async (req, res) => {
        try {
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const c = await prisma.promoCampaign.findFirst({ where: { id: req.params.id, instanceId } });
            if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });

            let data;
            if (action === 'start' || action === 'resume') {
                if (!['draft', 'paused'].includes(c.status)) return res.status(409).json({ error: `No se puede ${action === 'start' ? 'iniciar' : 'reanudar'} una campaña en estado "${c.status}"` });
                const other = await prisma.promoCampaign.findFirst({ where: { instanceId, status: 'running', id: { not: c.id } } });
                if (other) return res.status(409).json({ error: `Ya hay una campaña corriendo ("${other.name}"). Pausala o cancelala primero.` });
                // Primer envío entre 1 y 5 minutos después de arrancar (si está en ventana).
                data = { status: 'running', startedAt: c.startedAt || new Date(), failStreak: 0, nextSendAt: new Date(Date.now() + (1 + Math.random() * 4) * 60000) };
            } else if (action === 'pause') {
                if (c.status !== 'running') return res.status(409).json({ error: 'Solo se pausa una campaña que está corriendo' });
                data = { status: 'paused' };
            } else if (action === 'cancel') {
                if (['finished', 'cancelled'].includes(c.status)) return res.status(409).json({ error: 'La campaña ya terminó' });
                data = { status: 'cancelled', finishedAt: new Date(), nextSendAt: null };
            }
            const updated = await prisma.promoCampaign.update({ where: { id: c.id }, data });
            logger.info(`[PROMO][${instanceId}] Campaña "${c.name}" → ${updated.status} (${action})`);
            res.json({ campaign: { ...serialize(updated), stats: await campaignStats(updated) } });
        } catch (e) {
            logger.error(`[PROMO] ${action}:`, e);
            res.status(500).json({ error: e.message });
        }
    };
    router.post('/promo/campaigns/:id/start', ...withSeller(clientPool), transition('start'));
    router.post('/promo/campaigns/:id/resume', ...withSeller(clientPool), transition('resume'));
    router.post('/promo/campaigns/:id/pause', ...withSeller(clientPool), transition('pause'));
    router.post('/promo/campaigns/:id/cancel', ...withSeller(clientPool), transition('cancel'));

    // POST /promo/campaigns/:id/send-now — manda el siguiente destinatario ya mismo
    // (prueba controlada): saltea ventana, tope y turno, pero respeta todas las
    // re-validaciones del destinatario.
    router.post('/promo/campaigns/:id/send-now', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const inst = req.sellerInstance;
            if (!inst?.sharedState?.isConnected) return res.status(409).json({ error: 'El WhatsApp del vendedor no está conectado' });
            const c = await prisma.promoCampaign.findFirst({ where: { id: req.params.id, instanceId } });
            if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
            if (c.status !== 'running') return res.status(409).json({ error: 'La campaña tiene que estar corriendo' });
            const result = await promoTick(inst.sharedState, {
                sendMessageWithDelay: inst.helpers.sendMessageWithDelay,
                saveState: inst.stateManager.saveState.bind(inst.stateManager),
                notifyAdmin: inst.helpers.notifyAdmin,
                client: inst.client,
            }, { force: true });
            res.json(result);
        } catch (e) {
            logger.error('[PROMO] send-now:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /promo/image — el flyer que se adjunta a la promo (para la vista previa del panel).
    router.get('/promo/image', ...withSeller(clientPool), (req, res) => {
        const media = loadPromoImage();
        if (!media) return res.status(404).json({ error: 'No hay imagen de la promo' });
        res.setHeader('Content-Type', media.mimetype);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(Buffer.from(media.data, 'base64'));
    });

    return router;
};
