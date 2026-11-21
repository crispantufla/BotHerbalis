/**
 * Carga automática en el panel de ventas (botHelpers._autoPushSistema, 21-nov-2026;
 * viene del bot de Club Herbys): todo pedido que guarda el bot se manda solo al
 * panel, como el botón "Enviar a sistema". La DB del .env es la de producción y el
 * panel es real: `../db` va mockeado y el push es un doble inyectado.
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
const mockDb = {
    order: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    user: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
};
jest.mock('../db', () => ({ prisma: mockDb }));
const mockNotify = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/adminService', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));

const { createBotHelpers } = require('../src/handlers/botHelpers');

const ORDER = { cliente: '5493415550001@c.us', nombre: 'Ana Pérez', calle: 'Mitre 1234', ciudad: 'Rosario', cp: '2000', producto: 'Gotas', plan: '60', precio: '54.900', status: 'Confirmado' };

function setup({ sistema, io = true } = {}) {
    const emit = jest.fn();
    const sharedState = { io: io ? { to: jest.fn(() => ({ emit })) } : null, config: {} };
    const helpers = createBotHelpers({
        sellerId: 'horacio', sharedState, client: { info: { wid: { user: '5493412619394' } } },
        userState: {}, config: { alertNumbers: [] }, pausedUsers: new Set(),
        redlock: { acquire: jest.fn(async () => ({ release: jest.fn(async () => {}) })) },
        sistema,
    });
    return { helpers, emit };
}

/** Deja correr el guardado (asíncrono) y el setImmediate de la carga. */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

const ENV = { ...process.env };
beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ENV };
    mockDb.order.create.mockImplementation(async ({ data }) => data);
    mockDb.order.findUnique.mockImplementation(async ({ where }) => ({ id: where.id, status: 'Confirmado', sistemaOrderId: null, userPhone: '5493415550001', products: 'Gotas', totalPrice: 54900, createdAt: new Date() }));
    mockDb.order.update.mockImplementation(async ({ where, data }) => ({ id: where.id, userPhone: '5493415550001', products: 'Gotas', totalPrice: 54900, createdAt: new Date(), ...data }));
});
afterAll(() => { process.env = ENV; });

const fakeSistema = (over = {}) => ({
    isSistemaConfigured: jest.fn(() => true),
    pushOrderToSistema: jest.fn(async () => ({ orderId: 4321, pedidoId: 'x', duplicate: false })),
    ...over,
});

test('el pedido guardado se carga solo: queda con su número y "En sistema", y el panel se entera', async () => {
    const sistema = fakeSistema();
    const { helpers, emit } = setup({ sistema });
    helpers.saveOrderToLocal(ORDER);
    await settle();

    expect(mockDb.order.create).toHaveBeenCalledTimes(1);
    const id = mockDb.order.create.mock.calls[0][0].data.id;
    expect(sistema.pushOrderToSistema).toHaveBeenCalledTimes(1);
    expect(sistema.pushOrderToSistema.mock.calls[0][0].id).toBe(id);
    expect(mockDb.order.update).toHaveBeenCalledWith({
        where: { id },
        data: { sistemaOrderId: 4321, sistemaSyncedAt: expect.any(Date), status: 'En sistema' },
    });
    expect(emit.mock.calls.filter(c => c[0] === 'order_update').map(c => c[1].sistemaOrderId)).toEqual([4321, 4321]);
    expect(mockNotify).not.toHaveBeenCalled();
});

test('un pedido que ya salió no vuelve atrás de estado', async () => {
    mockDb.order.findUnique.mockResolvedValue({ id: 'x', status: 'Enviado', sistemaOrderId: null });
    const { helpers } = setup({ sistema: fakeSistema() });
    helpers.saveOrderToLocal(ORDER);
    await settle();
    expect(mockDb.order.update.mock.calls[0][0].data).not.toHaveProperty('status');
});

test('si ya estaba cargado no se manda de nuevo', async () => {
    mockDb.order.findUnique.mockResolvedValue({ id: 'x', status: 'En sistema', sistemaOrderId: 99 });
    const sistema = fakeSistema();
    const { helpers } = setup({ sistema });
    helpers.saveOrderToLocal(ORDER);
    await settle();
    expect(sistema.pushOrderToSistema).not.toHaveBeenCalled();
    expect(mockDb.order.update).not.toHaveBeenCalled();
});

test('si el panel falla, el pedido queda guardado y se avisa para cargarlo a mano', async () => {
    const sistema = fakeSistema({ pushOrderToSistema: jest.fn(async () => { throw new Error('El panel no responde'); }) });
    const { helpers } = setup({ sistema });
    helpers.saveOrderToLocal(ORDER);
    await settle();
    expect(mockDb.order.create).toHaveBeenCalledTimes(1);
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toMatch(/sin cargar en el panel de ventas/);
    expect(mockNotify.mock.calls[0][2]).toMatch(/Enviar a sistema.*El panel no responde/s);
});

test('sin panel configurado no intenta nada ni molesta al admin', async () => {
    const sistema = fakeSistema({ isSistemaConfigured: jest.fn(() => false) });
    const { helpers } = setup({ sistema });
    helpers.saveOrderToLocal(ORDER);
    await settle();
    expect(sistema.pushOrderToSistema).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
});

test('SISTEMA_AUTO_PUSH=0 la apaga', async () => {
    process.env.SISTEMA_AUTO_PUSH = '0';
    const sistema = fakeSistema();
    const { helpers } = setup({ sistema });
    helpers.saveOrderToLocal(ORDER);
    await settle();
    expect(sistema.pushOrderToSistema).not.toHaveBeenCalled();
});

test('en los tests, sin doble inyectado, nunca sale al panel real', async () => {
    process.env.SISTEMA_URL = 'https://panel.example';
    process.env.SISTEMA_TOKEN = 'x';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
    const { helpers } = setup();
    helpers.saveOrderToLocal(ORDER);
    await settle();
    expect(mockDb.order.create).toHaveBeenCalledTimes(1);
    expect(mockDb.order.findUnique).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
});
