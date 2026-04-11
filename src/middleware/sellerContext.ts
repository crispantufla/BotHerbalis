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
            // Any admin can switch between sellers via query param or header.
            // Semantics of the sellerId value when provided by the client:
            //   - "ines" / "horacio" / …  → act as that specific seller
            //   - "" (empty string)       → aggregated view across ALL sellers
            //     (used by Analytics/Sales/Payments/Orders for admin-wide reports)
            //   - header/query absent     → fall back to the admin's HOME seller
            //     (their own `account.sellerId`), or null if they are a
            //     "pure" global admin with no home.
            const rawQuery = req.query.sellerId;
            const rawHeader = req.headers['x-seller-id'];
            const hasExplicitValue = rawQuery !== undefined || rawHeader !== undefined;
            const raw = rawQuery !== undefined ? rawQuery : rawHeader;

            if (hasExplicitValue) {
                // Empty string → aggregated view (null). Non-empty → that seller.
                req.sellerId = raw && String(raw).trim() !== '' ? String(raw).toLowerCase() : null;
            } else {
                // No explicit value → default to admin's home seller.
                req.sellerId = req.account.sellerId || null;
            }
        } else {
            // Regular seller: locked to their own sellerId, no override.
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
