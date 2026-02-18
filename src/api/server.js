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

    // Serve Static Files (Production/Docker)
    const clientDistPath = path.join(__dirname, '../../client/dist');
    if (require('fs').existsSync(clientDistPath)) {
        app.use(express.static(clientDistPath));
        console.log(`✅ Serving static files from: ${clientDistPath}`);
    } else {
        // Fallback for local development if dist doesn't exist yet
        app.use(express.static(path.join(__dirname, '../../public')));
        console.log(`ℹ️ Client build not found. Serving public folder only.`);
    }

    // --- MOUNT ROUTES ---
    // All API routes are mounted under /api to preserve existing contract
    app.use('/api', chatRoutes(client, sharedState));
    app.use('/api', orderRoutes(client, sharedState));
    app.use('/api', adminRoutes(client, sharedState));
    app.use('/api', systemRoutes(client, sharedState));
    app.use('/api', authRoutes(client, sharedState));

    // Handle React Routing, return all requests to React app
    // Express 5: using regex or * should work, but let's try a catch-all middleware at the end
    app.use((req, res, next) => {
        if (req.method !== 'GET') return next();

        const clientDistPath = path.join(__dirname, '../../client/dist');
        const indexPath = path.join(clientDistPath, 'index.html');

        if (require('fs').existsSync(indexPath)) {
            res.sendFile(indexPath);
        } else {
            next(); // Allow 404 handler to take over if index doesn't exist
        }
    });

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
