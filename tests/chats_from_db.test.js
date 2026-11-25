/**
 * _buildChatsFromDb (lista de chats del panel cuando no se le pide getChats() a
 * WhatsApp): `lastMessage.fromMe` dice quién habló último, y las filas 'system'
 * no cuentan como mensaje de nadie. El filtro "Sin responder" del panel sale de ahí.
 *
 * La DB del .env es la de producción: `../db` va mockeado y a la función se le
 * pasa un prisma falso por parámetro.
 */
jest.mock('../db', () => ({ prisma: {} }));
jest.mock('../src/services/ai', () => ({ aiService: {} }));
jest.mock('whatsapp-web.js', () => ({ MessageMedia: class {} }));

const { _buildChatsFromDb } = require('../src/api/routes/chat.routes');

const SELLER = 'horacio';
const T = (min) => new Date(Date.UTC(2026, 10, 25, 12, min));
const row = (userPhone, role, content, min) => ({ userPhone, role, content, timestamp: T(min) });

// Como la query real: ordenado por timestamp desc.
function fakePrisma(logs, users = []) {
    const sorted = [...logs].sort((a, b) => b.timestamp - a.timestamp);
    return {
        chatLog: { findMany: jest.fn(async () => sorted) },
        user: { findMany: jest.fn(async () => users) },
    };
}

const byId = (chats, phone) => chats.find(c => c.id === `${phone}@c.us`);

describe('_buildChatsFromDb: quién habló último', () => {
    test('último mensaje del cliente → fromMe false', async () => {
        const chats = await _buildChatsFromDb(fakePrisma([
            row('549111', 'bot', 'Hola', 10),
            row('549111', 'user', '¿hacen envíos?', 30),
        ]), SELLER, {}, []);
        expect(byId(chats, '549111').lastMessage).toEqual({
            body: '¿hacen envíos?', timestamp: T(30).getTime(), fromMe: false,
        });
    });

    test('último mensaje del bot o de una persona del equipo → fromMe true', async () => {
        const chats = await _buildChatsFromDb(fakePrisma([
            row('549111', 'user', 'hola', 10), row('549111', 'bot', 'Te paso los precios', 30),
            row('549222', 'user', 'hola', 11), row('549222', 'admin', 'Ya te lo mando', 31),
        ]), SELLER, {}, []);
        expect(byId(chats, '549111').lastMessage.fromMe).toBe(true);
        expect(byId(chats, '549222').lastMessage.fromMe).toBe(true);
    });

    test('una fila system posterior no tapa el último mensaje real', async () => {
        const chats = await _buildChatsFromDb(fakePrisma([
            row('549111', 'user', '¿cuánto sale?', 20),
            row('549111', 'system', 'Bot pausado por el admin', 40),
            row('549222', 'bot', 'Listo, anotado', 21),
            row('549222', 'system', 'Error de IA', 41),
        ]), SELLER, {}, []);
        expect(byId(chats, '549111').lastMessage).toEqual({
            body: '¿cuánto sale?', timestamp: T(20).getTime(), fromMe: false,
        });
        expect(byId(chats, '549222').lastMessage).toMatchObject({ body: 'Listo, anotado', fromMe: true });
    });

    test('un chat con solo filas system sigue en la lista, con fromMe null', async () => {
        const chats = await _buildChatsFromDb(fakePrisma([
            row('549111', 'system', 'Pausa restaurada', 40),
        ]), SELLER, {}, []);
        expect(chats).toHaveLength(1);
        expect(chats[0].lastMessage).toMatchObject({ body: 'Pausa restaurada', fromMe: null });
    });

    test('ordena por el último mensaje real y conserva nombre, pausa y compras', async () => {
        const ss = { pausedUsers: new Set(['549222@c.us']), userState: {}, config: {} };
        const orders = [{
            id: 'o1', instanceId: SELLER, userPhone: '549222', status: 'Confirmado', products: 'Gotas 60',
            totalPrice: 100, createdAt: T(0),
        }];
        const prisma = fakePrisma([
            row('549111', 'user', 'hola', 30),
            row('549222', 'user', 'buenas', 20),
        ], [{ phone: '549111', name: 'Ana' }]);
        const chats = await _buildChatsFromDb(prisma, SELLER, ss, orders);

        expect(chats.map(c => c.id)).toEqual(['549111@c.us', '549222@c.us']);
        expect(chats[0]).toMatchObject({ name: 'Ana', isPaused: false, hasBought: false });
        expect(chats[1]).toMatchObject({ name: '+549222', isPaused: true, hasBought: true });
        expect(prisma.chatLog.findMany.mock.calls[0][0].where).toEqual({ instanceId: SELLER });
    });

    test('sin filas devuelve lista vacía', async () => {
        expect(await _buildChatsFromDb(fakePrisma([]), SELLER, {}, [])).toEqual([]);
    });
});
