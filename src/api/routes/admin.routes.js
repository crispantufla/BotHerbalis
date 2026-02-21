const express = require('express');
const { authMiddleware } = require('../../middleware/auth');

module.exports = (client, sharedState) => {
    const router = express.Router();
    const { config, knowledge, pausedUsers, saveState, saveKnowledge, io } = sharedState;

    // POST /admin-command
    router.post('/admin-command', authMiddleware, async (req, res) => {
        const { chatId, command } = req.body;
        try {
            if (sharedState.handleAdminCommand) {
                const result = await sharedState.handleAdminCommand(chatId, command, true);
                res.json({ success: true, message: result });
            } else {
                res.status(501).json({ error: "Handler not attached" });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /toggle-bot
    router.post('/toggle-bot', authMiddleware, async (req, res) => {
        const { chatId, paused } = req.body;
        if (paused) {
            pausedUsers.add(chatId);
        } else {
            pausedUsers.delete(chatId);
        }
        saveState();
        if (io) io.emit('bot_status_change', { chatId, paused });
        res.json({ success: true, paused });
    });

    // GET /script
    router.get('/script', (req, res) => res.json(knowledge));

    // POST /script
    router.post('/script', authMiddleware, (req, res) => {
        try {
            const { version } = req.body;
            const targetVersion = version || config.activeScript || 'v3';

            if (sharedState.multiKnowledge && sharedState.multiKnowledge[targetVersion]) {
                // Update specific version in memory
                Object.assign(sharedState.multiKnowledge[targetVersion], req.body);
                // Also update legacy reference if it's the active one (though knowledge is a getter in sharedState now, its local copy here might be stale)
                // Actually knowledge is extracted from sharedState at the top of the function module.exports
                // Let's just use saveKnowledge(targetVersion) which index.js handles
                saveKnowledge(targetVersion);
                res.json({ success: true, message: `Script ${targetVersion} updated successfully` });
            } else {
                // Fallback for unexpected states
                Object.assign(knowledge, req.body);
                saveKnowledge();
                res.json({ success: true, message: "Script updated successfully (fallback)" });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /config
    router.post('/config', authMiddleware, async (req, res) => {
        const { alertNumber, action, number } = req.body;

        if (action && number) {
            if (!config.alertNumbers) config.alertNumbers = [];
            const cleanNum = number.replace(/\D/g, '');

            if (action === 'add') {
                if (!config.alertNumbers.includes(cleanNum)) {
                    config.alertNumbers.push(cleanNum);
                    try {
                        const target = `${cleanNum}@c.us`;
                        await client.sendMessage(target, '✅ *HERBALIS BOT*\n\nEste número fue registrado como *administrador*.\n\nRecibiras alertas de:\n• 🛒 Nuevos pedidos\n• ⚠️ Intervenciones requeridas\n• 🔧 Errores del sistema\n\n_Podés ser removido desde el panel de control._');
                    } catch (e) {
                        console.error(`[CONFIG] Failed to send welcome to ${cleanNum}:`, e.message);
                    }
                }
            } else if (action === 'remove') {
                config.alertNumbers = config.alertNumbers.filter(n => n !== cleanNum);
                try {
                    const target = `${cleanNum}@c.us`;
                    await client.sendMessage(target, '🔕 *HERBALIS BOT*\n\nEste número fue *removido* de la lista de administradores.\n\nYa no recibirás alertas del sistema.\n\n_Si fue un error, podés ser agregado nuevamente desde el panel de control._');
                } catch (e) {
                    console.error(`[CONFIG] Failed to send removal notice to ${cleanNum}:`, e.message);
                }
            }

            saveState();
            return res.json({ success: true, config });
        }

        if (alertNumber !== undefined) {
            if (!config.alertNumbers) config.alertNumbers = [];
            const newNum = alertNumber ? alertNumber.replace(/\D/g, '') : null;
            if (newNum && !config.alertNumbers.includes(newNum)) {
                config.alertNumbers.push(newNum);
            }
            saveState();
            return res.json({ success: true, config });
        }

        res.status(400).json({ error: "Missing action/number or alertNumber" });
    });

    return router;
};
