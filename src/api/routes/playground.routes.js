/**
 * playground.routes.js — Sandbox de prueba del bot desde el dashboard.
 *
 * Permite a admins/sellers chatear con la lógica REAL del bot (processSalesFlow,
 * handlers, aiService) sin tocar WhatsApp ni contaminar analytics. El state vive
 * en memoria y se descarta al hora si no hay actividad.
 *
 * Aislamiento:
 *   - sellerId='playground' → funnelLogger skipea (guard en cada función)
 *   - saveState/notifyAdmin/logAndEmit son no-op en deps
 *   - sendMessageWithDelay captura mensajes en un array (no manda a WhatsApp)
 *   - Queries de Order/ChatLog usan instanceId='playground' → 0 rows
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const logger = require('../../utils/logger');
const { processSalesFlow } = require('../../flows/salesFlow');
const { jwtAuthMiddleware } = require('../../middleware/jwtAuth');

const KNOWLEDGE_FILE = path.join(__dirname, '../../..', 'knowledge_v7.json');
let _knowledgeCache = null;

function _loadKnowledge() {
    try {
        const stat = fs.statSync(KNOWLEDGE_FILE);
        if (_knowledgeCache && _knowledgeCache.mtime === stat.mtimeMs) return _knowledgeCache.data;
        const data = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
        _knowledgeCache = { mtime: stat.mtimeMs, data };
        return data;
    } catch (e) {
        logger.error(`[PLAYGROUND] Failed to load knowledge_v7.json: ${e.message}`);
        return null;
    }
}

// Sesiones efímeras en memoria — Map<sessionId, { userState, lastActivity }>.
// Se limpian automáticamente las que llevan más de 1 hora sin actividad.
const sessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hora
setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of sessions) {
        if (s.lastActivity < cutoff) sessions.delete(id);
    }
}, 10 * 60 * 1000).unref(); // cada 10 min, sin bloquear shutdown

function _getOrCreateSession(sessionId) {
    let session = sessions.get(sessionId);
    if (!session) {
        session = { userState: {}, lastActivity: Date.now() };
        sessions.set(sessionId, session);
    } else {
        session.lastActivity = Date.now();
    }
    return session;
}

function _buildDependencies(replies, useDelay) {
    // aiService real — el playground usa la misma IA que producción.
    const { aiService } = require('../../services/ai');

    return {
        saveState: () => {},
        sendMessageWithDelay: async (_uid, msg) => {
            if (useDelay) {
                // Delay humanizado igual que el bot real (4-8s).
                const delay = 4000 + Math.random() * 4000;
                await new Promise(r => setTimeout(r, delay));
            }
            replies.push({ role: 'bot', content: msg, timestamp: Date.now() });
        },
        notifyAdmin: async () => {},
        aiService,
        logAndEmit: () => {},
        saveOrderToLocal: () => {},
        cancelLatestOrder: async () => null,
        sharedState: {
            io: { to: () => ({ emit: () => {} }), emit: () => {} },
            pausedUsers: new Set(),
            config: { activeScript: 'v7' },
            sellerId: 'playground',
            sessionAlerts: [],
        },
        config: { activeScript: 'v7', scriptStats: {} },
        effectiveScript: 'v7',
        sellerId: 'playground',
        client: { sendMessage: async () => {} },
    };
}

module.exports = () => {
    const router = express.Router();

    // POST /playground/message — procesa un mensaje del usuario y devuelve las
    // respuestas del bot + el state actualizado.
    // body: { sessionId, message, useDelay }
    router.post('/playground/message', jwtAuthMiddleware, async (req, res) => {
        const { sessionId, message, useDelay = false } = req.body || {};
        if (!sessionId || !message) {
            return res.status(400).json({ error: 'sessionId y message son requeridos' });
        }

        const knowledge = _loadKnowledge();
        if (!knowledge) return res.status(500).json({ error: 'No se pudo cargar knowledge_v7.json' });

        const session = _getOrCreateSession(sessionId);
        const userId = `playground_${sessionId}`;
        const replies = [];

        // Empuja el mensaje del usuario al history que vivirá en session.userState[userId].
        // processSalesFlow inicializa el state si no existe — pero queremos persistir history
        // entre llamadas, así que si ya hay state, le agregamos el mensaje del user antes.
        if (session.userState[userId]) {
            session.userState[userId].history = session.userState[userId].history || [];
            session.userState[userId].history.push({
                role: 'user', content: message, timestamp: Date.now()
            });
        }

        const deps = _buildDependencies(replies, !!useDelay);

        try {
            await processSalesFlow(userId, message, session.userState, knowledge, deps);
        } catch (e) {
            logger.error(`[PLAYGROUND] processSalesFlow error: ${e.message}`);
            return res.status(500).json({ error: e.message, replies });
        }

        res.json({
            replies,
            state: session.userState[userId] || null,
        });
    });

    // POST /playground/reset — borra la sesión.
    router.post('/playground/reset', jwtAuthMiddleware, async (req, res) => {
        const { sessionId } = req.body || {};
        if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
        sessions.delete(sessionId);
        res.json({ ok: true });
    });

    // POST /playground/force-step — setea step específico (con state mínimo si la sesión es nueva).
    router.post('/playground/force-step', jwtAuthMiddleware, async (req, res) => {
        const { sessionId, step } = req.body || {};
        if (!sessionId || !step) return res.status(400).json({ error: 'sessionId y step requeridos' });

        const session = _getOrCreateSession(sessionId);
        const userId = `playground_${sessionId}`;

        if (!session.userState[userId]) {
            session.userState[userId] = {
                step,
                history: [],
                cart: [],
                summary: '',
                partialAddress: {},
                selectedProduct: null,
                selectedPlan: null,
                geoRejected: false,
                stepEnteredAt: Date.now(),
                addressAttempts: 0,
                fieldReaskCount: {},
                lastAddressMsg: null,
                postdatado: null,
                pendingOrder: null,
                lastActivityAt: Date.now(),
                assignedScript: 'v7',
            };
        } else {
            session.userState[userId].step = step;
            session.userState[userId].stepEnteredAt = Date.now();
        }

        res.json({ ok: true, state: session.userState[userId] });
    });

    // GET /playground/state — devuelve state actual (para refresh del panel lateral).
    router.get('/playground/state', jwtAuthMiddleware, async (req, res) => {
        const { sessionId } = req.query;
        if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
        const session = sessions.get(sessionId);
        const userId = `playground_${sessionId}`;
        res.json({ state: session?.userState?.[userId] || null });
    });

    // POST /playground/new-session — devuelve un sessionId fresco generado server-side.
    // El frontend lo puede pedir al cargar la vista.
    router.post('/playground/new-session', jwtAuthMiddleware, async (req, res) => {
        const sessionId = randomUUID();
        _getOrCreateSession(sessionId);
        res.json({ sessionId });
    });

    return router;
};
