const express = require('express');
const crypto = require('crypto');

// Generate a random session token at startup (not hardcoded)
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = (client, sharedState) => {
    const router = express.Router();

    router.post('/login', (req, res) => {
        const { username, password } = req.body;

        if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
            return res.status(503).json({ error: 'Credenciales de admin no configuradas en el servidor' });
        }
        const validUser = process.env.ADMIN_USER;
        const validPass = process.env.ADMIN_PASSWORD;

        if (safeCompare(username, validUser) && safeCompare(password, validPass)) {
            return res.json({
                success: true,
                token: SESSION_TOKEN,
                user: { username: validUser, role: 'admin' }
            });
        }

        return res.status(401).json({ error: 'Credenciales inválidas' });
    });

    router.post('/logout', (req, res) => {
        res.json({ success: true });
    });

    return router;
};
