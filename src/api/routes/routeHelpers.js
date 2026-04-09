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
 * Returns null when admin has no seller selected (= "all sellers" view).
 */
function getInstanceId(req) {
    return req.sellerId || null;
}

/**
 * isOwnerOrAdmin — ownership check for write operations.
 * Admins can operate on any record; sellers only on their own.
 */
function isOwnerOrAdmin(req, recordInstanceId) {
    if (req.account?.role === 'admin') return true;
    return recordInstanceId === getInstanceId(req);
}

module.exports = { withSeller, requireSellerInstance, getInstanceId, isOwnerOrAdmin };
