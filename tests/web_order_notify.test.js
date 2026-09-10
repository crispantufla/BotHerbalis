/**
 * Confirmación por WhatsApp de pedidos de la tienda web (POST /web-orders/:id/notify).
 * Lo delicado es el teléfono: la clienta lo tipea libre en el checkout y hay que
 * llegar al formato de WhatsApp Argentina (549 + área + número).
 */
require('dotenv').config();
const {
    phoneCandidates, buildCustomerMessage, buildAdminMessage, pickInstance,
    resolveWhatsappId, notifyWebOrder,
} = require('../src/services/webOrderNotify');

const order = {
    id: '153eeca8-19e8-4d49-8591-a9c1d5311f0c',
    status: 'approved',
    items: [{ id: 'capsulas-120', name: 'Cápsulas', plan: 'Plan 120 días', qty: 1, unitPrice: 66900, lineTotal: 66900 }],
    total: 66900, shipping: 0,
    nombre: 'Marisa', apellido: 'García', email: 'marisa@example.com', telefono: '+54 9 341 261-9397',
    provincia: 'Santa Fe', ciudad: 'Rosario', calle: 'Mitre 1778', piso: '1B', cp: '2000', notas: null,
    mpPaymentId: '123456789', paidAt: new Date('2026-09-10T19:30:00Z'), createdAt: new Date('2026-09-10T19:29:00Z'),
    whatsappNotifiedAt: null,
};

describe('phoneCandidates', () => {
    test('formato internacional con 9 → tal cual', () => {
        expect(phoneCandidates('+54 9 341 261-9397')[0]).toBe('5493412619397');
    });
    test('área + número (10 dígitos) → agrega 549', () => {
        expect(phoneCandidates('341 261 9397')[0]).toBe('5493412619397');
        expect(phoneCandidates('11 5555 5555')[0]).toBe('5491155555555');
    });
    test('0 de área y 15 de celular se quitan', () => {
        expect(phoneCandidates('0341 15 261 9397')[0]).toBe('5493412619397');
        expect(phoneCandidates('011 15 5555 5555')[0]).toBe('5491155555555');
    });
    test('54 sin 9 → se agrega el 9', () => {
        expect(phoneCandidates('54 341 261 9397')[0]).toBe('5493412619397');
    });
    test('el fijo (54 sin 9) queda como último recurso', () => {
        const c = phoneCandidates('3412619397');
        expect(c[c.length - 1]).toBe('543412619397');
    });
    test('vacío o basura → sin candidatos', () => {
        expect(phoneCandidates('')).toEqual([]);
        expect(phoneCandidates(null)).toEqual([]);
        expect(phoneCandidates('abc')).toEqual([]);
    });
});

describe('mensajes', () => {
    test('a la clienta: nombre, n° corto, ítems, total, dirección', () => {
        const m = buildCustomerMessage(order);
        expect(m).toContain('¡Hola Marisa!');
        expect(m).toContain('#153EECA8');
        expect(m).toContain('Cápsulas · Plan 120 días ×1 — $66.900');
        expect(m).toContain('Total: *$66.900* (envío gratis)');
        expect(m).toContain('Mitre 1778, 1B · Rosario, Santa Fe · CP 2000');
        expect(m).not.toMatch(/\{\{/);
    });
    test('al admin: contacto, dirección, MP y a quién se envió', () => {
        const m = buildAdminMessage(order, '5493412619397@c.us');
        expect(m).toContain('Nueva venta web');
        expect(m).toContain('Marisa García · +54 9 341 261-9397 · marisa@example.com');
        expect(m).toContain('#123456789');
        expect(m).toContain('enviada por WhatsApp a 5493412619397');
    });
});

describe('pickInstance', () => {
    const mk = (sellerId, connected) => ({ sellerId, client: {}, sharedState: { isConnected: connected, config: {} } });
    test('prefiere WEB_ORDERS_SELLER si está conectado', () => {
        const pool = { getSeller: (id) => (id === 'horacio' ? mk('horacio', true) : undefined), getAllSellers: () => [mk('ines', true)] };
        expect(pickInstance(pool, 'Horacio').sellerId).toBe('horacio');
    });
    test('cae al primer conectado si el preferido no está', () => {
        const pool = { getSeller: () => mk('horacio', false), getAllSellers: () => [mk('x', false), mk('ines', true)] };
        expect(pickInstance(pool, 'horacio').sellerId).toBe('ines');
    });
    test('null si nadie está conectado', () => {
        expect(pickInstance({ getAllSellers: () => [mk('a', false)] })).toBeNull();
    });
});

describe('resolveWhatsappId', () => {
    test('usa getNumberId cuando existe y prueba candidatos en orden', async () => {
        const client = { getNumberId: jest.fn(async (n) => (n === '5493412619397' ? { _serialized: '5493412619397@c.us' } : null)) };
        const r = await resolveWhatsappId(client, ['5493412619397', '543412619397']);
        expect(r).toEqual({ chatId: '5493412619397@c.us', verified: true });
    });
    test('cliente remoto sin getNumberId → mejor apuesta sin verificar', async () => {
        const r = await resolveWhatsappId({}, ['5493412619397']);
        expect(r).toEqual({ chatId: '5493412619397@c.us', verified: false });
    });
});

describe('notifyWebOrder', () => {
    const mkPrisma = (row, claimCount = 1) => ({
        webOrder: {
            findUnique: jest.fn(async () => row),
            updateMany: jest.fn(async () => ({ count: claimCount })),
            update: jest.fn(async () => row),
        },
    });
    const mkPool = (client) => ({
        getAllSellers: () => [{ sellerId: 'horacio', client, sharedState: { isConnected: true, config: { alertNumbers: ['5491100000000'] }, pausedUsers: new Set(), logAndEmit: jest.fn() } }],
    });

    test('envía a la clienta y a los admins, y reclama whatsappNotifiedAt', async () => {
        const client = { sendMessage: jest.fn(async () => ({ id: { _serialized: 'x' } })) };
        const prisma = mkPrisma(order);
        const r = await notifyWebOrder({ orderId: order.id, clientPool: mkPool(client), prisma });
        expect(r.ok).toBe(true);
        expect(r.sentTo).toBe('5493412619397@c.us');
        expect(r.adminsNotified).toBe(1);
        expect(prisma.webOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: order.id, whatsappNotifiedAt: null } }));
        expect(client.sendMessage).toHaveBeenCalledTimes(2);
        expect(client.sendMessage.mock.calls[0][0]).toBe('5493412619397@c.us');
        expect(client.sendMessage.mock.calls[1][0]).toBe('5491100000000@c.us');
    });
    test('segunda llamada → skipped (idempotente)', async () => {
        const client = { sendMessage: jest.fn() };
        const r = await notifyWebOrder({ orderId: order.id, clientPool: mkPool(client), prisma: mkPrisma({ ...order, whatsappNotifiedAt: new Date() }, 0) });
        expect(r).toMatchObject({ ok: true, skipped: 'already_notified' });
        expect(client.sendMessage).not.toHaveBeenCalled();
    });
    test('dryRun no envía ni escribe', async () => {
        const client = { sendMessage: jest.fn() };
        const prisma = mkPrisma(order);
        const r = await notifyWebOrder({ orderId: order.id, clientPool: mkPool(client), prisma, dryRun: true });
        expect(r.dryRun).toBe(true);
        expect(r.customerMessage).toContain('#153EECA8');
        expect(client.sendMessage).not.toHaveBeenCalled();
        expect(prisma.webOrder.updateMany).not.toHaveBeenCalled();
    });
    test('pedido no aprobado → 409', async () => {
        const r = await notifyWebOrder({ orderId: order.id, clientPool: mkPool({}), prisma: mkPrisma({ ...order, status: 'pending' }) });
        expect(r).toMatchObject({ ok: false, httpStatus: 409 });
    });
    test('si el envío falla, libera el reclamo', async () => {
        const client = { sendMessage: jest.fn(async () => { throw new Error('boom'); }) };
        const prisma = mkPrisma(order);
        const r = await notifyWebOrder({ orderId: order.id, clientPool: mkPool(client), prisma });
        expect(r).toMatchObject({ ok: false, httpStatus: 502 });
        expect(prisma.webOrder.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { whatsappNotifiedAt: null } }));
    });
});
