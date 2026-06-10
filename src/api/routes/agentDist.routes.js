const logger = require('../../utils/logger');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * /agent-dist — Distribución del agente remoto (agent/) a la PC del vendedor.
 *
 * El repo entero se deploya al container, así que los archivos del agente están
 * en disco. El instalador los baja en la instalación inicial y agent/updater.js
 * los compara por sha256 en cada arranque (y ante un push {t:'update'}).
 *
 * Auth propia (NO JWT): headers x-seller-id + x-agent-token, mismo criterio que
 * el gateway WSS (agentBridge._validToken) — WA_AGENT_TOKEN_<SELLER> con
 * fallback WA_AGENT_TOKEN; sin env var configurada se rechaza.
 */

const AGENT_DIR = path.join(__dirname, '../../../agent');
// Whitelist exacta de lo distribuible. config.json queda FUERA a propósito:
// contiene secretos por máquina y no está en git/container.
const FILES = ['agent.js', 'sidebar.js', 'updater.js', 'package.json', 'package-lock.json', 'run.bat'];

let manifestCache = null; // el container es inmutable → se calcula una vez

function buildManifest() {
    if (manifestCache) return manifestCache;
    const files = {};
    for (const name of FILES) {
        // Si falta un archivo → throw → 500 ruidoso (correcto: el build está roto).
        files[name] = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(AGENT_DIR, name)))
            .digest('hex');
    }
    const version = crypto.createHash('sha256')
        .update(FILES.map((n) => `${n}:${files[n]}`).join('|'))
        .digest('hex').slice(0, 12);
    manifestCache = { version, files };
    logger.info(`[AGENT-DIST] Manifest v${version} (${FILES.length} archivos)`);
    return manifestCache;
}

function agentAuth(req, res, next) {
    const sellerId = String(req.headers['x-seller-id'] || '');
    const token = String(req.headers['x-agent-token'] || '');
    if (!sellerId || !token) return res.status(401).json({ error: 'auth requerida' });
    const expected = process.env[`WA_AGENT_TOKEN_${sellerId.toUpperCase()}`] || process.env.WA_AGENT_TOKEN;
    if (!expected || token !== expected) {
        logger.warn(`[AGENT-DIST] Token inválido para ${sellerId}`);
        return res.status(401).json({ error: 'token inválido' });
    }
    next();
}

module.exports = () => {
    const router = express.Router();

    router.get('/manifest', agentAuth, (req, res) => {
        try { res.json(buildManifest()); }
        catch (e) { logger.error('[AGENT-DIST] manifest:', e.message); res.status(500).json({ error: e.message }); }
    });

    router.get('/file/:name', agentAuth, (req, res) => {
        if (!FILES.includes(req.params.name)) return res.status(404).json({ error: 'archivo no distribuible' });
        res.sendFile(path.join(AGENT_DIR, req.params.name));
    });

    return router;
};
