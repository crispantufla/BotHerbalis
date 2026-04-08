/**
 * sellerContext.ts
 * Resolves the effective sellerId for each API request.
 * - Sellers: locked to their own sellerId
 * - Admins: can specify ?sellerId=xxx or x-seller-id header to act as that seller
 * Must run AFTER jwtAuthMiddleware.
 */

const logger = require('../utils/logger');

export function sellerContext(clientPool: any) {
    return (req: any, res: any, next: any) => {
        if (!req.account) {
            // Should not happen if jwtAuthMiddleware is used — belt and suspenders
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (req.account.role === 'admin') {
            // Admins can switch between sellers via query param or header
            const sellerId = req.query.sellerId || req.headers['x-seller-id'] || null;
            req.sellerId = sellerId;
        } else {
            // Sellers are locked to their own sellerId
            req.sellerId = req.account.sellerId;
        }

        // Resolve the seller instance from the pool
        if (req.sellerId) {
            req.sellerInstance = clientPool.getSeller(req.sellerId);
            if (!req.sellerInstance) {
                // Seller exists in DB but client not yet started — that's OK for read-only routes
                logger.debug(`[SELLER-CTX] Seller ${req.sellerId} not running in pool`);
            }
        }

        next();
    };
}
