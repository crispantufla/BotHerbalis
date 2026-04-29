/**
 * apiTokens.routes.js
 * CRUD for API tokens (admin only).
 * Plaintext tokens are returned ONLY at creation time.
 */
const express = require('express');
const { jwtAuthMiddleware, requireAdmin } = require('../../middleware/jwtAuth');
const { generateRawToken } = require('../../middleware/apiTokenAuth');
const { prisma } = require('../../../db');
const logger = require('../../utils/logger');

const ALLOWED_SCOPES = ['analytics:read'];

module.exports = () => {
    const router = express.Router();

    // GET /admin/api-tokens — list (no plaintext)
    router.get('/admin/api-tokens', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        try {
            const tokens = await prisma.apiToken.findMany({
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true, name: true, prefix: true, scopes: true,
                    createdAt: true, lastUsedAt: true, revokedAt: true,
                },
            });
            res.json(tokens.map(t => ({
                ...t,
                scopes: t.scopes.split(',').map(s => s.trim()).filter(Boolean),
            })));
        } catch (e) {
            logger.error(`[API-TOKEN] list error: ${e.message}`);
            res.status(500).json({ error: 'Failed to list tokens' });
        }
    });

    // POST /admin/api-tokens — create. Returns plaintext ONCE.
    router.post('/admin/api-tokens', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        try {
            const { name, scopes } = req.body || {};
            if (!name || typeof name !== 'string' || name.trim().length < 3) {
                return res.status(400).json({ error: 'name (min 3 chars) required' });
            }
            const reqScopes = Array.isArray(scopes) ? scopes : ['analytics:read'];
            const invalid = reqScopes.filter(s => !ALLOWED_SCOPES.includes(s));
            if (invalid.length > 0) {
                return res.status(400).json({ error: `Invalid scopes: ${invalid.join(',')}` });
            }

            const { raw, prefix, hash } = generateRawToken();
            const created = await prisma.apiToken.create({
                data: {
                    name: name.trim(),
                    tokenHash: hash,
                    prefix,
                    scopes: reqScopes.join(','),
                    createdById: req.account.id,
                },
                select: { id: true, name: true, prefix: true, scopes: true, createdAt: true },
            });
            logger.info(`[API-TOKEN] Created token "${created.name}" (${prefix}) by ${req.account.name}`);
            // Plaintext is returned ONCE here. Frontend must show + copy.
            res.json({
                ...created,
                scopes: created.scopes.split(',').map(s => s.trim()),
                token: raw,
            });
        } catch (e) {
            logger.error(`[API-TOKEN] create error: ${e.message}`);
            res.status(500).json({ error: 'Failed to create token' });
        }
    });

    // DELETE /admin/api-tokens/:id — soft-revoke (sets revokedAt)
    router.delete('/admin/api-tokens/:id', jwtAuthMiddleware, requireAdmin, async (req, res) => {
        try {
            const token = await prisma.apiToken.findUnique({ where: { id: req.params.id } });
            if (!token) return res.status(404).json({ error: 'Not found' });
            if (token.revokedAt) return res.json({ success: true, alreadyRevoked: true });
            await prisma.apiToken.update({
                where: { id: req.params.id },
                data: { revokedAt: new Date() },
            });
            logger.info(`[API-TOKEN] Revoked "${token.name}" (${token.prefix}) by ${req.account.name}`);
            res.json({ success: true });
        } catch (e) {
            logger.error(`[API-TOKEN] revoke error: ${e.message}`);
            res.status(500).json({ error: 'Failed to revoke token' });
        }
    });

    return router;
};
