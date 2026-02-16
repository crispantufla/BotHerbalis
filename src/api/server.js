const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { appendOrderToSheet } = require('../../sheets_sync');
const { atomicWriteFile } = require('../../safeWrite');

// Constants
const ORDERS_FILE = path.join(__dirname, '../../orders.json');
const summaryCache = new Map(); // Store summaries: chatId -> { text, timestamp }

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function startServer(client) {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"]
        }
    });

    // Middleware
    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../../public')));

    // 1. Health Check
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    });

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

        atomicWriteFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
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
            const history = await client.getChatById(chatId).then(c => c.fetchMessages({ limit: 10 }));
            const formattedHistory = history.map(m => `${m.fromMe ? 'Bot' : 'Usuario'}: ${m.body}`).join('\n');

            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            const prompt = `Resumí en una sola oración súper concisa (máximo 12 palabras) el estado de esta conversación de venta de Herbalis.
            Enfocate en: ¿Qué quiere el cliente? ¿Qué eligió? ¿Dio sus datos?
            Chat:\n${formattedHistory}`;

            const result = await model.generateContent(prompt);
            const summary = result.response.text().trim();

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
        } else {
            // Pass QR code mechanism? 
            // In original index.js, qrCodeData is global.
            // We might need to expose a way to emit QR from index.js
        }
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
    });

    return { io, app };
}

module.exports = { startServer };
