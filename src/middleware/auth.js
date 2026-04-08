const logger = require('../utils/logger');
const { jwtAuthMiddleware } = require('./jwtAuth');

// Re-export the JWT-based middleware as the primary auth middleware.
// This replaces the old API_KEY-only check while maintaining backward compatibility:
// - JWT Bearer tokens (new)
// - x-api-key header (legacy, for existing dashboard/mobile-app during migration)
const authMiddleware = jwtAuthMiddleware;

module.exports = { authMiddleware };
