const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

// Import Modular Routes
const chatRoutes = require('./routes/chat.routes');
const orderRoutes = require('./routes/order.routes');
const adminRoutes = require('./routes/admin.routes');
const systemRoutes = require('./routes/system.routes');
const authRoutes = require('./routes/auth.routes');

function startServer(client, sharedState) {
    const { userState, sessionAlerts } = sharedState;

    // Validate sharedState
    if (!userState || !sessionAlerts) {
        console.error("❌ [SERVER] Critical: Shared State missing!");
    }

    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: process.env.DASHBOARD_URL || "http://localhost:5173",
            methods: ["GET", "POST"]
        }
    });

    // Share IO with global state so index.js can use it
    sharedState.io = io;

    // Middleware
    app.use(cors({
        origin: process.env.DASHBOARD_URL || "http://localhost:5173"
    }));
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../../public')));

    // --- MOUNT ROUTES ---
    // All API routes are mounted under /api to preserve existing contract
    app.use('/api', chatRoutes(client, sharedState));
    app.use('/api', orderRoutes(client, sharedState));
    app.use('/api', adminRoutes(client, sharedState));
    app.use('/api', systemRoutes(client, sharedState));
    app.use('/api', authRoutes(client, sharedState));

    // --- SOCKET SYNC ---
    io.on('connection', (socket) => {
        if (client && client.info) {
            socket.emit('ready', { info: client.info });
        }
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
    });

    return { io, app };
}

module.exports = { startServer };
