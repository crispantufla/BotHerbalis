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
const { atomicWriteFile } = require('./safeWrite');
const { processSalesFlow } = require('./src/flows/salesFlow');
const { generateSmartResponse } = require('./src/services/ai');

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
        atomicWriteFile(KNOWLEDGE_FILE, JSON.stringify(knowledge, null, 2));
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
    atomicWriteFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
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
const userState = {};
const messageBuffer = {};
let lastAlertUser = null;
let pausedUsers = new Set();
// Variables for API / Dashboard State
let qrCodeData = null;
let sessionAlerts = [];
let config = { alertNumber: '' };
let isConnected = false;

// --- SERVER START ---
const { startServer } = require('./src/api/server');
// Initialize Server
const { io, app } = startServer(client);

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
            messages = waMessages.map(m => {
                let body = m.body;
                // If it's a media message and has no body (WhatsApp standard), 
                // we mark it so the frontend can try to find it in local logs or at least show it's media.
                if (m.hasMedia && !body) {
                    if (m.type === 'audio' || m.type === 'ptt') body = 'MEDIA_AUDIO:PENDING';
                    else if (m.type === 'image' || m.type === 'sticker') body = 'MEDIA_IMAGE:PENDING';
                }
                return {
                    fromMe: m.fromMe,
                    body: body,
                    timestamp: m.timestamp,
                    type: m.type,
                    id: m.id._serialized
                };
            });
        } catch (waErr) {
            console.error(`[HISTORY] WA Fetch Error for ${chatId}:`, waErr.message);
        }

        // 2. Get from Local Logs
        const localMessages = getLocalHistory(chatId);

        // 3. Merge and deduplicate
        // We want to PRIORITIZE local logs for media messages because they contain the file paths.
        // We'll iterate through WA messages and "upgrade" them if we find a matching local media log.
        const refinedMessages = messages.map(m => {
            if (m.hasMedia || m.type === 'image' || m.type === 'audio' || m.type === 'ptt' || m.type === 'sticker') {
                const match = localMessages.find(lm => {
                    const timeDiff = Math.abs(m.timestamp - lm.timestamp);
                    const sameRole = m.fromMe === lm.fromMe;
                    const isMediaLog = lm.body?.startsWith('MEDIA_');
                    return sameRole && timeDiff <= 3 && isMediaLog;
                });
                if (match) return { ...m, body: match.body }; // Enhance with local tag
            }
            return m;
        });

        const combined = [...refinedMessages];

        localMessages.forEach(lm => {
            const isDuplicate = refinedMessages.some(m => {
                const timeDiff = Math.abs(m.timestamp - lm.timestamp);
                const sameRole = m.fromMe === lm.fromMe;
                return sameRole && timeDiff <= 2 && (m.body === lm.body || (lm.body?.startsWith('MEDIA_') && m.hasMedia));
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





// Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('🔴 UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔴 UNHANDLED REJECTION:', reason);
});

// (Moved to top)

function saveState() {
    try {
        const stateToSave = {
            userState,
            lastAlertUser,
            pausedUsers: Array.from(pausedUsers),
            config
        };
        atomicWriteFile(STATE_FILE, JSON.stringify(stateToSave, null, 2));
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
            const product = clientState.selectedProduct || "Nuez de la India";
            const plan = clientState.selectedPlan || "60";
            const price = clientState.price || (product.includes("Cápsulas") ? "45.900" : "34.900");

            const summary = `✅ *PEDIDO CASI LISTO* 😊\n\n📌 *Resumen de tu compra:*\n• Producto: ${product}\n• Plan: ${plan} días\n• Total a pagar: *$${price}* (en efectivo al recibir)\n\n📦 *Envío por Correo Argentino*\n⏳ Demora estimada: 7 a 10 días hábiles\n\n📍 *A tener en cuenta:*\n• Si el cartero no te encuentra, el correo puede pedir retiro en sucursal\n• El plazo de retiro es de 72 hs hábiles\n• Rechazar el pedido genera un costo de $16.500\n\n👉 Para confirmar el despacho respondé por favor: *“LEÍ Y ACEPTO LAS CONDICIONES DE ENVÍO”*`;

            await client.sendMessage(actualTarget, summary);
            logAndEmit(actualTarget, 'bot', summary, 'waiting_legal_acceptance');
            clientState.step = 'waiting_legal_acceptance';
            saveState();

            // Clear alerts for this user
            const index = sessionAlerts.findIndex(a => a.userPhone === actualTarget);
            if (index !== -1) sessionAlerts.splice(index, 1);

            return `✅ Resumen enviado a ${actualTarget}. Esperando aceptación legal.`;
        }
        return "⚠️ No hay pedido pendiente de aprobación.";
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
    if (msg.hasMedia || msg.type === 'ptt' || msg.type === 'audio' || msg.type === 'sticker' || msg.type === 'image') {
        console.log(`[MEDIA] ${msg.type.toUpperCase()} received from ${userId}. Processing...`);

        try {
            const media = await msg.downloadMedia();
            if (media) {
                // Determine extension and filename
                let extension = media.mimetype.split('/')[1]?.split(';')[0] || (msg.type === 'sticker' ? 'webp' : 'jpg');
                extension = extension.replace(/[^a-z0-9]/gi, ''); // Sanitize extension
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
    const OFENSIVAS = ['puto', 'puta', 'hdp', 'hijo de p', 'pito', 'chupa', 'idiota', 'estupido', 'mierda', 'verga', 'concha', 'tarado', 'salame', 'boludo', 'trolo', 'culo', 'pija', 'orto', 'mogolico', 'imbecil', 'cagada', 'basura', 'estafa', 'ladron', 'chorro'];
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
    let matched = false;

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


    // 2. Step Logic (Delegate to SalesModule)
    try {
        const dependencies = {
            client,
            notifyAdmin,
            saveState,
            sendMessageWithDelay,
            logAndEmit,
            saveOrderToLocal
        };

        const result = await processSalesFlow(userId, text, userState, knowledge, dependencies);

        if (result.matched) {
            matched = true;
        }

    } catch (e) {
        console.error("🔴 Error in Sales Flow:", e);
        matched = false;
    }

    // 3. Off-Script / Manual Fallback with AI
    if (!matched) {
        // ... (Existing AI Fallback)

        console.log(`[OFF-SCRIPT] Generating AI response for: ${text}`);
        // Log intent to use AI
        logAndEmit(userId, 'system', 'Triggering AI Smart Response', currentState.step);

        // Generating Response
        console.log(`[AI SMART] Requesting response for step: ${currentState.step}`);
        const aiData = await generateSmartResponse(text, currentState);

        if (aiData && aiData.response) {
            console.log(`[AI SMART RESULT] goalMet: ${aiData.goalMet}`);

            // If the AI confirms the user met the goal of the current step, advance the flow
            if (aiData.goalMet) {
                // Return to SCRIPT logic
                const currentStep = currentState.step;

                // Heuristic: Find the node that corresponds to this step
                const nodeRecord = Object.entries(knowledge.flow).find(([key, val]) => val.step === currentStep);
                const nextStep = nodeRecord ? nodeRecord[1].nextStep : null;

                if (nextStep) {
                    // Find the node for the NEXT step to get its script response
                    const nextNodeRecord = Object.entries(knowledge.flow).find(([key, val]) => key === nextStep || val.step === nextStep);
                    const nextNode = nextNodeRecord ? nextNodeRecord[1] : null;

                    if (nextNode) {
                        console.log(`[AI SUCCESS] Returning to script: ${nextStep}`);
                        await sendMessageWithDelay(userId, nextNode.response);
                        userState[userId].step = nextNode.nextStep || nextStep;
                        saveState();
                        return;
                    }
                }
            }

            // If goal NOT met (or script node found), send the AI's smart fallback response
            await sendMessageWithDelay(userId, aiData.response);
        } else {
            // SAFE FALLBACK: If AI fails (e.g. 429 or error), send a friendly generic message
            const fallbackMsg = "¡Hola! Perdón, estoy con muchas consultas en este momento. 😅 ¿Me podrías repetir tu pregunta o decirme cuántos kilos buscás bajar así te asesoro mejor? 🙏";
            await sendMessageWithDelay(userId, fallbackMsg);
        }
    }
}

// --- BACKUP SERVICE ---
const { performBackup } = require('./backupService');
setInterval(() => {
    performBackup();
}, 60 * 60 * 1000); // Every 1 hour

client.initialize().catch(err => {
    console.error("🔴 FAILURE DURING INITIALIZATION:", err);
});
