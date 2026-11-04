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
const { createCampaignSchema, updateCampaignSchema, previewSchema } = require('../../schemas/promo.schema');
const { normalizeAudienceFilters } = require('../../services/promo/promoAudience');
const { selectChatAudience } = require('../../services/promo/chatAudience');
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

    // Club Herbys: la audiencia sale de los chats del WhatsApp (chatAudience.ts).
    // El resumen se devuelve con la forma que ya espera el panel.
    // areaCodes (nov-2026): limita la lista a esas características argentinas
    // (549 + característica + número), p. ej. Rosario y zona para la oferta de Club Herbys.
    async function chatAudience(req, instanceId, fresh, areaCodes = []) {
        const client = req.sellerInstance?.client;
        const { members: all, summary } = await selectChatAudience({ client, instanceId, excludePhones: adminPhones(req), fresh });
        const codes = (areaCodes || []).map((c) => String(c).replace(/\D/g, '')).filter(Boolean);
        const members = codes.length ? all.filter((m) => codes.some((c) => m.phone.startsWith(`549${c}`))) : all;
        return {
            members,
            summary: {
                total: members.length,
                chats: summary.chats,
                byMonth: summary.byMonth,
                byStep: {},
                excluded: { ya_compraron: summary.buyers, sin_telefono_visible: summary.unresolved, avisos_o_propio: summary.excluded, pidio_no_recibir: summary.optedOut, fuera_de_zona: all.length - members.length },
                ...(codes.length ? { areaCodes: codes } : {}),
            },
        };
    }
    const _areaCodesFromQuery = (q) => String(q || '').split(',').map((s) => s.trim()).filter((s) => /^\d{2,4}$/.test(s));

    const serialize = (c) => ({ ...c, config: (() => { try { return JSON.parse(c.config); } catch { return {}; } })() });

    // GET /promo/audience
    router.get('/promo/audience', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const filters = normalizeAudienceFilters(instanceId, { ...req.query, excludePhones: adminPhones(req) });
            const { members, summary } = await chatAudience(req, instanceId, req.query.fresh === '1', _areaCodesFromQuery(req.query.areaCodes));
            res.json({ filters, summary, sample: members.slice(0, 10).map(m => ({ phone: m.phone, name: m.name, step: null, lastSeen: m.lastChatAt ? new Date(m.lastChatAt * 1000) : null })) });
        } catch (e) {
            logger.error(`[PROMO] audience: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /promo/preview — muestras del texto. En modo 'ai' le pide a Claude
    // `count` reescrituras del mensaje base (cada una cuesta una llamada al
    // modelo simple); en modo 'templates', variantes de las plantillas.
    router.post('/promo/preview', ...withSeller(clientPool), validate(previewSchema), async (req, res) => {
        try {
            const price = _getPromoPrice60('Gotas') || '';
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
            const { members, summary } = await chatAudience(req, instanceId, true, req.body.areaCodes || []);
            if (members.length === 0) return res.status(400).json({ error: 'Con estos filtros no queda nadie a quien mandarle', summary });

            const campaign = await prisma.promoCampaign.create({
                data: { instanceId, name: req.body.name.trim(), status: 'draft', config: JSON.stringify(req.body.areaCodes?.length ? { ...cfg, areaCodes: req.body.areaCodes } : cfg) },
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
            logger.error(`[PROMO] create: ${e.message}`);
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

    // PATCH /promo/campaigns/:id — edita nombre y configuración de una campaña
    // (también corriendo: el próximo envío ya usa los valores nuevos). La
    // audiencia no cambia: la lista se congeló al crearla.
    router.patch('/promo/campaigns/:id', ...withSeller(clientPool), validate(updateCampaignSchema), async (req, res) => {
        try {
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const c = await prisma.promoCampaign.findFirst({ where: { id: req.params.id, instanceId } });
            if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
            if (['finished', 'cancelled'].includes(c.status)) return res.status(409).json({ error: 'La campaña ya terminó' });
            const current = JSON.parse(c.config || '{}');
            const merged = normalizePromoConfig({ ...current, ...(req.body.config || {}), audience: current.audience }, instanceId);
            const data = { config: JSON.stringify(merged) };
            if (req.body.name) data.name = req.body.name.trim();
            const updated = await prisma.promoCampaign.update({ where: { id: c.id }, data });
            logger.info(`[PROMO][${instanceId}] Campaña "${updated.name}" editada (${Object.keys(req.body.config || {}).join(', ') || 'sin cambios de config'})`);
            res.json({ campaign: { ...serialize(updated), stats: await campaignStats(updated) } });
        } catch (e) {
            logger.error('[PROMO] update:', e);
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
    // GET /promo/responses?campaignId=&all=1 — quiénes respondieron a la promo y en qué
    // quedó cada uno (lo que dice el estado de la conversación, flows/clubHerbys.ts).
    // Por defecto solo los interesados: aceptaron o pidieron una asesora/consulta.
    router.get('/promo/responses', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const where = { instanceId, repliedAt: { not: null } };
            if (req.query.campaignId) where.campaignId = String(req.query.campaignId);
            const rows = await prisma.promoRecipient.findMany({
                where, orderBy: { repliedAt: 'desc' }, take: 500,
                select: { phone: true, campaignId: true, sentAt: true, repliedAt: true, outcome: true, campaign: { select: { name: true } } },
            });
            const userState = req.sellerInstance?.sharedState?.userState || {};
            const client = req.sellerInstance?.client;
            const OUTCOME = {
                accepted: 'Aceptó', handed_off: 'Pidió asesora / consulta', declined: 'No le interesa', opted_out: 'Pidió la baja',
            };
            const out = [];
            for (const r of rows) {
                const st = userState[`${r.phone}@c.us`];
                const key = st?.promo?.outcome || (r.outcome === 'opted_out' ? 'opted_out' : r.outcome === 'declined' ? 'declined' : r.outcome === 'interested' ? 'accepted' : null);
                const interested = key === 'accepted' || key === 'handed_off';
                if (!interested && req.query.all !== '1') continue;
                const last = await prisma.chatLog.findFirst({
                    where: { instanceId, userPhone: r.phone, role: 'user' }, orderBy: { timestamp: 'desc' }, select: { content: true, timestamp: true },
                });
                let name = st?.userName || st?.partialAddress?.nombre || null;
                if (!name && client?.getContactById) {
                    try {
                        const ct = await Promise.race([client.getContactById(`${r.phone}@c.us`), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
                        name = ct?.name || ct?.pushname || null;
                    } catch { /* sin nombre */ }
                }
                out.push({
                    phone: r.phone, name, campaign: r.campaign?.name || '', sentAt: r.sentAt, repliedAt: r.repliedAt,
                    status: key || 'talking', statusLabel: key ? OUTCOME[key] : 'Charlando con el bot', interested,
                    lastMessage: last ? String(last.content || '').replace(/^MEDIA_AUDIO:[^|]*\|TRANSCRIPTION:/, '🎤 ').slice(0, 200) : null,
                    lastMessageAt: last?.timestamp || null,
                });
            }
            res.json({ responses: out });
        } catch (e) {
            logger.error(`[PROMO] responses: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /promo/ad-stats?days=30 — contactos por anuncio de Meta (y personas nuevas
    // sin anuncio) y cuántos terminaron en pedido. Ver services/adStats.ts.
    router.get('/promo/ad-stats', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
            const { getAdStats } = require('../../services/adStats');
            res.json({ days, ads: await getAdStats(instanceId, days) });
        } catch (e) {
            logger.error(`[PROMO] ad-stats: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /promo/ad-backfill?days=7 — solo admin: anota en AdLead los anuncios que
    // el agente todavía ve en la caché de WA Web (parcial: solo los chats cuyo
    // primer mensaje está cargado). Idempotente.
    router.post('/promo/ad-backfill', ...withSeller(clientPool), async (req, res) => {
        try {
            if (req.account?.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
            const instanceId = needSeller(req, res); if (!instanceId) return;
            const client = req.sellerInstance?.client;
            if (!client || typeof client.scanInbound !== 'function') return res.status(400).json({ error: 'El WhatsApp de este vendedor no está conectado' });
            const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
            const chats = await client.scanInbound(Math.floor(Date.now() / 1000) - days * 86400);
            let added = 0;
            for (const c of chats) {
                if (!c.ad?.sourceId || !c.phone) continue;
                const firstAt = new Date(((c.first && c.first.t) || c.t) * 1000);
                const r = await prisma.adLead.upsert({
                    where: { instanceId_phone_sourceId: { instanceId, phone: String(c.phone), sourceId: String(c.ad.sourceId) } },
                    create: { instanceId, phone: String(c.phone), sourceId: String(c.ad.sourceId), title: c.ad.title || null, mediaType: typeof c.ad.mediaType === 'number' ? c.ad.mediaType : null, firstAt, lastAt: firstAt },
                    update: {},
                });
                if (r && r.firstAt.getTime() === firstAt.getTime()) added++;
            }
            res.json({ scanned: chats.length, withAd: chats.filter((c) => c.ad?.sourceId).length, added });
        } catch (e) {
            logger.error(`[PROMO] ad-backfill: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /promo/inbound-scan?days=3 — diagnóstico (solo admin): chats con actividad
    // reciente, su primer mensaje y, si llegaron por un anuncio de Meta, la ficha del
    // anuncio (ctwaContext). Sirve para separar los leads de cada anuncio. No envía nada.
    router.get('/promo/inbound-scan', ...withSeller(clientPool), async (req, res) => {
        try {
            if (req.account?.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
            const client = req.sellerInstance?.client;
            if (!client || typeof client.scanInbound !== 'function') return res.status(400).json({ error: 'El WhatsApp de este vendedor no está conectado (o no es remoto)' });
            const days = Math.min(30, Math.max(1, Number(req.query.days) || 3));
            const chats = await client.scanInbound(Math.floor(Date.now() / 1000) - days * 86400);
            res.json({ days, chats });
        } catch (e) {
            logger.error(`[PROMO] inbound-scan: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /promo/probe-history { phones: [...] } — diagnóstico (solo admin): para
    // cada teléfono (hasta 5 por llamada) abre el chat en WA Web y le pide al
    // teléfono el historial viejo, para ver si hubo charla antes de julio. No envía nada.
    router.post('/promo/probe-history', ...withSeller(clientPool), async (req, res) => {
        try {
            if (req.account?.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
            const client = req.sellerInstance?.client;
            if (!client || typeof client.probeHistory !== 'function') return res.status(400).json({ error: 'El WhatsApp de este vendedor no está conectado (o no es remoto)' });
            const phones = (Array.isArray(req.body?.phones) ? req.body.phones : []).map((p) => String(p).replace(/\D/g, '')).filter(Boolean).slice(0, 5);
            const results = [];
            for (const phone of phones) {
                try { results.push(await client.probeHistory(phone, Number(req.body?.waitMs) || 8000)); }
                catch (e) { results.push({ phone, error: e.message }); }
            }
            res.json({ results });
        } catch (e) {
            logger.error(`[PROMO] probe-history: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/promo/image',...withSeller(clientPool), (req, res) => {
        const media = loadPromoImage();
        if (!media) return res.status(404).json({ error: 'No hay imagen de la promo' });
        res.setHeader('Content-Type', media.mimetype);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(Buffer.from(media.data, 'base64'));
    });

    return router;
};
