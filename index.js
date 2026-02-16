require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { exec } = require('child_process'); // For sound
const { logMessage } = require('./logger'); // Import Logger
const { analyzeDailyLogs } = require('./analyze_day'); // Import Analyzer
const { appendOrderToSheet } = require('./sheets_sync');
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./safeWrite');
const { processSalesFlow } = require('./src/flows/salesFlow');
const { aiService } = require('./src/services/ai'); // Centralized AI
const { startServer } = require('./src/api/server'); // Centralized Server

// Paths
const STATE_FILE = path.join(__dirname, 'persistence.json');
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge.json');

// --- STATE MANAGEMENT ---
let knowledge = { flow: {}, faq: [] };
const userState = {};
let lastAlertUser = null;
let pausedUsers = new Set();
// Variables for API / Dashboard State
let qrCodeData = null;
let sessionAlerts = [];
let config = { alertNumbers: [] };
let isConnected = false;

// --- PERSISTENCE HELPERS ---
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

function saveKnowledge() {
    try {
        atomicWriteFile(KNOWLEDGE_FILE, JSON.stringify(knowledge, null, 2));
    } catch (e) {
        console.error('🔴 Error saving knowledge:', e.message);
    }
}

function saveState() {
    try {
        const stateToSave = {
            userState,
            lastAlertUser,
            pausedUsers: Array.from(pausedUsers),
            config
        };
        atomicWriteFile(STATE_FILE, JSON.stringify(stateToSave, null, 2));
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
            config = data.config || { alertNumbers: [] };
            // Migrate from old single alertNumber to array
            if (config.alertNumber && !config.alertNumbers) {
                config.alertNumbers = [config.alertNumber];
                delete config.alertNumber;
            }
            if (!config.alertNumbers) config.alertNumbers = [];
            console.log('✅ State loaded from persistence.json');
        }
    } catch (e) {
        console.error('🔴 Error loading state:', e.message);
    }
}

// Initial Load
loadKnowledge();
loadState();

// --- WHATSAPP CLIENT ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// --- SHARED STATE OBJECT ---
// This allows the API server to access and modify the bot's state
const sharedState = {
    userState,
    pausedUsers,
    sessionAlerts,
    config,
    knowledge,
    isConnected,
    qrCodeData,
    saveState,
    saveKnowledge,
    // Methods will be attached later
    handleAdminCommand: null,
    logAndEmit: null,
    io: null // Populated by startServer
};

// --- INITIALIZE SERVER ---
// Pass client and sharedState so Server can handle API routes
startServer(client, sharedState);

// Helper: Log and Emit to Dashboard (Now uses sharedState.io)
function logAndEmit(chatId, sender, text, step) {
    logMessage(chatId, sender, text, step);
    if (sharedState.io) {
        sharedState.io.emit('new_log', {
            timestamp: new Date(),
            chatId,
            sender,
            text,
            step
        });
    }
}
sharedState.logAndEmit = logAndEmit; // Expose to server

// Helper: Save Order Locally (for Dashboard)
function saveOrderToLocal(order) {
    let orders = [];
    if (fs.existsSync(ORDERS_FILE)) {
        try {
            orders = JSON.parse(fs.readFileSync(ORDERS_FILE));
        } catch (e) { orders = []; }
    }
    const newOrder = {
        id: Date.now().toString(),
        createdAt: new Date().toISOString(),
        status: 'Pendiente',
        tracking: '',
        ...order
    };
    orders.push(newOrder);
    atomicWriteFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
    if (sharedState.io) sharedState.io.emit('new_order', newOrder);
}

// Helper: Send with Delay
const sendMessageWithDelay = async (chatId, content) => {
    const delay = Math.floor(Math.random() * (4000 - 2000 + 1) + 2000);
    console.log(`[DELAY] Waiting ${delay / 1000}s before sending to ${chatId}`);

    if (userState[chatId]?.lastMessage === content) {
        const lines = content.split('\n').filter(l => l.trim());
        content = lines.length > 1 ? lines[lines.length - 1] : '¿Necesitás algo más? 😊';
    }

    if (userState[chatId]) userState[chatId].lastMessage = content;
    logAndEmit(chatId, 'bot', content, userState[chatId]?.step);

    setTimeout(async () => {
        try {
            await client.sendMessage(chatId, content);
            console.log(`[SENT] Message sent to ${chatId}`);
        } catch (e) {
            console.error(`[ERROR] Failed to send message: ${e}`);
        }
    }, delay);
};

// Helper: Notify Admin
async function notifyAdmin(reason, userPhone, details = null) {
    exec('powershell "[console]::beep(1000, 500)"', (err) => { if (err) console.error("Beep failed:", err); });
    console.error(`⚠️ [ADMIN ALERT] ${reason} (User: ${userPhone})`);

    const now = Date.now();
    const lastAlert = sessionAlerts[0];
    if (lastAlert && lastAlert.userPhone === userPhone && lastAlert.reason === reason && (now - lastAlert.id < 8000)) return;

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

    if (sharedState.io) sharedState.io.emit('new_alert', newAlert);

    if (config.alertNumbers && config.alertNumbers.length > 0) {
        const alertMsg = `⚠️ *ALERTA SISTEMA*\n\n*Motivo:* ${reason}\n*Cliente:* ${userPhone}\n*Detalles:* ${details || "Sin detalles"}`;
        for (const num of config.alertNumbers) {
            const targetAlert = `${num}@c.us`;
            client.sendMessage(targetAlert, alertMsg).catch(e => console.error(`[ALERT] Failed to forward to ${num}:`, e.message));
        }
    }
}

// Helper: Handle Admin Command (Exposed to API)
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

            // Clear alerts
            const index = sessionAlerts.findIndex(a => a.userPhone === actualTarget);
            if (index !== -1) sessionAlerts.splice(index, 1);
            return `✅ Resumen enviado a ${actualTarget}. Esperando aceptación legal.`;
        }
        return "⚠️ No hay pedido pendiente de aprobación.";
    }

    // 3. Pause
    if (lowerMsg.includes('lo manejo yo') || lowerMsg.includes('me encargo')) {
        const actualTarget = targetChatId || lastAlertUser;
        if (actualTarget) {
            pausedUsers.add(actualTarget);
            saveState();
            if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId: actualTarget, paused: true });
            return `✅ Bot pausado para ${actualTarget}`;
        }
        return "⚠️ No hay cliente para pausar.";
    }

    // 4. Resume
    if (lowerMsg.includes('reactivar') || lowerMsg.includes('activar bot')) {
        const actualTarget = targetChatId || lastAlertUser;
        if (actualTarget && pausedUsers.has(actualTarget)) {
            pausedUsers.delete(actualTarget);
            saveState();
            if (sharedState.io) sharedState.io.emit('bot_status_change', { chatId: actualTarget, paused: false });
            return `✅ Bot reactivado para ${actualTarget}`;
        }
        return "No hay clientes pausados.";
    }

    return "Comando no reconocido.";
}
sharedState.handleAdminCommand = handleAdminCommand; // Expose to server


if (!process.env.GEMINI_API_KEY) {
    console.error("❌ CRITICAL: GEMINI_API_KEY is missing in .env!");
} else {
    // Basic mask check log
    console.log(`✅ GEMINI_API_KEY initialized.`);
}

// --- CLIENT EVENTS ---

client.on('qr', (qr) => {
    console.log('ESCANEA ESTE CÓDIGO QR:');
    qrcode.generate(qr, { small: true });
    sharedState.qrCodeData = qr;
    if (sharedState.io) sharedState.io.emit('qr', qr);
});

client.on('ready', () => {
    console.log('¡Cliente WhatsApp Listo!');
    sharedState.isConnected = true;
    sharedState.qrCodeData = null;
    if (sharedState.io) sharedState.io.emit('ready', { info: client.info });
});

client.on('disconnected', (reason) => {
    console.log('🔴 Cliente desconectado:', reason);
    sharedState.isConnected = false;
    sharedState.qrCodeData = null;
    if (sharedState.io) sharedState.io.emit('status_change', { status: 'disconnected' });
    client.initialize().catch(err => console.error("🔴 Re-init failed:", err.message));
});

client.on('message', async msg => {
    if (msg.from === 'status@broadcast') return;
    const chat = await msg.getChat();
    // if (chat.isGroup) return; // Allow groups? usually no for sales bots.
    if (chat.isGroup) return;

    const userId = msg.from;
    const adminNumber = process.env.ADMIN_NUMBER;
    const cleanAdmin = adminNumber ? adminNumber.replace(/\D/g, '') : '';
    const isAdmin = msg.fromMe || (cleanAdmin && userId.startsWith(cleanAdmin));
    const msgText = (msg.body || '').trim();

    // --- ADMIN COMMANDS ---
    if (isAdmin) {
        if (!msgText) return;
        console.log(`[ADMIN] ${userId}: ${msgText}`);

        // 1. !saltear
        if (msgText.toLowerCase().startsWith('!saltear ')) {
            // ... existing logic ...
            const parts = msgText.split(' ');
            const targetNumber = parts[1];
            if (!targetNumber) return;
            const targetChatId = targetNumber.includes('@') ? targetNumber : `${targetNumber.replace(/\D/g, '')}@c.us`;
            if (!userState[targetChatId]) userState[targetChatId] = { step: 'greeting', partialAddress: {} };
            userState[targetChatId].step = 'waiting_data';
            saveState();
            await client.sendMessage(targetChatId, knowledge.flow.data_request.response);
            await client.sendMessage(msg.from, `✅ Usuario ${targetNumber} forzado.`);
            return;
        }

        // 2. !ayuda
        if (msgText.toLowerCase() === '!ayuda') {
            await client.sendMessage(msg.from, `📋 *Comandos*: !resumen, !saltear, "ok", "me encargo"`);
            return;
        }

        // 3. Natural Language Admin
        const result = await handleAdminCommand(lastAlertUser, msgText);
        if (result === "Comando no reconocido." && lastAlertUser) {
            // AI SUGGESTION
            const history = (userState[lastAlertUser]?.history || [])
                .map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
            const suggestion = await aiService.generateSuggestion(msgText, history);

            await client.sendMessage(lastAlertUser, suggestion);
            logAndEmit(lastAlertUser, 'admin', suggestion, 'admin_instruction');
            await client.sendMessage(msg.from, `✅ Enviado a ${lastAlertUser}:\n"${suggestion}"`);
        } else {
            await client.sendMessage(msg.from, result);
        }
        return;
    }

    // --- USER MESSAGES ---

    // 1. Media Handling (Audio)
    if (msg.hasMedia || msg.type === 'ptt' || msg.type === 'audio') {
        const media = await msg.downloadMedia();
        if (media) {
            const transcription = await aiService.transcribeAudio(media.data, media.mimetype);
            if (transcription) {
                console.log(`[AUDIO] Transcribed: "${transcription}"`);
                await processSalesFlow(userId, transcription, userState, knowledge, {
                    client, notifyAdmin, saveState, sendMessageWithDelay, logAndEmit, saveOrderToLocal
                });
            } else {
                await client.sendMessage(userId, "Disculpá, no pude escuchar bien el audio. ¿Me lo escribís?");
            }
        }
        return;
    }

    if (!msgText) return;

    // 2. Logging
    logAndEmit(userId, 'user', msgText, userState[userId]?.step || 'new');

    // 3. Paused Check
    if (pausedUsers.has(userId)) {
        console.log(`[PAUSED] Ignoring message from ${userId}`);
        return;
    }

    // 4. Process Flow
    await processSalesFlow(userId, msgText, userState, knowledge, {
        client, notifyAdmin, saveState, sendMessageWithDelay, logAndEmit, saveOrderToLocal
    });
});


client.initialize();
