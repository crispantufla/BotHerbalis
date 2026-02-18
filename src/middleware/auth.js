const API_KEY = process.env.API_KEY;

if (!API_KEY) {
    console.warn('[AUTH] WARNING: API_KEY env var is not set! API will reject all requests.');
}

const authMiddleware = (req, res, next) => {
    // Allow public routes
    if (req.path === '/health') return next();

    const apiKey = req.headers['x-api-key'];

    if (!API_KEY || !apiKey || apiKey !== API_KEY) {
        console.warn(`[AUTH] Unauthorized access attempt from ${req.ip} to ${req.path}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    next();
};

module.exports = { authMiddleware };
