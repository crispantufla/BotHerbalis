const express = require('express');
const { prisma } = require('../../../db');
const logger = require('../../utils/logger');

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller, getInstanceId } = require('./routeHelpers');

    // GET /quick-replies — list own quick replies (scoped by seller)
    router.get('/quick-replies', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = getInstanceId(req);
            const where = instanceId ? { instanceId } : {};
            const replies = await prisma.quickReply.findMany({
                where,
                orderBy: { createdAt: 'asc' },
            });
            res.json({ replies });
        } catch (e) {
            logger.error('[QUICK-REPLIES] Error listing:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /quick-replies — create new quick reply
    router.post('/quick-replies', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = getInstanceId(req);
            const { title, message } = req.body;
            if (!title?.trim() || !message?.trim())
                return res.status(400).json({ error: 'title y message son requeridos' });

            const reply = await prisma.quickReply.create({
                data: {
                    instanceId: instanceId || 'default',
                    title: title.trim(),
                    message: message.trim(),
                },
            });
            res.json({ reply });
        } catch (e) {
            if (e.code === 'P2002') {
                return res.status(409).json({ error: 'Ya existe una respuesta con ese título' });
            }
            logger.error('[QUICK-REPLIES] Error creating:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // PUT /quick-replies/:id — update (ownership check)
    router.put('/quick-replies/:id', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = getInstanceId(req);
            const existing = await prisma.quickReply.findUnique({ where: { id: req.params.id } });
            if (!existing) return res.status(404).json({ error: 'No encontrada' });
            if (instanceId && existing.instanceId !== instanceId)
                return res.status(403).json({ error: 'No autorizado' });

            const { title, message } = req.body;
            if (!title?.trim() || !message?.trim())
                return res.status(400).json({ error: 'title y message son requeridos' });

            const updated = await prisma.quickReply.update({
                where: { id: req.params.id },
                data: { title: title.trim(), message: message.trim() },
            });
            res.json({ reply: updated });
        } catch (e) {
            if (e.code === 'P2002') {
                return res.status(409).json({ error: 'Ya existe una respuesta con ese título' });
            }
            logger.error('[QUICK-REPLIES] Error updating:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE /quick-replies/:id — delete (ownership check)
    router.delete('/quick-replies/:id', ...withSeller(clientPool), async (req, res) => {
        try {
            const instanceId = getInstanceId(req);
            const existing = await prisma.quickReply.findUnique({ where: { id: req.params.id } });
            if (!existing) return res.status(404).json({ error: 'No encontrada' });
            if (instanceId && existing.instanceId !== instanceId)
                return res.status(403).json({ error: 'No autorizado' });

            await prisma.quickReply.delete({ where: { id: req.params.id } });
            res.json({ success: true });
        } catch (e) {
            logger.error('[QUICK-REPLIES] Error deleting:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
