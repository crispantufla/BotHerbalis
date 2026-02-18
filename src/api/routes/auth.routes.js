const express = require('express');
const crypto = require('crypto');

// Generate a random session token at startup (not hardcoded)
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

module.exports = (client, sharedState) => {
    const router = express.Router();

    router.post('/login', (req, res) => {
        const { username, password } = req.body;

        // Check against environment variables or default to 'admin'/'admin' if not set
        const validUser = process.env.ADMIN_USER || 'admin';
        const validPass = process.env.ADMIN_PASSWORD || 'admin';

        if (username === validUser && password === validPass) {
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
