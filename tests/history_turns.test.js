/**
 * buildHistoryTurns — normalización del historial a turnos user/assistant válidos
 * para la Messages API de Claude (modo WA_STRUCTURED_TURNS).
 *
 * Los modos de falla que cubre son los que tiran 400 en Claude o duplican contexto:
 *  - primer turno 'assistant' (Claude exige que el primero sea 'user'),
 *  - el mensaje ACTUAL del usuario quedaría duplicado (ya viene pusheado al history),
 *  - 2+ 'bot' seguidos por turno (greeting/preference/data los pushean en partes).
 */

const { buildHistoryTurns } = require('../src/services/historyTurns');

describe('buildHistoryTurns', () => {
    test('history vacío o nulo → []', () => {
        expect(buildHistoryTurns([], 'hola')).toEqual([]);
        expect(buildHistoryTurns(null, 'hola')).toEqual([]);
        expect(buildHistoryTurns(undefined, 'hola')).toEqual([]);
    });

    test('mapea roles: user→user, bot/admin/system→assistant', () => {
        const h = [
            { role: 'user', content: 'hola' },
            { role: 'bot', content: 'buenas!' },
            { role: 'admin', content: 'nota interna' },
            { role: 'system', content: 'evento' },
        ];
        const turns = buildHistoryTurns(h, 'otra cosa');
        expect(turns).toEqual([
            { role: 'user', content: 'hola' },
            // bot + admin + system son consecutivos del mismo role mapeado → se mergean
            { role: 'assistant', content: 'buenas!\nnota interna\nevento' },
        ]);
    });

    test('saca el mensaje ACTUAL del usuario (último), ya pusheado antes del step', () => {
        const h = [
            { role: 'user', content: 'quiero info' },
            { role: 'bot', content: 'te paso precios' },
            { role: 'user', content: 'cuanto sale' }, // este es el mensaje actual
        ];
        const turns = buildHistoryTurns(h, 'cuanto sale');
        // El último 'user' se quita → no se duplica al armar [...turns, {user: actual}]
        expect(turns).toEqual([
            { role: 'user', content: 'quiero info' },
            { role: 'assistant', content: 'te paso precios' },
        ]);
    });

    test('mergea 2+ "bot" seguidos en un turno (caso greeting/preference)', () => {
        const h = [
            { role: 'user', content: 'hola' },
            { role: 'bot', content: 'parte 1 del saludo' },
            { role: 'bot', content: 'parte 2 del saludo' },
        ];
        const turns = buildHistoryTurns(h, 'siguiente');
        expect(turns).toEqual([
            { role: 'user', content: 'hola' },
            { role: 'assistant', content: 'parte 1 del saludo\nparte 2 del saludo' },
        ]);
    });

    test('descarta turnos assistant iniciales → el primer turno SIEMPRE es user', () => {
        const h = [
            { role: 'bot', content: 'saludo inicial del bot' }, // el bot saludó primero
            { role: 'user', content: 'hola' },
            { role: 'bot', content: 'genial' },
        ];
        const turns = buildHistoryTurns(h, 'algo');
        expect(turns[0].role).toBe('user');
        expect(turns).toEqual([
            { role: 'user', content: 'hola' },
            { role: 'assistant', content: 'genial' },
        ]);
    });

    test('ignora entradas con content vacío o no-string', () => {
        const h = [
            { role: 'user', content: 'hola' },
            { role: 'bot', content: '' },
            { role: 'bot', content: '   ' },
            { role: 'bot', content: null },
            { role: 'bot', content: 'respuesta real' },
        ];
        const turns = buildHistoryTurns(h, 'x');
        expect(turns).toEqual([
            { role: 'user', content: 'hola' },
            { role: 'assistant', content: 'respuesta real' },
        ]);
    });

    test('conversación real (Claromecó): array final válido para Claude (user-first, sin assistant inicial)', () => {
        // El bot abre con el saludo; el cliente responde; etc. El history incluye el
        // mensaje actual del usuario como última entrada.
        const currentUser = 'Es Argentina te acabo de decir!!!';
        const h = [
            { role: 'bot', content: '¡Hola! Soy Elena de Herbalis.' },
            { role: 'user', content: 'precio?' },
            { role: 'bot', content: 'Cápsulas: $44.900...' },
            { role: 'user', content: 'soy del sur de Bs As' },
            { role: 'bot', content: 'Lamentablemente solo hacemos envíos dentro de Argentina' },
            { role: 'user', content: currentUser },
        ];
        const turns = buildHistoryTurns(h, currentUser);

        // 1. El primer turno es 'user' (no assistant) → no 400.
        expect(turns[0].role).toBe('user');
        // 2. El mensaje actual no quedó en los turnos (se agrega aparte como último user).
        expect(turns.some(t => t.content === currentUser)).toBe(false);

        // 3. Simular el array final que va a la API y validar que arranca con user.
        const finalMessages = [...turns, { role: 'user', content: currentUser }];
        expect(finalMessages[0].role).toBe('user');
        // 4. Todos los roles son user|assistant.
        expect(finalMessages.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true);
    });
});
