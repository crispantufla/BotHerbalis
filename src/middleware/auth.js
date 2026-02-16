const API_KEY = process.env.API_KEY || 'herbalis_secret_key_123';

const authMiddleware = (req, res, next) => {
    // Allow public routes (if any need to be public)
    if (req.path === '/health') return next();

    const apiKey = req.headers['x-api-key'];

    if (!apiKey || apiKey !== API_KEY) {
        // Log unauthorized access attempt
        console.warn(`[AUTH] Unauthorized access attempt from ${req.ip} to ${req.path}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    next();
};

module.exports = { authMiddleware };
