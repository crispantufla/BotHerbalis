const express = require('express');
const crypto = require('crypto');

// Generate a random session token at startup (not hardcoded)
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

module.exports = (client, sharedState) => {
    const router = express.Router();

    router.post('/login', (req, res) => {
        const { username, password } = req.body;

        if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
            return res.status(503).json({ error: 'Credenciales de admin no configuradas en el servidor' });
        }
        const validUser = process.env.ADMIN_USER;
        const validPass = process.env.ADMIN_PASSWORD;

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
