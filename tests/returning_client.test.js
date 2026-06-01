/**
 * Cliente histórico / post-venta que VUELVE a escribir (CHECK 1 de salesFlow).
 *
 * Regla (rev 2026-06-01, reporte 5493876833907): si un teléfono está en Orders
 * (del seller o en __legacy_import__) y vuelve a escribir:
 *   - CON intención de compra (precio, comprar, info…) → NO se pausa: se atiende
 *     como recompra, saltando el greeting (va a waiting_weight). Lead más tibio.
 *   - SIN intención de compra (post-venta puro: "no me llegó", saludo suelto) →
 *     se pausa como post-venta para que lo atienda un humano.
 */

const { processSalesFlow } = require('../src/flows/salesFlow');
const fs = require('fs');
const path = require('path');

jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: 'Los precios de las cápsulas son...', goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue(null),
    },
}));
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../sheets_sync', () => ({ appendOrderToSheet: jest.fn() }), { virtual: true });

// DB mock: el teléfono tiene una orden en el import legacy. chatLog vacío para
// que el CHECK 2 (historial) no interfiera.
jest.mock('../db', () => ({
    prisma: {
        order: {
            findFirst: jest.fn().mockResolvedValue({
                instanceId: '__legacy_import__',
                products: 'Cliente histórico (import 2026-05-30)',
                status: 'Importado',
            }),
        },
        chatLog: { findMany: jest.fn().mockResolvedValue([]) },
        user: { upsert: jest.fn().mockResolvedValue({}) },
    },
}));

const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v7.json'), 'utf8'));

function makeDeps(pausedUsers) {
    return {
        client: undefined,
        notifyAdmin: jest.fn().mockResolvedValue(undefined),
        saveState: jest.fn(),
        sendMessageWithDelay: jest.fn().mockResolvedValue(undefined),
        logAndEmit: jest.fn(),
        sharedState: { io: { emit: jest.fn() }, pausedUsers, sellerId: 'horacio' },
        sellerId: 'horacio',
        aiService: require('../src/services/ai').aiService,
    };
}

describe('CHECK 1 — cliente histórico que vuelve', () => {
    test('CON intención de compra ("quiero más información, qué precio") → NO pausa, va a waiting_weight', async () => {
        const userState = {};
        const pausedUsers = new Set();
        const userId = '5493876833907@c.us';
        await processSalesFlow(userId, 'Hola, quiero más información, qué precio las cápsulas?', userState, knowledge, makeDeps(pausedUsers));
        expect(pausedUsers.has(userId)).toBe(false);
        expect(userState[userId].step).not.toBe('completed');
        expect(userState[userId].isReturningClient).toBe(true);
    });

    test('SIN intención de compra (saludo suelto) → pausa como post-venta', async () => {
        const userState = {};
        const pausedUsers = new Set();
        const userId = '5493876833907@c.us';
        await processSalesFlow(userId, 'buenas', userState, knowledge, makeDeps(pausedUsers));
        expect(pausedUsers.has(userId)).toBe(true);
    });
});
