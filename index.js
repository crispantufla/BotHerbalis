require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { exec } = require('child_process'); // For sound
let knowledge = { flow: {}, faq: [] };
const { logMessage } = require('./logger'); // Import Logger
const { analyzeDailyLogs } = require('./analyze_day'); // Import Analyzer
const { appendOrderToSheet } = require('./sheets_sync');
const fs = require('fs');
const path = require('path');
const STATE_FILE = path.join(__dirname, 'persistence.json');
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge.json');

// Helper: Load knowledge from JSON
function loadKnowledge() {
    try {
        if (fs.existsSync(KNOWLEDGE_FILE)) {
            const raw = fs.readFileSync(KNOWLEDGE_FILE);
            knowledge = JSON.parse(raw);
            console.log('✅ Knowledge loaded from JSON');
        }
    } catch (e) {
        console.error('🔴 Error loading knowledge:', e.message);
    }
}
loadKnowledge();

function saveKnowledge() {
    try {
        fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledge, null, 2));
    } catch (e) {
        console.error('🔴 Error saving knowledge:', e.message);
    }
}

// Helper: Save Order Locally (for Dashboard)
function saveOrderToLocal(order) {
    let orders = [];
    if (fs.existsSync(ORDERS_FILE)) {
        try {
            orders = JSON.parse(fs.readFileSync(ORDERS_FILE));
        } catch (e) { orders = []; }
    }
    // Add ID and Timestamp
    const newOrder = {
        id: Date.now().toString(), // Simple ID
        createdAt: new Date().toISOString(),
        status: 'Pendiente', // Pendiente, Enviado, Entregado, Cancelado
        tracking: '',
        ...order
    };
    orders.push(newOrder);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    if (io) io.emit('new_order', newOrder);
}

// Helper: Log and Emit to Dashboard
function logAndEmit(chatId, sender, text, step) {
    logMessage(chatId, sender, text, step);
    if (io) {
        io.emit('new_log', {
            timestamp: new Date(),
            chatId,
            sender,
            text,
            step
        });
    }
}

// Helper: Get History from Local Logs
function getLocalHistory(chatId) {
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) return [];

    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
    let localMessages = [];

    files.forEach(file => {
        try {
            const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
            const lines = content.split('\n').filter(l => l.trim());
            lines.forEach(line => {
                const log = JSON.parse(line);
                if (log.userId === chatId) {
                    localMessages.push({
                        fromMe: log.role === 'bot' || log.role === 'admin' || log.role === 'system',
                        body: log.content,
                        timestamp: Math.floor(new Date(log.timestamp).getTime() / 1000),
                        type: 'chat',
                        isLocal: true
                    });
                }
            });
        } catch (e) {
            console.error(`Error reading log file ${file}:`, e.message);
        }
    });

    return localMessages;
}


// --- DASHBOARD DEPENDENCIES ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for dev simplicity
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve media files

// API State
let qrCodeData = null; // Store QR for frontend
const sessionAlerts = []; // Store alerts for current session
const summaryCache = new Map(); // Store summaries: chatId -> { text, timestamp }
let isConnected = false; // Connection state
let config = {
    alertNumber: null
};

// Load config if it exists in persistence
function loadConfig() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE);
            const data = JSON.parse(raw);
            if (data.config) {
                config = { ...config, ...data.config };
            }
        }
    } catch (e) {
        console.error('🔴 Error loading config:', e.message);
    }
}
loadConfig();

// API Routes
app.get('/api/status', (req, res) => {
    res.json({
        status: qrCodeData ? 'scan_qr' : (isConnected ? 'ready' : 'initializing'),
        qr: qrCodeData,
        info: isConnected ? client.info : null,
        config: config
    });
});

app.get('/api/alerts', (req, res) => {
    res.json(sessionAlerts);
});

app.get('/api/chats', async (req, res) => {
    try {
        const chats = await client.getChats();
        // Filter groups and augment data with paused state
        const relevantChats = chats.filter(c => !c.isGroup).map(c => ({
            id: c.id._serialized,
            name: c.name || c.id.user,
            unreadCount: c.unreadCount,
            lastMessage: c.lastMessage ? c.lastMessage.body : '',
            timestamp: c.timestamp,
            isPaused: pausedUsers.has(c.id._serialized),
            step: userState[c.id._serialized]?.step || 'new'
        }));
        res.json(relevantChats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/chats/:id/read', async (req, res) => {
    try {
        const chatId = req.params.id;
        const chat = await client.getChatById(chatId);
        await chat.sendSeen();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/history/:id', async (req, res) => {
    try {
        const chatId = req.params.id;
        let messages = [];

        // 1. Try to get from WhatsApp
        try {
            const chat = await client.getChatById(chatId);
            const waMessages = await chat.fetchMessages({ limit: 100 });
            messages = waMessages.map(m => ({
                fromMe: m.fromMe,
                body: m.body,
                timestamp: m.timestamp,
                type: m.type,
                id: m.id._serialized
            }));
        } catch (waErr) {
            console.error(`[HISTORY] WA Fetch Error for ${chatId}:`, waErr.message);
        }

        // 2. Get from Local Logs
        const localMessages = getLocalHistory(chatId);

        // 3. Merge and deduplicate
        // Fuzzy matching: ignore if same body/sender within a 2-second window
        const combined = [...messages];

        localMessages.forEach(lm => {
            const isDuplicate = messages.some(m => {
                const timeDiff = Math.abs(m.timestamp - lm.timestamp);
                const sameRole = m.fromMe === lm.fromMe;

                // Exact body match or media tag/type match
                const bodyMatch = m.body === lm.body ||
                    (lm.body?.startsWith('MEDIA_AUDIO:') && (m.type === 'audio' || m.type === 'ptt')) ||
                    (lm.body?.startsWith('MEDIA_IMAGE:') && (m.type === 'image' || m.type === 'sticker'));

                return sameRole && timeDiff <= 2 && bodyMatch;
            });

            if (!isDuplicate) {
                combined.push(lm);
            }
        });

        // 4. Sort by timestamp
        combined.sort((a, b) => a.timestamp - b.timestamp);

        console.log(`[HISTORY] Returning ${combined.length} messages for ${chatId} (${messages.length} WA, ${combined.length - messages.length} Local)`);
        res.json(combined);
    } catch (e) {
        console.error(`[HISTORY] Global Error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/send', async (req, res) => {
    try {
        const { chatId, message } = req.body;
        await client.sendMessage(chatId, message);
        logMessage(chatId, 'admin', message, 'dashboard_reply');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/toggle-bot', async (req, res) => {
    const { chatId, paused } = req.body;
    if (paused) {
        pausedUsers.add(chatId);
    } else {
        pausedUsers.delete(chatId);
    }
    saveState();
    io.emit('bot_status_change', { chatId, paused });
    res.json({ success: true, paused });
});

app.post('/api/reset-chat', async (req, res) => {
    try {
        const { chatId } = req.body;
        // 1. Clear local bot state
        delete userState[chatId];
        pausedUsers.delete(chatId);
        saveState();

        // 2. Clear WhatsApp chat history (optional but requested)
        const chat = await client.getChatById(chatId);
        await chat.clearMessages();

        io.emit('bot_status_change', { chatId, paused: false });
        res.json({ success: true, message: "Chat reset successfully" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin-command', async (req, res) => {
    const { chatId, command } = req.body;
    try {
        const result = await handleAdminCommand(chatId, command, true);
        res.json({ success: true, message: result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/script', (req, res) => {
    res.json(knowledge);
});

app.post('/api/script', (req, res) => {
    try {
        knowledge = req.body;
        saveKnowledge();
        res.json({ success: true, message: "Script updated successfully" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/config', async (req, res) => {
    const { alertNumber } = req.body;
    if (alertNumber !== undefined) {
        const previousAlertNumber = config.alertNumber;
        const newAlertNumber = alertNumber ? alertNumber.replace(/\D/g, '') : null;

        config.alertNumber = newAlertNumber;
        saveState();

        // If connected...
        if (isConnected) {
            // Case 1: Number removed
            if (previousAlertNumber && !newAlertNumber) {
                const target = `${previousAlertNumber}@c.us`;
                client.sendMessage(target, "⚠️ *Bot desconectado* - Este número ya no recibirá alertas de sistema.").catch(e => {
                    console.error(`[CONFIG] Failed to send disconnect message to ${target}:`, e.message);
                });
            }
            // Case 2: Number added or changed
            else if (newAlertNumber && newAlertNumber !== previousAlertNumber) {
                const target = `${newAlertNumber}@c.us`;
                client.sendMessage(target, "✅ *Bot conectado* - Este número ahora recibirá alertas de sistema.").catch(e => {
                    console.error(`[CONFIG] Failed to send test message to ${target}:`, e.message);
                });
            }
        }

        res.json({ success: true, config });
    } else {
        res.status(400).json({ error: "Missing alertNumber" });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        console.log('[WHATSAPP] Logging out...');
        isConnected = false;
        qrCodeData = null;

        if (client.info) {
            await client.logout().catch(async (err) => {
                console.error('[LOGOUT] logout() failed, trying destroy():', err.message);
                try { await client.destroy(); } catch (e) { }
            });
        } else {
            console.log('[WHATSAPP] No client info, forcing destroy...');
            try { await client.destroy(); } catch (e) { }
        }

        io.emit('status_change', { status: 'disconnected' });
        res.json({ success: true });

        // Always try to re-initialize after a short delay
        setTimeout(() => {
            client.initialize().catch(err => console.error('[LOGOUT] re-init failed:', err.message));
        }, 1000);
    } catch (e) {
        console.error('[LOGOUT] Global Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/script', (req, res) => {
    // Basic implementation: In-memory update + overwrite file logic would go here
    /* 
    const newScript = req.body;
    Object.assign(knowledge, newScript);
    */
    res.json({ success: true, message: "Script updated in memory (File save not implemented yet)" });
});


// Start Server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Dashboard API running on http://localhost:${PORT}`);
});


// Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('🔴 UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔴 UNHANDLED REJECTION:', reason);
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// State & Buffer Storage
// userState: { 'phone': { step: 'greeting', data: {} } }
// messageBuffer: { 'phone': { timer: null, text: [] } }
const userState = {};
const messageBuffer = {};
let lastAlertUser = null; // Track last client that triggered an admin alert
let pausedUsers = new Set(); // Users where admin said "yo me encargo"

function saveState() {
    try {
        const data = {
            userState,
            lastAlertUser,
            pausedUsers: Array.from(pausedUsers),
            config
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
        // console.log('[STORAGE] State saved.');
    } catch (e) {
        console.error('🔴 Error saving state:', e.message);
    }
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE);
            const data = JSON.parse(raw);
            Object.assign(userState, data.userState || {});
            lastAlertUser = data.lastAlertUser || null;
            pausedUsers = new Set(data.pausedUsers || []);
            console.log('✅ State loaded from persistence.json');
        }
    } catch (e) {
        console.error('🔴 Error loading state:', e.message);
    }
}

loadState();
let aiAvailable = true; // Track if AI is available (rate limit)

// Helper: Transcribe Audio using Gemini
async function transcribeAudio(mediaData, mimetype) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent([
            {
                inlineData: {
                    data: mediaData,
                    mimeType: mimetype
                }
            },
            { text: "Transcripción exacta y literal de este audio en español. Si es incomprensible, responde solo [ERROR]." },
        ]);
        const text = result.response.text().trim();
        return text === "[ERROR]" ? null : text;
    } catch (e) {
        console.error("Transcription error:", e.message);
        return null;
    }
}

// Helper: Safe AI call with retry on rate limit
async function safeAICall(prompt, fallback = null) {
    try {
        const result = await model.generateContent(prompt);
        aiAvailable = true;
        return result.response.text();
    } catch (e) {
        if (e.status === 429) {
            console.log('[AI] Rate limited. Waiting 45s and retrying once...');
            aiAvailable = false;
            // Wait and retry once
            await new Promise(r => setTimeout(r, 46000));
            try {
                const result = await model.generateContent(prompt);
                aiAvailable = true;
                return result.response.text();
            } catch (e2) {
                console.error('[AI] Retry also failed:', e2.status || e2.message);
                return fallback;
            }
        }
        console.error('[AI] Non-rate-limit error:', e.message);
        return fallback;
    }
}

// Helper: Send with Delay (Typer) + Anti-Repetition
const sendMessageWithDelay = async (chatId, content) => {
    // Testing delay: 2s - 4s
    const delay = Math.floor(Math.random() * (4000 - 2000 + 1) + 2000);
    console.log(`[DELAY] Waiting ${delay / 1000}s before sending to ${chatId}`);

    // Anti-Repetition: If same message, use last line (no AI call to save quota)
    if (userState[chatId]?.lastMessage === content) {
        console.log(`[ANTI-REPEAT] Detected repeat for ${chatId}, shortening.`);
        const lines = content.split('\n').filter(l => l.trim());
        content = lines.length > 1 ? lines[lines.length - 1] : '¿Necesitás algo más? 😊';
    }

    // Track last message sent
    if (userState[chatId]) {
        userState[chatId].lastMessage = content;
    }

    // Log Bot Message
    logAndEmit(chatId, 'bot', content, userState[chatId]?.step);

    // Simulating delay
    setTimeout(async () => {
        try {
            await client.sendMessage(chatId, content);
            console.log(`[SENT] Message sent to ${chatId}`);
        } catch (e) {
            console.error(`[ERROR] Failed to send message: ${e}`);
        }
    }, delay);
};

// Helper: Notify Admin (Sound + Message)
async function notifyAdmin(reason, userPhone, details = null) {
    // Windows Beep (Force Sound via PowerShell)
    exec('powershell "[console]::beep(1000, 500)"', (err) => {
        if (err) console.error("Beep failed:", err);
    });

    console.error(`⚠️ [ADMIN ALERT] ${reason} (User: ${userPhone})`);

    // Anti-duplicate check: If same user, same reason, within 8 seconds, ignore
    const now = Date.now();
    const lastAlert = sessionAlerts[0]; // Check only the newest one
    if (lastAlert && lastAlert.userPhone === userPhone && lastAlert.reason === reason && (now - lastAlert.id < 8000)) {
        console.log(`[ALERT] Duplicate alert suppressed for ${userPhone}`);
        return;
    }

    // Track who triggered the alert
    lastAlertUser = userPhone;

    const newAlert = {
        id: Date.now(),
        timestamp: new Date(),
        reason,
        userPhone,
        userName: userState[userPhone]?.userName || userPhone,
        details: details || ""
    };

    sessionAlerts.unshift(newAlert);
    if (sessionAlerts.length > 50) sessionAlerts.pop();

    if (io) io.emit('new_alert', newAlert);

    // Forward to Alert Number if configured
    if (config.alertNumber) {
        const targetAlert = `${config.alertNumber}@c.us`;
        const alertMsg = `⚠️ *ALERTA SISTEMA*\n\n` +
            `*Motivo:* ${reason}\n` +
            `*Cliente:* ${userPhone}\n` +
            `*Nombre:* ${newAlert.userName}\n` +
            `*Detalles:* ${details || "Sin detalles"}`;

        client.sendMessage(targetAlert, alertMsg).catch(e => {
            console.error(`[ALERT] Failed to forward to ${targetAlert}:`, e.message);
        });
    }
}

// Helper: Handle Admin Command (NLP)
async function handleAdminCommand(targetChatId, commandText, isApi = false) {
    const lowerMsg = commandText.toLowerCase().trim();
    const userId = process.env.ADMIN_NUMBER ? `${process.env.ADMIN_NUMBER.replace(/\D/g, '')}@c.us` : null;

    // 1. Summary
    if (lowerMsg === '!resumen' || lowerMsg === '!analisis') {
        const report = await analyzeDailyLogs();
        if (isApi) return report || "No hay logs para hoy.";
        if (userId) await client.sendMessage(userId, report || "No hay logs.");
        return "Report sent to WA";
    }

    // 2. Confirmation
    if (lowerMsg === 'ok' || lowerMsg === 'dale' || lowerMsg === 'si' || lowerMsg === 'confirmar') {
        const actualTarget = targetChatId || lastAlertUser;
        if (!actualTarget) return "No pending user.";

        const clientState = userState[actualTarget];
        if (clientState && clientState.step === 'waiting_admin_ok' && clientState.pendingOrder) {
            const o = clientState.pendingOrder;
            const productName = clientState.selectedProduct || "Nuez de la India (a confirmar)";
            const planName = clientState.selectedPlan ? `Plan de ${clientState.selectedPlan} días` : "Plan a confirmar";
            const price = clientState.price || "A confirmar";

            const confirmMsg = `📦 *INFORMACIÓN FINAL DE ENVÍO – IMPORTANTE*\n\n` +
                `*Producto:* ${productName}\n` +
                `*Cantidad:* ${planName}\n` +
                `*Precio:* $ ${price} .-\n\n` +
                `✔ Correo Argentino\n` +
                `✔ Pago en efectivo al recibir\n` +
                `✔ 7 a 10 días hábiles\n\n` +
                `* Si el cartero no te encuentra, puede pedir retiro en sucursal\n` +
                `* Plazo de retiro: 72 hs hábiles\n` +
                `. Sin costos de envío.\n\n` +
                `Te recordamos que el rechazo del pedido o el no retiro dentro de las 72 hs generará un gasto de $ 18.000.- Damos por hecho que estás aceptando esta condición.\n\n` +
                `¡Gracias por elegir Herbalis! Nuestro horario de atención es de lunes a lunes de 9 a 21 hs. Quedamos a tu disposición.\n\n` +
                `📞 *Número de contacto alternativo:* 3413755757`;

            await client.sendMessage(actualTarget, confirmMsg);
            logAndEmit(actualTarget, 'bot', confirmMsg, 'order_confirmed');
            clientState.step = 'completed';
            saveState();

            saveOrderToLocal({
                cliente: actualTarget,
                nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                producto: productName, plan: planName, precio: price
            });

            appendOrderToSheet({
                cliente: actualTarget,
                nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp,
                producto: productName, plan: planName, precio: price
            }).catch(e => console.error('🔴 [SHEETS] Async log failed:', e.message));

            // Clear alerts for this user
            const index = sessionAlerts.findIndex(a => a.userPhone === actualTarget);
            if (index !== -1) sessionAlerts.splice(index, 1);

            return `✅ Pedido confirmado para ${actualTarget}`;
        }
        return "⚠️ No hay pedido pendiente.";
    }

    // 3. Pause
    if (lowerMsg.includes('yo me encargo') || lowerMsg.includes('me encargo yo') || lowerMsg.includes('lo manejo yo')) {
        const actualTarget = targetChatId || lastAlertUser;
        if (actualTarget) {
            pausedUsers.add(actualTarget);
            saveState();
            io.emit('bot_status_change', { chatId: actualTarget, paused: true });
            // Clear alerts for this user
            const index = sessionAlerts.findIndex(a => a.userPhone === actualTarget);
            if (index !== -1) sessionAlerts.splice(index, 1);

            return `✅ Bot pausado para ${actualTarget}`;
        }
        return "⚠️ No hay cliente para pausar.";
    }

    // 4. Resume
    if (lowerMsg.includes('reactivar') || lowerMsg.includes('activar bot') || lowerMsg.includes('retomar')) {
        const actualTarget = targetChatId || lastAlertUser;
        if (actualTarget && pausedUsers.has(actualTarget)) {
            pausedUsers.delete(actualTarget);
            saveState();
            io.emit('bot_status_change', { chatId: actualTarget, paused: false });
            return `✅ Bot reactivado para ${actualTarget}`;
        }
        return "No hay clientes pausados.";
    }

    return "Comando no reconocido.";
}

// AI Helper: Parse Address
async function parseAddressWithAI(text) {
    const prompt = `
    Extraé los datos de envío de este texto.
    
    REGLAS DE VALIDACIÓN GEOGRÁFICA (Argentina):
    1. ¿La calle y número tienen sentido en esa ciudad? (Ej: "Venegas 77" sí existe en Rosario).
    2. ¿El Código Postal (CP) coincide con la provincia/ciudad?
    3. Si el usuario solo puso "Rosario" pero no la calle, marcá direccion_valida: false.
    4. Sé estricto. Si algo parece inventado o incompleto, avisale al vendedor.

    EJEMPLOS:
    - "Cristian giosue Venegas 77 2000 rosario" → {"nombre":"Cristian Giosue","calle":"Venegas 77","ciudad":"Rosario","cp":"2000","direccion_valida":true,"comentario_validez":""}
    - "Carla, Calle Falsa 123, Ciudad de la Luna" → {"nombre":"Carla","calle":"Calle Falsa 123","ciudad":"Ciudad de la Luna","cp":null,"direccion_valida":false,"comentario_validez":"La ciudad y calle no parecen reales."}
    
    Texto del usuario: "${text}"
    
    Devolvé SOLO un JSON con keys: "nombre", "calle", "ciudad", "cp", "direccion_valida" (boolean), "comentario_validez" (string).
    `;
    const textResponse = await safeAICall(prompt, null);

    // FALLBACK: If AI fails (Rate limit), use Regex to at least get CP and something
    if (!textResponse) {
        console.log("[AI FALLBACK] AI unavailable, using Regex...");
        const cpMatch = text.match(/\b\d{4}\b/); // Find 4 digit CP
        // Extract words for name (simple heuristic: first 2 words)
        const words = text.split(' ').filter(w => w.length > 2);
        return {
            nombre: words.length >= 2 ? `${words[0]} ${words[1]}` : null,
            calle: text.length > 10 ? text : null,
            ciudad: null,
            cp: cpMatch ? cpMatch[0] : null,
            _ai_failed: true
        };
    }

    try {
        const jsonStr = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error("AI JSON Parse Error:", e.message);
        return null;
    }
}

// AI Helper: Generate Contextual Response (Off-Script)
async function generateSmartResponse(userInput, currentState) {
    // Define the "steering" goal based on current step
    let steeringGoal = "Preguntale cómo podés ayudarlo a empezar.";
    if (currentState) {
        switch (currentState.step) {
            case 'greeting': steeringGoal = "Motivarlos a que digan cuántos kilos quieren bajar."; break;
            case 'waiting_weight': steeringGoal = "Preguntales amablemente de nuevo cuántos kilos quieren perder."; break;
            case 'waiting_preference': steeringGoal = "Preguntales si prefieren Opción 1 (Cápsulas) u Opción 2 (Semillas)."; break;
            case 'waiting_plan_choice': steeringGoal = "Preguntales qué plan prefieren (60 o 120 días)."; break;
            case 'waiting_ok': steeringGoal = "Preguntale si nos asegura que podrá retirar por sucursal si el correo lo solicita."; break;
            case 'waiting_data': steeringGoal = "Pedile sus datos de envío (Nombre, Dirección, CP)."; break;
        }
    }

    const prompt = `
    Sos un asistente de ventas de "Herbalis" (Nuez de la India).
    Contexto:
    - Productos: Cápsulas, Gotas, Semillas (Adelgazamiento natural).
    - Precios: Plan 60 días ~$40-45k, Plan 120 días ~$62-82k. Sin costo de envío.
    - Pagos: Solo efectivo contra reembolso (pagás al recibir).
    
    Tu objetivo actual: ${steeringGoal}
    
    El usuario dice: "${userInput}"
    
    Instrucciones:
    1. Respondé a la duda del usuario de forma breve y amigable.
    2. INMEDIATAMENTE después de responder, hacé una pregunta para volver al "Objetivo actual".
    3. Mantenelo corto (menos de 50 palabras).
    4. **IMPORTANTE**: Hablá siempre en español argentino (voseo), de forma natural y vendedora. No respondas en inglés bajo ninguna circunstancia.
    5. **REGLA DE PRECIOS**: SOLO existen planes de 60 días ($45.900/$34.900) y 120 días ($82.600/$62.900). 
    6. Si el usuario pide "70 días", "30 días" o algo que no existe, decile amablemente que NO existe y volvé a ofrecer 60 o 120. JAMÁS INVENTES UN PRECIO o PLAN.
    7. Si el usuario dice algo que no entendés o un número fuera de rango, guialo de nuevo a las opciones 1 o 2.
    `;
    const response = await safeAICall(prompt, null);
    if (!response) {
        console.error("🔴 [AI ERROR] generateSmartResponse failed");
        // Don't notify admin on rate limits, just skip
        if (aiAvailable) notifyAdmin("Fallo de IA / Sin respuesta", userInput);
        return null;
    }
    return response;
}

if (!process.env.GEMINI_API_KEY) {
    console.error("❌ CRITICAL: GEMINI_API_KEY is missing in .env!");
} else {
    const maskedKey = process.env.GEMINI_API_KEY.substring(0, 8) + '...' + process.env.GEMINI_API_KEY.slice(-4);
    console.log(`✅ GEMINI_API_KEY loaded: ${maskedKey}`);
}

// --- Logic ---

client.on('qr', (qr) => {
    console.log('ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP:');
    qrcode.generate(qr, { small: true });
    qrCodeData = qr;
    io.emit('qr', qr);
});

client.on('ready', () => {
    console.log('¡El cliente está listo!');
    isConnected = true;
    qrCodeData = null;
    io.emit('ready', { info: client.info });
});

client.on('disconnected', (reason) => {
    console.log('🔴 Client was logged out or disconnected:', reason);
    isConnected = false;
    qrCodeData = null;
    // We cannot easily clear client.info as it is read-only or internal, 
    // but the status endpoint uses qrCodeData and client.info
    io.emit('status_change', { status: 'disconnected' });

    // Attempt to re-initialize to get a new QR code
    console.log('[WHATSAPP] Re-initializing client...');
    client.initialize().catch(err => {
        console.error("🔴 Re-initialization failed:", err.message);
    });
});

client.on('message', async msg => {
    // Ignore status broadcasts
    if (msg.from === 'status@broadcast') return;

    const chat = await msg.getChat();
    if (chat.isGroup) return;

    const userId = msg.from;
    const adminNumber = process.env.ADMIN_NUMBER;
    const cleanAdmin = adminNumber ? adminNumber.replace(/\D/g, '') : '';
    const isAdmin = msg.fromMe || (cleanAdmin && userId.startsWith(cleanAdmin));

    const msgText = (msg.body || '').trim();
    const lowerMsg = msgText.toLowerCase();

    // --- ADMIN / SELF COMMANDS ---
    if (isAdmin) {
        if (!msgText) return;
        console.log(`[ADMIN] Self-chat: ${msgText}`);

        // 1. Specific ! commands
        if (lowerMsg.startsWith('!saltear ') || lowerMsg.startsWith('!skip ')) {
            const parts = msgText.split(' ');
            const targetNumber = parts[1];
            if (!targetNumber) {
                await client.sendMessage(msg.from, '⚠️ Formato: !saltear <número>');
                return;
            }
            const targetChatId = targetNumber.includes('@') ? targetNumber : `${targetNumber.replace(/\D/g, '')}@c.us`;
            if (!userState[targetChatId]) userState[targetChatId] = { step: 'greeting', partialAddress: {} };
            userState[targetChatId].step = 'waiting_data';
            saveState();
            await client.sendMessage(targetChatId, knowledge.flow.data_request.response);
            await client.sendMessage(msg.from, `✅ Usuario ${targetNumber} forzado a pedir datos.`);
            return;
        }

        if (lowerMsg === '!ayuda' || lowerMsg === '!help') {
            await client.sendMessage(msg.from,
                `📋 *Comandos disponibles:*\n\n` +
                `!resumen — Informe diario\n` +
                `!saltear <num> — Forzar pedido de datos\n` +
                `!ayuda — Ver esta lista\n\n` +
                `*Instrucciones naturales:* También podés decir "ok", "yo me encargo", etc.`
            );
            return;
        }

        // 2. Helper for "ok", "yo me encargo", etc.
        const result = await handleAdminCommand(lastAlertUser, msgText);

        if (result === "Comando no reconocido." && lastAlertUser) {
            // Interpret as natural response for customer
            try {
                const interpretPrompt = `
                     Sos el asistente de un vendedor. El vendedor te da una instrucción sobre qué responderle a un cliente.
                     Instrucción del vendedor: "${msgText}"
                     Contexto: Vendés Nuez de la India (cápsulas, gotas, semillas).
                     Generá el mensaje EXACTO que se le debe enviar al cliente. 
                     Usá español argentino (voseo). Devolvé SOLO el cuerpo del mensaje.
                 `;
                const aiResult = await model.generateContent(interpretPrompt);
                const generatedMsg = aiResult.response.text().trim();
                await client.sendMessage(lastAlertUser, generatedMsg);
                logAndEmit(lastAlertUser, 'admin', generatedMsg, 'admin_instruction');
                await client.sendMessage(msg.from, `✅ Enviado a ${lastAlertUser}:\n"${generatedMsg}"`);
            } catch (err) {
                await client.sendMessage(msg.from, `❌ Error: ${err.message}`);
            }
        } else {
            await client.sendMessage(msg.from, result);
        }
        return;
    }

    // --- SAFETY FILTERS ---

    // 1. Multimedia Handler (Audio, Stickers, Images)
    if (msg.type === 'ptt' || msg.type === 'audio' || msg.type === 'sticker' || msg.type === 'image') {
        console.log(`[MEDIA] ${msg.type.toUpperCase()} received from ${userId}. Processing...`);

        try {
            const media = await msg.downloadMedia();
            if (media) {
                // Determine extension and filename
                const extension = media.mimetype.split('/')[1]?.split(';')[0] || (msg.type === 'sticker' ? 'webp' : 'jpg');
                const filename = `${msg.type}_${Date.now()}_${userId.split('@')[0]}.${extension}`;
                const filePath = path.join(__dirname, 'public', 'media', filename);
                fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));

                const relativeUrl = `/media/${filename}`;

                if (msg.type === 'ptt' || msg.type === 'audio') {
                    // Transcribe Audio
                    const transcription = await transcribeAudio(media.data, media.mimetype);

                    if (transcription) {
                        console.log(`[TRANSCRIPTION] ${userId}: ${transcription}`);
                        const mediaTag = `MEDIA_AUDIO:${relativeUrl}|TRANSCRIPTION:${transcription}`;

                        // Log and Emit with Transcription
                        logAndEmit(userId, 'user', mediaTag, userState[userId]?.step || 'audio_received');

                        // --- SMART LOGIC: Should we pause? ---
                        const needsHuman = transcription.toLowerCase().includes('humano') ||
                            transcription.toLowerCase().includes('persona') ||
                            transcription.toLowerCase().includes('administrador');

                        if (needsHuman) {
                            await notifyAdmin("Cliente pide hablar con una PERSONA 👤", userId, `Transcripción: "${transcription}"`);
                            pausedUsers.add(userId);
                            saveState();
                            return;
                        }

                        // Otherwise, process as normal text!
                        await handleConversation(userId, transcription);
                    } else {
                        // Fallback if transcription fails
                        const mediaTag = `MEDIA_AUDIO:${relativeUrl}`;
                        logAndEmit(userId, 'user', mediaTag, 'audio_failed');
                        await notifyAdmin("Audio recibido (No se pudo transcribir) 🎤", userId, "Pausando bot por precaución.");
                        pausedUsers.add(userId);
                        saveState();
                    }
                } else {
                    // Handle Sticker or Image
                    const mediaTag = `MEDIA_IMAGE:${relativeUrl}`;
                    logAndEmit(userId, 'user', mediaTag, userState[userId]?.step || 'media_received');

                    // Optional: Notify on photos if bot is sensitive
                    if (msg.type === 'image') {
                        await notifyAdmin("Recibí una FOTO 📸", userId, "Disponible en el panel.");
                    }
                }
            }
        } catch (err) {
            console.error(`Failed to process ${msg.type}:`, err.message);
            await notifyAdmin(`Error procesando multimedia (${msg.type}) ⚠️`, userId, err.message);
        }
        return;
    }

    const messageBody = msgText;

    // 2. Empty Message Filter (Safety)
    if (!messageBody && (msg.type === 'chat' || !msg.body)) {
        console.log(`[SAFETY] Empty message from ${userId}. Ignoring.`);
        return;
    }

    // 3. Offensive Language Filter
    const OFENSIVAS = ['puto', 'pito', 'chupa', 'idiota', 'estupido', 'mierda', 'verga', 'concha', 'tarado', 'salame', 'boludo', 'trolo', 'culo', 'pija', 'orto'];
    if (OFENSIVAS.some(word => lowerMsg.includes(word))) {
        // ... (existing logic)
        console.log(`[SAFETY] Offensive content from ${userId}: "${messageBody}"`);
        // Notify Admin
        await notifyAdmin(`Lenguaje OFENSIVO detectado`, userId, messageBody);
        // Pause Bot
        pausedUsers.add(userId);
        saveState();
        // NO REPLY to user
        return;
    }

    console.log(`[BUFFER] Received from ${userId}: ${messageBody}`);

    // Log Incoming Message
    const currentStep = userState[userId]?.step || 'new_user';
    logAndEmit(userId, 'user', messageBody, currentStep);

    // Initialize Buffer
    if (!messageBuffer[userId]) {
        messageBuffer[userId] = { timer: null, text: [] };
    }

    // Add message to buffer
    messageBuffer[userId].text.push(messageBody);

    // Clear previous timer
    if (messageBuffer[userId].timer) {
        clearTimeout(messageBuffer[userId].timer);
    }

    // Set new timer (e.g., 6 seconds silence)
    messageBuffer[userId].timer = setTimeout(async () => {
        // --- PROCESS BUFFERED MESSAGE ---
        const combinedText = messageBuffer[userId].text.join(' ');
        messageBuffer[userId].text = []; // Clear buffer
        messageBuffer[userId].timer = null;

        console.log(`[PROCESS] Processing for ${userId}: "${combinedText}"`);
        await handleConversation(userId, combinedText);

    }, 3000); // reduced buffer to 3s for testing (User requested 3s)
});

async function handleConversation(userId, text) {
    // Check if admin has taken over this client
    if (pausedUsers.has(userId)) {
        // FAILSAFE: Allow user to unpause themselves with specific command (Useful for testing/getting stuck)
        if (text.toLowerCase().trim() === 'reactivar' || text.toLowerCase().trim() === '#reactivar') {
            pausedUsers.delete(userId);
            saveState();
            await client.sendMessage(userId, '✅ Bot reactivado manual (Failsafe).');
            return;
        }

        console.log(`[PAUSED] Skipping auto-response for ${userId} (admin handling)`);
        logAndEmit(userId, 'system', 'Bot paused - admin handling', 'paused');
        return;
    }
    const lowerText = text.toLowerCase();

    // Init User State
    if (!userState[userId]) {
        userState[userId] = { step: 'greeting', lastMessage: null, addressAttempts: 0, partialAddress: {} };
        saveState();
    }
    const currentState = userState[userId];

    // 1. Check Global FAQs (Priority 1)
    for (const faq of knowledge.faq) {
        if (faq.keywords.some(k => lowerText.includes(k))) {
            await sendMessageWithDelay(userId, faq.response);

            // If the FAQ dictates a flow change (e.g. asking for weight), update state
            if (faq.triggerStep) {
                userState[userId].step = faq.triggerStep;
                saveState();
                console.log(`[FAQ TRIGGER] Moved user ${userId} to ${faq.triggerStep}`);
            }

            return;
        }
    }

    // 2. Step Logic
    let matched = false;

    switch (currentState.step) {
        case 'greeting':
            // Assume any first interaction is a greeting or intent to buy
            await sendMessageWithDelay(userId, knowledge.flow.greeting.response);
            userState[userId].step = knowledge.flow.greeting.nextStep;
            saveState();
            matched = true;
            break;

        case 'waiting_weight':
            // Usar IA para chequear si el mensaje es un objetivo de peso o una duda
            const weightCheckPrompt = `
            Al usuario se le preguntó: "¿Cuántos kilos querés perder?".
            El usuario respondió: "${text}".
            ¿Es esto una respuesta válida sobre peso/objetivo? (ej: "10kg", "mucho", "no se", "la panza", "20")
            ¿O es una pregunta/comentario no relacionado? (ej: "¿cuánto sale?", "¿dónde están?")
            Devolvé un JSON: {"is_goal": true/false}
            `;
            let isGoal = true; // Default to true to be permissive, unless AI says otherwise
            try {
                const result = await model.generateContent(weightCheckPrompt);
                const json = JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim());
                isGoal = json.is_goal;
            } catch (e) {
                console.error("🔴 [AI CHECK ERROR] weightCheckPrompt failed:", e);
                console.log("AI Check failed, assuming goal.");
            }

            if (isGoal) {
                await sendMessageWithDelay(userId, knowledge.flow.recommendation.response);
                userState[userId].step = knowledge.flow.recommendation.nextStep;
                matched = true;
            } else {
                // If not a goal, maybe it's a question the FAQ didn't catch?
                // Let "matched = false" so Off-Script AI handles it.
                matched = false;
            }
            break;

        case 'waiting_preference':
            // Simple keyword check for 1 vs 2
            if (knowledge.flow.preference_capsulas.match.some(k => lowerText.includes(k))) {
                userState[userId].selectedProduct = "Cápsulas de nuez de la india";
                await sendMessageWithDelay(userId, knowledge.flow.preference_capsulas.response);
                userState[userId].step = knowledge.flow.preference_capsulas.nextStep;
                saveState();
                matched = true;
            } else if (knowledge.flow.preference_semillas.match.some(k => lowerText.includes(k))) {
                userState[userId].selectedProduct = "Semillas de nuez de la india";
                await sendMessageWithDelay(userId, knowledge.flow.preference_semillas.response);
                userState[userId].step = knowledge.flow.preference_semillas.nextStep;
                saveState();
                matched = true;
            }
            break;

        case 'waiting_plan_choice':
            // Determine plan and price
            if (lowerText.includes('60')) {
                userState[userId].selectedPlan = "60";
                userState[userId].price = (userState[userId].selectedProduct === "Cápsulas de nuez de la india") ? "45.900" : "34.900";
            } else if (lowerText.includes('120')) {
                userState[userId].selectedPlan = "120";
                userState[userId].price = (userState[userId].selectedProduct === "Cápsulas de nuez de la india") ? "82.600" : "62.900";
            }

            await sendMessageWithDelay(userId, knowledge.flow.closing.response);
            userState[userId].step = knowledge.flow.closing.nextStep;
            saveState();
            matched = true;
            break;

        case 'waiting_ok':
            // Any positive confirmation - but check for doubts!
            const isPositive = knowledge.flow.data_request.match.some(k => lowerText.includes(k)) || lowerText === 'ok';
            const hasDoubts = lowerText.includes('pero') || lowerText.includes('duda') || lowerText.includes('?') || lowerText.includes('pregunta');

            if (isPositive && !hasDoubts) {
                await sendMessageWithDelay(userId, knowledge.flow.data_request.response);
                userState[userId].step = knowledge.flow.data_request.nextStep;
                saveState();
                matched = true;
            }
            // If hasDoubts, let it fall through to Off-Script AI
            break;

        case 'waiting_data':
            // THIS IS WHERE AI SHINES - Smart incremental parsing
            console.log("Analyzing address data with AI...");
            const data = await parseAddressWithAI(text);

            // Merge new data with any partial data from previous attempts
            if (data) {
                if (data.nombre) currentState.partialAddress.nombre = data.nombre;
                if (data.calle) currentState.partialAddress.calle = data.calle;
                if (data.ciudad) currentState.partialAddress.ciudad = data.ciudad;
                if (data.cp) currentState.partialAddress.cp = data.cp;
            }

            const addr = currentState.partialAddress;
            currentState.addressAttempts = (currentState.addressAttempts || 0) + 1;

            // Check what we have and what we're missing
            const missing = [];
            if (!addr.nombre) missing.push('Nombre completo');
            if (!addr.calle) missing.push('Calle y número');
            if (!addr.ciudad) missing.push('Ciudad');
            if (!addr.cp) missing.push('Código postal');

            if (missing.length === 0 || (addr.calle && addr.ciudad && missing.length <= 1) || data?._ai_failed) {
                // Determine if there are sanity warnings
                let validationWarning = "";
                if (data && data.direccion_valida === false) {
                    validationWarning = `\n⚠️ *AVISO:* ${data.comentario_validez || "Dirección sospechosa o incompleta"}\n`;
                }

                const isError = data?._ai_failed ? "⚠️ (Fallo IA - Revisar manual)" : "";
                const productInfo = currentState.selectedProduct ? `\n*Producto:* ${currentState.selectedProduct}\n*Plan:* ${currentState.selectedPlan} días ($${currentState.price})` : "";
                const summary = `📦 *RESUMEN DE PEDIDO* ${isError}\n${validationWarning}${productInfo}\n\n*Datos:* ${addr.nombre || '?'}, ${addr.calle || '?'}, ${addr.ciudad || '?'}, ${addr.cp || '?'}\n\n¿Está bien? Respondé *"ok"* para confirmar.`;

                currentState.pendingOrder = { ...addr };
                userState[userId].step = 'waiting_admin_ok';
                lastAlertUser = userId;

                saveState();

                // Centralized Notification
                await notifyAdmin(`Pedido completo esperando confirmación`, userId, summary);

                await sendMessageWithDelay(userId, `Gracias por los datos 🙌 Estoy verificando todo, te confirmo en un momento.`);
                matched = true;
            } else if (currentState.addressAttempts >= 2) {
                const rawInfo = `Texto: "${text}"\nParse: ${addr.nombre || '?'}, ${addr.calle || '?'}, ${addr.ciudad || '?'}, ${addr.cp || '?'}`;
                await notifyAdmin(`No pude parsear la dirección`, userId, rawInfo);
                await sendMessageWithDelay(userId, `Gracias por los datos 🙌 Mi compañero va a revisar tu pedido y te confirma en breve. ¡Ya queda poco!`);
                userState[userId].step = 'waiting_admin_ok';
                saveState();
                matched = true;
            } else {
                // Only pester if AI actually found SOME data, or if it really looks like an attempt to give address
                const looksLikeAddress = /\d/.test(text) || text.length > 20;
                if (data || looksLikeAddress) {
                    await sendMessageWithDelay(userId, `Gracias! Ya tengo algunos datos. Solo me falta: *${missing.join(', ')}*. ¿Me los pasás?`);
                    matched = true;
                } else {
                    // Fall back to AI to answer their question
                    matched = false;
                }
            }
            break;

        case 'waiting_admin_ok':
            // Client is messaging while we wait for admin approval
            await sendMessageWithDelay(userId, `Estamos revisando tu pedido, te confirmo en breve 😊`);
            matched = true;
            break;

        case 'completed':
            // Reset if specific keywords
            if (lowerText.includes('hola')) {
                userState[userId].step = 'greeting';
                await sendMessageWithDelay(userId, knowledge.flow.greeting.response);
                userState[userId].step = knowledge.flow.greeting.nextStep;
                saveState();
                matched = true;
            }
    }

    // 3. Off-Script / Manual Fallback with AI
    if (!matched) {
        console.log(`[OFF-SCRIPT] Generating AI response for: ${text}`);
        // Log intent to use AI
        logAndEmit(userId, 'system', 'Triggering AI Smart Response', currentState.step);

        // Generating Response
        const aiResponse = await generateSmartResponse(text, currentState);
        if (aiResponse) {
            await sendMessageWithDelay(userId, aiResponse);
        }
    }
}

// --- SALES API ---
app.get('/api/orders', (req, res) => {
    if (fs.existsSync(ORDERS_FILE)) {
        res.json(JSON.parse(fs.readFileSync(ORDERS_FILE)));
    } else {
        res.json([]);
    }
});

app.post('/api/orders/:id/status', (req, res) => {
    const { id } = req.params;
    const { status, tracking } = req.body;

    if (!fs.existsSync(ORDERS_FILE)) return res.status(404).json({ error: "No orders found" });

    let orders = JSON.parse(fs.readFileSync(ORDERS_FILE));
    const index = orders.findIndex(o => o.id === id);
    if (index === -1) return res.status(404).json({ error: "Order not found" });

    if (status) orders[index].status = status;
    if (tracking !== undefined) orders[index].tracking = tracking;

    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    io.emit('order_update', orders[index]);
    res.json({ success: true, order: orders[index] });
});

app.post('/api/sheets/test', async (req, res) => {
    try {
        const testData = {
            cliente: 'DASHBOARD_TEST',
            nombre: 'Prueba desde Panel',
            calle: 'Test 123',
            ciudad: 'Dashboard',
            cp: '0000',
            producto: 'Test',
            plan: 'Test',
            precio: '0'
        };
        const success = await appendOrderToSheet(testData);
        if (success) {
            res.json({ success: true, message: "Sincronización de prueba exitosa" });
        } else {
            res.status(500).json({ success: false, message: "Error en la sincronización" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- AI SUMMARIZATION ---
app.get('/api/summarize/:chatId', async (req, res) => {
    const { chatId } = req.params;

    // 1. Check Cache (valid for 5 minutes)
    const cached = summaryCache.get(chatId);
    if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000)) {
        return res.json({ summary: cached.text });
    }

    try {
        const history = await client.getChatById(chatId).then(c => c.fetchMessages({ limit: 10 })); // Reduced limit to 10 for speed/cost
        const formattedHistory = history.map(m => `${m.fromMe ? 'Bot' : 'Usuario'}: ${m.body}`).join('\n');

        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const prompt = `Resumí en una sola oración súper concisa (máximo 12 palabras) el estado de esta conversación de venta de Herbalis.
        Enfocate en: ¿Qué quiere el cliente? ¿Qué eligió? ¿Dio sus datos?
        Chat:\n${formattedHistory}`;

        const result = await model.generateContent(prompt);
        const summary = result.response.text().trim();

        // Update Cache
        summaryCache.set(chatId, { text: summary, timestamp: Date.now() });

        res.json({ summary });
    } catch (err) {
        if (err.status === 429) {
            console.warn("[AI] Rate limit hit. Sending fallback summary.");
            return res.json({ summary: "El bot está procesando mucha info. Reintentá en un momento." });
        }
        console.error("Summary error:", err);
        res.status(500).json({ summary: "No se pudo generar el resumen." });
    }
});

// --- SOCKET SYNC ---
io.on('connection', (socket) => {
    if (client && client.info) {
        socket.emit('ready', { info: client.info });
    } else if (qrCodeData) {
        socket.emit('qr', qrCodeData);
    }
});

client.initialize().catch(err => {
    console.error("🔴 FAILURE DURING INITIALIZATION:", err);
});
