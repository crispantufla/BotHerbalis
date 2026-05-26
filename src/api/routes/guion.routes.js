const express = require('express');
const fs = require('fs');
const path = require('path');
const { prisma } = require('../../../db');
const logger = require('../../utils/logger');

const SCRIPTS_DIR = path.join(__dirname, '../../..');
// v3..v6 fueron archivados (archive/knowledge_v*.json). v7 (Elena, 2 tiers) es
// el único guion activo desde may-2026. El UI muestra/edita V7 exclusivamente.
const AVAILABLE_SCRIPTS = ['v7'];

function _loadScript(name) {
    if (!AVAILABLE_SCRIPTS.includes(name)) return null;
    const filePath = path.join(SCRIPTS_DIR, `knowledge_${name}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        logger.error(`[GUION] Failed to parse knowledge_${name}.json: ${e.message}`);
        return null;
    }
}

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller } = require('./routeHelpers');

    // Helper para emitir eventos a TODOS los sellers + admin (los comentarios
    // son globales, no scoped por seller — todos colaboran en el mismo guión).
    const _broadcastGuionEvent = (req, event, payload) => {
        try {
            const inst = req.sellerInstance;
            const io = inst?.sharedState?.io;
            if (!io) return;
            // Emitir a admin room y a cualquier seller que esté escuchando
            io.to('admin').emit(event, payload);
            // Broadcast también a TODOS los rooms — los sellers están en su propia room
            io.emit(event, payload);
        } catch (e) {
            logger.warn('[GUION] Failed to broadcast event:', e.message);
        }
    };

    // GET /guiones — lista los 4 guiones disponibles con su contenido
    // Acceso: cualquier usuario logueado (sellers + admins).
    router.get('/guiones', ...withSeller(clientPool), async (req, res) => {
        try {
            const guiones = AVAILABLE_SCRIPTS.map(name => {
                const data = _loadScript(name);
                if (!data) return null;
                return {
                    script: name,
                    meta: data.meta,
                    flow: data.flow,
                    faq: data.faq,
                    rules: data.rules,
                };
            }).filter(Boolean);
            res.json({ guiones });
        } catch (e) {
            logger.error('[GUION] Error listing guiones:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /guion-comments?script=v5 — lista comentarios de un guión
    router.get('/guion-comments', ...withSeller(clientPool), async (req, res) => {
        try {
            const script = (req.query.script || '').toString().trim();
            if (!AVAILABLE_SCRIPTS.includes(script)) {
                return res.status(400).json({ error: 'Script inválido' });
            }
            const comments = await prisma.guionComment.findMany({
                where: { script },
                orderBy: { createdAt: 'desc' },
            });
            res.json({ comments });
        } catch (e) {
            logger.error('[GUION] Error listing comments:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /guion-comments/counts — conteo de comentarios pendientes por script
    // Para mostrar badges en cada tab del UI sin tener que cargar todos los
    // comentarios.
    router.get('/guion-comments/counts', ...withSeller(clientPool), async (req, res) => {
        try {
            const rows = await prisma.guionComment.groupBy({
                by: ['script'],
                where: { resolved: false },
                _count: { _all: true },
            });
            const counts = {};
            AVAILABLE_SCRIPTS.forEach(s => { counts[s] = 0; });
            rows.forEach(r => { counts[r.script] = r._count._all; });
            res.json({ counts });
        } catch (e) {
            logger.error('[GUION] Error counting comments:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /guion-comments — crear un comentario nuevo
    router.post('/guion-comments', ...withSeller(clientPool), async (req, res) => {
        try {
            const account = req.account;
            if (!account?.id) return res.status(401).json({ error: 'No autorizado' });

            const { script, sectionPath, type, content, suggestedText } = req.body;
            if (!AVAILABLE_SCRIPTS.includes(script)) {
                return res.status(400).json({ error: 'Script inválido' });
            }
            if (!sectionPath || !content?.trim()) {
                return res.status(400).json({ error: 'sectionPath y content son requeridos' });
            }
            const validTypes = ['note', 'correction', 'question'];
            const t = validTypes.includes(type) ? type : 'note';

            const comment = await prisma.guionComment.create({
                data: {
                    script,
                    sectionPath: sectionPath.trim(),
                    type: t,
                    authorId: account.id,
                    authorName: account.name || 'Usuario',
                    content: content.trim(),
                    suggestedText: (typeof suggestedText === 'string' && suggestedText.trim())
                        ? suggestedText.trim()
                        : null,
                },
            });
            logger.info(`[GUION] ${account.name} comentó en ${script}/${sectionPath}: ${content.substring(0, 80)}`);
            _broadcastGuionEvent(req, 'guion_comment_added', comment);
            res.json({ comment });
        } catch (e) {
            logger.error('[GUION] Error creating comment:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // PATCH /guion-comments/:id — marcar resuelto / desresolver
    // Solo admins o el autor del comentario.
    router.patch('/guion-comments/:id', ...withSeller(clientPool), async (req, res) => {
        try {
            const account = req.account;
            if (!account?.id) return res.status(401).json({ error: 'No autorizado' });

            const existing = await prisma.guionComment.findUnique({ where: { id: req.params.id } });
            if (!existing) return res.status(404).json({ error: 'Comentario no encontrado' });

            const isAdmin = account.role === 'admin';
            const isOwner = existing.authorId === account.id;
            if (!isAdmin && !isOwner) return res.status(403).json({ error: 'No autorizado' });

            const { resolved, content } = req.body;
            const data = {};
            if (typeof resolved === 'boolean') data.resolved = resolved;
            if (typeof content === 'string' && content.trim()) data.content = content.trim();
            if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nada para actualizar' });

            const updated = await prisma.guionComment.update({
                where: { id: req.params.id },
                data,
            });
            _broadcastGuionEvent(req, 'guion_comment_updated', updated);
            res.json({ comment: updated });
        } catch (e) {
            logger.error('[GUION] Error updating comment:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /guion-comments/:id/react — toggle reacción 👍 del usuario actual
    router.post('/guion-comments/:id/react', ...withSeller(clientPool), async (req, res) => {
        try {
            const account = req.account;
            if (!account?.id) return res.status(401).json({ error: 'No autorizado' });

            const { emoji = '👍' } = req.body || {};
            const existing = await prisma.guionComment.findUnique({ where: { id: req.params.id } });
            if (!existing) return res.status(404).json({ error: 'Comentario no encontrado' });

            // reactions es un JSON array de {accountId, name, emoji}.
            // Una reacción del mismo usuario con el mismo emoji se quita (toggle).
            let reactions = [];
            try { reactions = JSON.parse(existing.reactions || '[]'); } catch { reactions = []; }
            const idx = reactions.findIndex(r => r.accountId === account.id && r.emoji === emoji);
            if (idx >= 0) reactions.splice(idx, 1);
            else reactions.push({ accountId: account.id, name: account.name || 'Usuario', emoji });

            const updated = await prisma.guionComment.update({
                where: { id: req.params.id },
                data: { reactions: JSON.stringify(reactions) },
            });
            _broadcastGuionEvent(req, 'guion_comment_updated', updated);
            res.json({ comment: updated });
        } catch (e) {
            logger.error('[GUION] Error toggling reaction:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE /guion-comments/:id — eliminar (autor o admin)
    router.delete('/guion-comments/:id', ...withSeller(clientPool), async (req, res) => {
        try {
            const account = req.account;
            if (!account?.id) return res.status(401).json({ error: 'No autorizado' });

            const existing = await prisma.guionComment.findUnique({ where: { id: req.params.id } });
            if (!existing) return res.status(404).json({ error: 'Comentario no encontrado' });

            const isAdmin = account.role === 'admin';
            const isOwner = existing.authorId === account.id;
            if (!isAdmin && !isOwner) return res.status(403).json({ error: 'No autorizado' });

            await prisma.guionComment.delete({ where: { id: req.params.id } });
            _broadcastGuionEvent(req, 'guion_comment_deleted', { id: req.params.id, script: existing.script });
            res.json({ success: true });
        } catch (e) {
            logger.error('[GUION] Error deleting comment:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
