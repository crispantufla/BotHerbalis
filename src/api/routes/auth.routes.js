const express = require('express');

module.exports = (client, sharedState) => {
    const router = express.Router();

    router.post('/login', (req, res) => {
        const { username, password } = req.body;

        // Simple hardcoded check as requested for local dev
        if (username === 'admin' && password === 'admin') {
            return res.json({
                success: true,
                token: 'mock-admin-token-12345',
                user: { username: 'admin', role: 'admin' }
            });
        }

        return res.status(401).json({ error: 'Credenciales inválidas' });
    });

    router.post('/logout', (req, res) => {
        res.json({ success: true });
    });

    return router;
};
