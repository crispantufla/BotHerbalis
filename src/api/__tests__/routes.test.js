const request = require('supertest');
const express = require('express');
const systemRoutes = require('../routes/system.routes');
const chatRoutes = require('../routes/chat.routes');

// Mock sheets_sync to avoid ESM issues with google-spreadsheet
jest.mock('../../../sheets_sync', () => ({
    appendOrderToSheet: jest.fn().mockResolvedValue(true)
}));

// Mock Auth Middleware to bypass key check for tests
jest.mock('../../middleware/auth', () => ({
    authMiddleware: (req, res, next) => next()
}));

describe('System Routes', () => {
    let app;
    let clientMock;
    let sharedStateMock;

    beforeEach(() => {
        app = express();
        app.use(express.json());

        clientMock = {
            info: { wid: { user: '123' }, pushname: 'TestBot' },
            getChats: jest.fn().mockResolvedValue([]),
        };

        sharedStateMock = {
            isConnected: true,
            qrCodeData: null,
            config: { alertNumbers: [] },
            sessionAlerts: [],
            userState: {},
            pausedUsers: new Set(),
            io: { emit: jest.fn() }
        };

        const router = systemRoutes(clientMock, sharedStateMock);
        app.use('/api', router);
    });

    it('GET /api/health returns ok', async () => {
        const res = await request(app).get('/api/health');
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('GET /api/status returns ready when connected', async () => {
        const res = await request(app).get('/api/status');
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ready');
        expect(res.body.info).toBeDefined();
    });
});

describe('Chat Routes', () => {
    let app;
    let clientMock;
    let sharedStateMock;

    beforeEach(() => {
        app = express();
        app.use(express.json());

        clientMock = {
            getChats: jest.fn().mockResolvedValue([
                { id: { _serialized: '123@c.us', user: '123' }, name: 'Test User', unreadCount: 0, timestamp: 1234567890 }
            ]),
        };

        sharedStateMock = {
            userState: {},
            pausedUsers: new Set(),
        };

        const router = chatRoutes(clientMock, sharedStateMock);
        app.use('/api', router);
    });

    it('GET /api/chats returns chat list', async () => {
        const res = await request(app).get('/api/chats');
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body[0].id).toBe('123@c.us');
    });
});
