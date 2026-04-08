/**
 * routeHelpers.js
 * Shared middleware chain for multi-tenant API routes.
 */

const { jwtAuthMiddleware } = require('../../middleware/jwtAuth');
const { sellerContext } = require('../../middleware/sellerContext');

/**
 * Returns [jwtAuthMiddleware, sellerContext(pool)] to apply on routes.
 * Sellers are locked to their own sellerId; admins can pass ?sellerId=xxx.
 */
function withSeller(clientPool) {
    return [jwtAuthMiddleware, sellerContext(clientPool)];
}

/**
 * requireSellerInstance — fails if seller instance not running.
 * Use for operations that need a live WhatsApp client.
 */
function requireSellerInstance(req, res, next) {
    if (!req.sellerInstance) {
        const msg = req.sellerId
            ? `Seller "${req.sellerId}" no está activo en este momento`
            : 'No se especificó un seller';
        return res.status(404).json({ error: msg });
    }
    next();
}

/**
 * resolveInstanceId — returns sellerId for DB queries.
 * Falls back to env INSTANCE_ID for backward compat.
 */
function getInstanceId(req) {
    return req.sellerId || process.env.INSTANCE_ID || 'default';
}

module.exports = { withSeller, requireSellerInstance, getInstanceId };
