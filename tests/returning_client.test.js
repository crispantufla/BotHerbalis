/**
 * Teléfono que está en Orders y vuelve a escribir (CHECK 1 de salesFlow).
 *
 * Regla vigente (rev 2026-06-04, reporte 5493564578992):
 *   - SOLO en __legacy_import__ (lista fría importada de Clientes_AR.txt, NO un
 *     comprador real del bot) → se trata como LEAD NUEVO: recibe el saludo
 *     completo del guion (Elena), sin fast-track a waiting_weight ni pausa.
 *   - Comprador REAL del seller (Order con instanceId del seller):
 *       · CON intención de compra → recompra: NO pausa, salta a waiting_weight.
 *       · SIN intención de compra → pausa como post-venta (lo atiende un humano).
 *
 * Antes (rev 2026-06-01) el legacy también saltaba a waiting_weight / se pausaba,
 * y la IA respondía "¡Holaa de nuevo! ¿cuántos kilos?" en vez del saludo. Esa
 * regla para legacy se revirtió: un contacto importado es un lead, no un cliente.
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

describe('CHECK 1 — contacto del import legacy que escribe', () => {
    test('legacy + "quiero más información" → manda el SALUDO (no fast-track, no pausa)', async () => {
        prisma.order.findFirst.mockResolvedValueOnce(LEGACY_ORDER);
        const userState = {};
        const pausedUsers = new Set();
        const userId = '5493564578992@c.us';
        const deps = makeDeps(pausedUsers);
        await processSalesFlow(userId, '¡Hola! Quiero más información.', userState, knowledge, deps);
        expect(pausedUsers.has(userId)).toBe(false);
        expect(greetingWasSent(deps)).toBe(true);
        expect(userState[userId].isReturningClient).toBeFalsy();
    });

    test('legacy + saludo suelto ("buenas") → manda el SALUDO (no pausa)', async () => {
        prisma.order.findFirst.mockResolvedValueOnce(LEGACY_ORDER);
        const userState = {};
        const pausedUsers = new Set();
        const userId = '5493564578992@c.us';
        const deps = makeDeps(pausedUsers);
        await processSalesFlow(userId, 'buenas', userState, knowledge, deps);
        expect(pausedUsers.has(userId)).toBe(false);
        expect(greetingWasSent(deps)).toBe(true);
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
