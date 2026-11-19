/**
 * Pestaña Ventas compartida entre los dos bots (services/peerOrders.ts, 19-nov-2026):
 * GET /orders mezcla los pedidos propios con los del otro bot, cada uno marcado
 * con su bot, y GET /peer/orders le entrega los propios al otro con el secreto
 * compartido. La DB del .env es la de producción: `../db` va mockeado entero.
 */
const mockDb = {
    order: { count: jest.fn(), findMany: jest.fn() },
    user: { findMany: jest.fn(async () => []) },
};
jest.mock('../db', () => ({ prisma: mockDb }));
jest.mock('../src/api/routes/routeHelpers', () => ({
    ...jest.requireActual('../src/api/routes/routeHelpers'),
    withSeller: () => [],
    getInstanceId: (req) => req.sellerId || null,
}));
jest.mock('../src/services/ai', () => ({ aiService: {} }));

const peerOrders = require('../src/services/peerOrders');
const buildRouter = require('../src/api/routes/order.routes');

const router = buildRouter({});
const handlerOf = (path) => router.stack
    .find(l => l.route && l.route.path === path && l.route.methods.get)
    .route.stack.slice(-1)[0].handle;

async function call(path, req) {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (code) => { res.statusCode = code; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    await handlerOf(path)({ query: {}, headers: {}, ...req }, res);
    return res;
}

const row = (id, iso, over = {}) => ({
    id, instanceId: 'horacio', userPhone: '5493410000001', status: 'Pendiente', products: 'Gotas', totalPrice: 54900,
    createdAt: new Date(iso), ...over,
});
const peerRow = (id, iso) => ({ id, instanceId: 'clubherbys', cliente: '5493410000002', status: 'Pendiente', createdAt: iso, bot: 'Club Herbys' });

const ENV = { ...process.env };
let fetchSpy;
beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ENV, BOT_NAME: 'Herbalis', PEER_BOT_URL: 'https://otro.example/', PEER_BOT_TOKEN: 'secreto-compartido' };
    mockDb.order.count.mockResolvedValue(2);
    mockDb.order.findMany.mockResolvedValue([row('a', '2026-11-19T12:00:00Z'), row('c', '2026-11-17T12:00:00Z')]);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true, status: 200,
        json: async () => ({ bot: 'Club Herbys', total: 1, data: [peerRow('b', '2026-11-18T12:00:00.000Z')] }),
    });
});
afterEach(() => { fetchSpy.mockRestore(); process.env = { ...ENV }; });

describe('GET /orders con el otro bot configurado', () => {
    test('mezcla por fecha, marca cada pedido con su bot y los ajenos como de solo lectura', async () => {
        const res = await call('/orders', { query: { page: '1', limit: '50' }, account: { role: 'admin' } });
        expect(res.body.data.map(o => [o.id, o.bot, !!o.peer])).toEqual([
            ['a', 'Herbalis', false],
            ['b', 'Club Herbys', true],
            ['c', 'Herbalis', false],
        ]);
        expect(res.body.pagination).toMatchObject({ total: 3, page: 1, totalPages: 1 });
        expect(res.body.peer).toEqual({ ok: true, bot: 'Club Herbys' });

        const [url, opts] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://otro.example/api/peer/orders?take=50');
        expect(opts.headers['x-peer-token']).toBe('secreto-compartido');
    });

    test('la página 2 sale de los primeros page*limit de cada lado', async () => {
        const res = await call('/orders', { query: { page: '2', limit: '2' }, account: { role: 'admin' } });
        expect(mockDb.order.findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 4 });
        expect(fetchSpy.mock.calls[0][0]).toMatch(/take=4/);
        expect(res.body.data.map(o => o.id)).toEqual(['c']);
    });

    test('búsqueda, estado y vendedor elegido por el admin viajan al otro bot', async () => {
        await call('/orders', { query: { search: 'funes', status: 'Enviado', instanceId: 'clubherbys' }, account: { role: 'admin' } });
        const url = new URL(fetchSpy.mock.calls[0][0]);
        expect(Object.fromEntries(url.searchParams)).toEqual({ take: '100', search: 'funes', status: 'Enviado', instanceId: 'clubherbys' });
    });

    test('si el otro bot no contesta, salen los propios y el panel se entera', async () => {
        fetchSpy.mockRejectedValue(new Error('timeout'));
        const res = await call('/orders', { account: { role: 'admin' } });
        expect(res.statusCode).toBe(200);
        expect(res.body.data.map(o => o.id)).toEqual(['a', 'c']);
        expect(res.body.peer).toEqual({ ok: false, bot: null });
    });

    test('sin PEER_BOT_URL el listado es el de siempre y no sale a ningún lado', async () => {
        delete process.env.PEER_BOT_URL;
        const res = await call('/orders', { query: { page: '2', limit: '50' }, account: { role: 'admin' } });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(mockDb.order.findMany.mock.calls[0][0]).toMatchObject({ skip: 50, take: 50 });
        expect(res.body.peer).toBeUndefined();
        expect(res.body.data.every(o => o.bot === 'Herbalis' && !o.peer)).toBe(true);
    });
});

describe('GET /peer/orders', () => {
    test('con el secreto entrega los pedidos propios y el nombre del bot', async () => {
        const res = await call('/peer/orders', { headers: { 'x-peer-token': 'secreto-compartido' }, query: { take: '10', status: 'Pendiente' } });
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ bot: 'Herbalis', total: 2 });
        expect(res.body.data.map(o => o.id)).toEqual(['a', 'c']);
        expect(mockDb.order.findMany.mock.calls[0][0]).toMatchObject({
            where: { instanceId: { notIn: ['__legacy_import__'] }, status: 'Pendiente' }, skip: 0, take: 10,
        });
    });

    test.each([[undefined], ['otro-secreto'], ['']])('token %p → 401 y no toca la base', async (token) => {
        const res = await call('/peer/orders', { headers: token === undefined ? {} : { 'x-peer-token': token } });
        expect(res.statusCode).toBe(401);
        expect(mockDb.order.findMany).not.toHaveBeenCalled();
    });

    test('sin PEER_BOT_TOKEN la ruta no existe', async () => {
        delete process.env.PEER_BOT_TOKEN;
        const res = await call('/peer/orders', { headers: { 'x-peer-token': 'secreto-compartido' } });
        expect(res.statusCode).toBe(404);
    });

    test('el padrón importado no sale aunque lo pidan por nombre', async () => {
        const res = await call('/peer/orders', { headers: { 'x-peer-token': 'secreto-compartido' }, query: { instanceId: '__legacy_import__' } });
        expect(res.body.data).toEqual([]);
        expect(mockDb.order.findMany).not.toHaveBeenCalled();
    });
});

test('mergeOrderPage ordena por fecha y tolera fechas rotas', () => {
    const page = peerOrders.mergeOrderPage(
        [{ id: 'x', createdAt: '2026-11-10T00:00:00Z' }, { id: 'roto', createdAt: 'nada' }],
        [{ id: 'y', createdAt: '2026-11-12T00:00:00Z' }], 1, 10);
    expect(page.map(o => o.id)).toEqual(['y', 'x', 'roto']);
});
