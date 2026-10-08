/**
 * Campañas promo — la audiencia (oct-2026).
 *
 * Últimos 6 meses menos los últimos 30 días, sin compradores. La memoria de
 * más de un mes es FunnelEvent (User.profileData y ChatLog se purgan): un
 * teléfono que solo dejó rastro en el embudo ENTRA, sin nombre.
 */
const mockDb = {
    funnelEvent: { groupBy: jest.fn(), findMany: jest.fn() },
    user: { findMany: jest.fn() },
    order: { findMany: jest.fn() },
    promoRecipient: { findMany: jest.fn() },
};
jest.mock('../db', () => ({ prisma: mockDb }));

const { selectPromoAudience, normalizeAudienceFilters, DEFAULT_AUDIENCE_FILTERS } = require('../src/services/promo/promoAudience');

const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY);
const state = (over) => JSON.stringify({ step: 'waiting_plan_choice', history: [{ role: 'user', content: 'hola', timestamp: 1 }], ...over });

function setup({ funnel = [], users = [], orders = [], promos = [] }) {
    mockDb.funnelEvent.groupBy.mockResolvedValue(funnel.map(f => ({ phone: f.phone, _max: { enteredAt: f.at } })));
    mockDb.funnelEvent.findMany.mockResolvedValue(funnel.map(f => ({ phone: f.phone, stepTo: f.step || 'waiting_weight', exitType: f.exit || null, enteredAt: f.at })));
    mockDb.user.findMany.mockResolvedValue(users);
    mockDb.order.findMany.mockResolvedValue(orders.map(p => ({ userPhone: p })));
    mockDb.promoRecipient.findMany.mockResolvedValue(promos.map(p => ({ phone: p })));
}
const run = (raw = {}) => selectPromoAudience(normalizeAudienceFilters('horacio', raw));
const phones = (r) => r.members.map(m => m.phone).sort();

beforeEach(() => jest.clearAllMocks());

describe('defaults', () => {
    test('30 a 180 días', () => {
        expect(DEFAULT_AUDIENCE_FILTERS.minDaysSinceLastSeen).toBe(30);
        expect(DEFAULT_AUDIENCE_FILTERS.maxDaysSinceLastSeen).toBe(180);
    });
});

describe('selectPromoAudience', () => {
    test('entra quien solo dejó rastro en el embudo hace 3 meses; queda sin nombre', async () => {
        setup({ funnel: [{ phone: '5493410000001', at: ago(90), step: 'waiting_plan_choice' }] });
        const r = await run();
        expect(phones(r)).toEqual(['5493410000001']);
        expect(r.members[0]).toEqual(expect.objectContaining({ name: null, step: 'waiting_plan_choice', source: 'funnel' }));
        expect(r.summary.bySource).toEqual({ funnel: 1 });
    });

    test('quien escribió hace menos de 30 días NO entra (puede tener un pedido en curso)', async () => {
        setup({ funnel: [{ phone: '5493410000002', at: ago(10) }, { phone: '5493410000003', at: ago(45) }] });
        const r = await run();
        expect(phones(r)).toEqual(['5493410000003']);
        expect(r.summary.excluded.contacto_reciente).toBe(1);
    });

    test('el rastro más reciente manda: funnel viejo pero User reciente → afuera', async () => {
        setup({
            funnel: [{ phone: '5493410000004', at: ago(100) }],
            users: [{ phone: '5493410000004', lastSeen: ago(5), pausedAt: null, profileData: state() }],
        });
        const r = await run();
        expect(phones(r)).toEqual([]);
        expect(r.summary.excluded.contacto_reciente).toBe(1);
    });

    test('más de 180 días → afuera', async () => {
        setup({ funnel: [{ phone: '5493410000005', at: ago(200) }] });
        // groupBy ya filtra por fecha en la DB; acá el mock lo devuelve igual y el filtro en memoria lo descarta.
        const r = await run();
        expect(phones(r)).toEqual([]);
    });

    test('compradores (seller o padrón importado), pausados, rechazos y compras del embudo quedan afuera', async () => {
        setup({
            funnel: [
                { phone: '5493410000010', at: ago(60) },
                { phone: '5493410000011', at: ago(60) },
                { phone: '5493410000012', at: ago(60), step: 'rejected_medical' },
                { phone: '5493410000013', at: ago(60), step: 'completed', exit: 'completed' },
                { phone: '5493410000014', at: ago(60) },
            ],
            users: [{ phone: '5493410000011', lastSeen: ago(60), pausedAt: ago(59), profileData: state() }],
            orders: ['5493410000010'],
        });
        const r = await run();
        expect(phones(r)).toEqual(['5493410000014']);
        expect(r.summary.excluded).toEqual(expect.objectContaining({ ya_compro: 1, pausado: 1, estado_terminal: 2 }));
    });

    test('con estado guardado: trae nombre y step; sin mensajes del cliente ni embudo → afuera; con pedido a medio armar → afuera', async () => {
        setup({
            users: [
                { phone: '5493410000020', lastSeen: ago(40), pausedAt: null, profileData: state({ userName: 'Lola', step: 'waiting_data' }) },
                { phone: '5493410000021', lastSeen: ago(40), pausedAt: null, profileData: state({ history: [] }) },
                { phone: '5493410000022', lastSeen: ago(40), pausedAt: null, profileData: state({ pendingOrder: { x: 1 } }) },
            ],
        });
        const r = await run();
        expect(phones(r)).toEqual(['5493410000020']);
        expect(r.members[0]).toEqual(expect.objectContaining({ name: 'Lola', step: 'waiting_data', source: 'state' }));
        expect(r.summary.excluded).toEqual(expect.objectContaining({ sin_conversacion: 1, pedido_en_curso: 1 }));
    });

    test('ya promocionados en el enfriamiento o que pidieron no recibir → afuera', async () => {
        setup({ funnel: [{ phone: '5493410000030', at: ago(60) }, { phone: '5493410000031', at: ago(60) }], promos: ['5493410000030'] });
        const r = await run();
        expect(phones(r)).toEqual(['5493410000031']);
    });

    test('admins excluidos y tope de destinatarios', async () => {
        setup({ funnel: ['1', '2', '3', '4'].map(i => ({ phone: `549341000004${i}`, at: ago(60) })) });
        const r = await run({ limit: 2, excludePhones: ['5493410000041'] });
        expect(r.members).toHaveLength(2);
        expect(phones(r)).not.toContain('5493410000041');
        expect(r.summary.excluded.fuera_del_tope).toBe(1);
    });
});
