const API_KEY = process.env.API_KEY || 'herbalis_secret_key_123';

const authMiddleware = (req, res, next) => {
    // Allow public routes (if any need to be public)
    if (req.path === '/health') return next();

    const apiKey = req.headers['x-api-key'];

    // ALLOW BOTH: The one in env (if set) OR the default hardcoded one (used by frontend build)
    const validKeys = [API_KEY, 'herbalis_secret_key_123'];

    if (!apiKey || !validKeys.includes(apiKey)) {
        // Log unauthorized access attempt
        console.warn(`[AUTH] Unauthorized access attempt from ${req.ip} to ${req.path} | Key: ${apiKey}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    next();
};

module.exports = { authMiddleware };
