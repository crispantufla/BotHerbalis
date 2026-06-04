/**
 * Teléfono que está en Orders y vuelve a escribir (CHECK 1 de salesFlow).
 *
 * Regla vigente (rev 2026-06-04, reporte 5493564578992):
 *   - SOLO en __legacy_import__ (padrón histórico importado de Clientes_AR.txt):
 *     es un CLIENTE VIEJO → el bot NO lo atiende, se PAUSA y se alerta al admin
 *     para que lo tome un humano.
 *   - Comprador REAL del seller (Order con instanceId del seller):
 *       · CON intención de compra → recompra: NO pausa, salta a waiting_weight.
 *       · SIN intención de compra → pausa como post-venta (lo atiende un humano).
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

// DB mock. order.findFirst se sobreescribe por test con mockResolvedValueOnce
// según el escenario (legacy vs comprador real). chatLog vacío para que el
// CHECK 2 (historial) no interfiera.
jest.mock('../db', () => ({
    prisma: {
        order: { findFirst: jest.fn() },
        chatLog: { findMany: jest.fn().mockResolvedValue([]) },
        user: { upsert: jest.fn().mockResolvedValue({}) },
    },
}));

const { prisma } = require('../db');
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v7.json'), 'utf8'));

const LEGACY_ORDER = { instanceId: '__legacy_import__', products: 'Cliente histórico (import 2026-05-30)', status: 'Importado' };
const REAL_ORDER = { instanceId: 'horacio', products: 'Cápsulas de nuez de la india', status: 'Confirmado' };

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

function greetingWasSent(deps) {
    return deps.sendMessageWithDelay.mock.calls.some(([, msg]) => /Elena/i.test(msg || ''));
}

describe('CHECK 1 — contacto del padrón histórico (import legacy) que escribe', () => {
    test('legacy + "quiero más información" → PAUSA + alerta admin (no saluda, no fast-track)', async () => {
        prisma.order.findFirst.mockResolvedValueOnce(LEGACY_ORDER);
        const userState = {};
        const pausedUsers = new Set();
        const userId = '5493564578992@c.us';
        const deps = makeDeps(pausedUsers);
        await processSalesFlow(userId, '¡Hola! Quiero más información.', userState, knowledge, deps);
        expect(pausedUsers.has(userId)).toBe(true);
        expect(deps.notifyAdmin).toHaveBeenCalled();
        expect(greetingWasSent(deps)).toBe(false);
        // Le avisa al cliente que lo deriva a atención al cliente (no lo deja en visto)
        expect(deps.sendMessageWithDelay).toHaveBeenCalledWith(userId, expect.stringMatching(/atenci[oó]n al cliente/i));
    });

    test('legacy + saludo suelto ("buenas") → PAUSA + alerta admin', async () => {
        prisma.order.findFirst.mockResolvedValueOnce(LEGACY_ORDER);
        const userState = {};
        const pausedUsers = new Set();
        // Número distinto al test anterior: el alerta admin tiene debounce a nivel
        // módulo (pauseService.adminNotifiedAt) keyed por sellerId:userId.
        const userId = '5493564500001@c.us';
        const deps = makeDeps(pausedUsers);
        await processSalesFlow(userId, 'buenas', userState, knowledge, deps);
        expect(pausedUsers.has(userId)).toBe(true);
        expect(deps.notifyAdmin).toHaveBeenCalled();
        expect(deps.sendMessageWithDelay).toHaveBeenCalledWith(userId, expect.stringMatching(/atenci[oó]n al cliente/i));
    });
});

describe('CHECK 1 — comprador REAL del seller que vuelve', () => {
    test('comprador real + intención de compra → NO pausa, salta a waiting_weight (recompra)', async () => {
        prisma.order.findFirst.mockResolvedValueOnce(REAL_ORDER);
        const userState = {};
        const pausedUsers = new Set();
        const userId = '5493876833907@c.us';
        await processSalesFlow(userId, 'Hola, quiero comprar de nuevo, qué precio las cápsulas?', userState, knowledge, makeDeps(pausedUsers));
        expect(pausedUsers.has(userId)).toBe(false);
        expect(userState[userId].step).not.toBe('completed');
        expect(userState[userId].isReturningClient).toBe(true);
    });

    test('comprador real + SIN intención de compra ("buenas") → pausa como post-venta', async () => {
        prisma.order.findFirst.mockResolvedValueOnce(REAL_ORDER);
        const userState = {};
        const pausedUsers = new Set();
        const userId = '5493876833907@c.us';
        await processSalesFlow(userId, 'buenas', userState, knowledge, makeDeps(pausedUsers));
        expect(pausedUsers.has(userId)).toBe(true);
    });
});
