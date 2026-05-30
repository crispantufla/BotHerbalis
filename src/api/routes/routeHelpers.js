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

// instanceIds reservados que NO representan a un seller real. Cualquier query
// de Orders/User para dashboard, analítica o logística debería excluirlos
// para que no contaminen métricas ni listados.
//   __legacy_import__ — clientes históricos argentinos importados desde
//     Clientes_AR.txt (2026-05-30). Existen solo para que salesFlow detecte
//     re-entry y pause el bot — no son pedidos reales.
const NON_SELLER_INSTANCE_IDS = ['__legacy_import__'];

/**
 * applyNonSellerExclusion — agrega `instanceId: { notIn: NON_SELLER_INSTANCE_IDS }`
 * a un `where` de Prisma cuando NO se está filtrando por un seller específico.
 * Si el `where` ya tiene `instanceId` (filtro de seller activo), no toca nada.
 */
function applyNonSellerExclusion(where) {
    if (!where || where.instanceId !== undefined) return where || {};
    return { ...where, instanceId: { notIn: NON_SELLER_INSTANCE_IDS } };
}

module.exports = {
    withSeller, requireSellerInstance, getInstanceId, isOwnerOrAdmin,
    NON_SELLER_INSTANCE_IDS, applyNonSellerExclusion,
};
