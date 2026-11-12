/**
 * Teléfono que está en Orders y vuelve a escribir (CHECK 1 de salesFlow).
 *
 * Regla vigente (rev 2026-11-12):
 *   - SOLO en __legacy_import__ (padrón histórico importado de Clientes_AR.txt):
 *     se lo atiende como a cualquier lead nuevo. Hasta el 12-nov-2026 se le
 *     mandaba un aviso de derivación y se lo pausaba.
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
    // La DB de mentira contesta como la real: el pedido legacy solo aparece si
    // la consulta incluye el namespace __legacy_import__.
    const legacyOnlyDb = ({ where }) => {
        const ids = typeof where.instanceId === 'string' ? [where.instanceId] : (where.instanceId?.in || []);
        return Promise.resolve(ids.includes('__legacy_import__') ? LEGACY_ORDER : null);
    };

    test.each([
        ['"quiero más información"', '¡Hola! Quiero más información.', '5493564578992@c.us'],
        ['saludo suelto', 'buenas', '5493564500001@c.us'],
    ])('legacy + %s → se lo atiende como a cualquier lead: saludo, sin pausa ni derivación', async (_n, text, userId) => {
        prisma.order.findFirst.mockImplementationOnce(legacyOnlyDb);
        const userState = {};
        const pausedUsers = new Set();
        const deps = makeDeps(pausedUsers);
        await processSalesFlow(userId, text, userState, knowledge, deps);
        expect(pausedUsers.has(userId)).toBe(false);
        expect(deps.notifyAdmin).not.toHaveBeenCalled();
        expect(greetingWasSent(deps)).toBe(true);
        expect(deps.sendMessageWithDelay).not.toHaveBeenCalledWith(userId, expect.stringMatching(/ya sos cliente/i));
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
