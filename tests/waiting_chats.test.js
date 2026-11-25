/**
 * Bandeja "Te esperan" (GET /api/waiting-chats): de los chats pausados, a quién
 * hay que contestarle. Función pura: no toca la DB.
 */
const { pickWaitingChats } = require('../src/api/routes/waitingChats');

const T = (min) => new Date(Date.UTC(2026, 10, 25, 12, min));
const row = (userPhone, role, content, min) => ({ userPhone, role, content, timestamp: T(min) });
const user = (phone, extra = {}) => ({ phone, name: null, pauseReason: 'manual', pausedAt: T(0), ...extra });

describe('pickWaitingChats', () => {
    test('entra el pausado cuyo último mensaje es del cliente', () => {
        const out = pickWaitingChats(
            [user('549111', { name: 'Ana' })],
            [row('549111', 'user', '¿hacen envíos?', 30), row('549111', 'bot', 'Hola', 10)],
        );
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ id: '549111@c.us', name: 'Ana', lastMessage: '¿hacen envíos?', pendingCount: 1 });
    });

    test('no entra si lo último fue una respuesta del bot o de una persona', () => {
        const out = pickWaitingChats(
            [user('549111'), user('549222')],
            [
                row('549111', 'bot', 'Te paso los precios', 30), row('549111', 'user', 'hola', 10),
                row('549222', 'admin', 'Ya te lo mando', 31), row('549222', 'user', 'hola', 11),
            ],
        );
        expect(out).toEqual([]);
    });

    test('junta en orden los mensajes sin responder y espera desde el primero', () => {
        const out = pickWaitingChats(
            [user('549111')],
            [
                row('549111', 'user', 'y cuánto sale', 32), row('549111', 'user', 'las gotas', 31),
                row('549111', 'bot', '¿Cuál te interesa?', 20),
            ],
        );
        expect(out[0].lastMessage).toBe('las gotas y cuánto sale');
        expect(out[0].pendingCount).toBe(2);
        expect(out[0].waitingSince).toBe(T(31).getTime());
    });

    test('la bienvenida automática de WhatsApp Business y las filas system no cuentan como respuesta', () => {
        const out = pickWaitingChats(
            [user('549111')],
            [
                row('549111', 'system', 'pausado', 33),
                row('549111', 'admin', 'Gracias por comunicarte', 32),
                row('549111', 'user', 'precio?', 31),
            ],
            (c) => c.startsWith('Gracias por comunicarte'),
        );
        expect(out).toHaveLength(1);
        expect(out[0].lastMessage).toBe('precio?');
    });

    test('ordena del que escribió más recién al más viejo y saltea al pausado sin filas', () => {
        const out = pickWaitingChats(
            [user('549111'), user('549222'), user('549333')],
            [row('549222', 'user', 'b', 40), row('549111', 'user', 'a', 20)],
        );
        expect(out.map((c) => c.phone)).toEqual(['549222', '549111']);
    });

    test('recorta un texto largo', () => {
        const out = pickWaitingChats([user('549111')], [row('549111', 'user', 'x'.repeat(500), 20)]);
        expect(out[0].lastMessage.length).toBe(280);
        expect(out[0].lastMessage.endsWith('…')).toBe(true);
    });
});
