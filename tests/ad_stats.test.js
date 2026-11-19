/**
 * Estadísticas por anuncio (services/adStats.ts; test traído del bot de Club Herbys, 27-oct): contactos por anuncio,
 * hoy / 7 días, pedidos posteriores al contacto y conversión.
 */
const NOW = new Date('2026-10-27T18:00:00Z');   // 15:00 ARG
const d = (iso) => new Date(iso);

const mockLeads = [
    { phone: '5493410000001', sourceId: 'VID', title: 'Me preguntan qué hago', mediaType: 2, firstAt: d('2026-10-27T14:00:00Z') },   // hoy
    { phone: '5493410000002', sourceId: 'VID', title: 'Me preguntan qué hago', mediaType: 2, firstAt: d('2026-10-25T14:00:00Z') },
    { phone: '5493410000003', sourceId: 'VID', title: 'Me preguntan qué hago', mediaType: 2, firstAt: d('2026-10-10T14:00:00Z') },   // > 7 días
    { phone: '5493410000004', sourceId: 'IMG', title: 'Consultá ahora', mediaType: 1, firstAt: d('2026-10-27T02:00:00Z') },          // ayer 23 h ARG
    { phone: '5493410000005', sourceId: 'sin_anuncio', title: 'Sin anuncio (persona nueva)', mediaType: null, firstAt: d('2026-10-26T15:00:00Z') },
];
const mockOrders = [
    { userPhone: '5493410000002', createdAt: d('2026-10-25T16:00:00Z') },   // compró después del contacto
    { userPhone: '5493410000004', createdAt: d('2026-10-20T16:00:00Z') },   // pedido ANTERIOR al contacto: no cuenta
];
jest.mock('../db', () => ({
    prisma: {
        adLead: { findMany: jest.fn(async () => mockLeads), upsert: jest.fn().mockResolvedValue({}) },
        order: { findMany: jest.fn(async () => mockOrders) },
    },
}));

const { getAdStats, recordAdLead } = require('../src/services/adStats');
const { prisma } = require('../db');

test('cuenta contactos, hoy, 7 días, pedidos y conversión por anuncio', async () => {
    const rows = await getAdStats('horacio', 30, NOW);
    const by = Object.fromEntries(rows.map((r) => [r.sourceId, r]));
    expect(rows[0].sourceId).toBe('VID');   // ordenado por contactos
    expect(by.VID).toMatchObject({ title: 'Me preguntan qué hago', kind: 'video', leads: 3, today: 1, last7: 2, orders: 1, conversion: 33.3 });
    expect(by.IMG).toMatchObject({ kind: 'imagen', leads: 1, today: 0, orders: 0, conversion: 0 });
    expect(by.sin_anuncio).toMatchObject({ kind: 'sin anuncio', leads: 1 });
});

test('recordAdLead anota el anuncio, o "sin anuncio" para gente nueva, y nada más', () => {
    recordAdLead('horacio', '5493410000009@c.us', { ad: { sourceId: '120', title: 'X', mediaType: 2 } });
    recordAdLead('horacio', '5493410000008@c.us', { isNewChat: true });
    recordAdLead('horacio', '5493410000007@c.us', { isNewChat: false });
    const calls = prisma.adLead.upsert.mock.calls.map((c) => c[0].create.sourceId);
    expect(calls).toEqual(['120', 'sin_anuncio']);
});
