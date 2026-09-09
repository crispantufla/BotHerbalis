require('dotenv').config();
const { _pushHistory } = require('../src/flows/utils/flowHelpers');

/**
 * _pushHistory es el único punto por el que entran mensajes al history desde el
 * 2026-09-09: los 141 `history.push({role:'bot', ...})` sueltos que había en los
 * steps, globals, scheduler y rutas se migraron acá. Eso hace que su cap sea
 * load-bearing en todo el flujo, no solo en los 6 call sites del scheduler.
 *
 * Lo que se cuida:
 *  - la forma de la entrada tiene que seguir siendo idéntica a la del push crudo
 *    (role/content/timestamp), o el historial que ve la IA cambia de forma;
 *  - el cap tiene que conservar la COLA (lo más reciente), nunca la cabeza.
 */
describe('_pushHistory', () => {

    test('la entrada tiene la misma forma que el push crudo que reemplazó', () => {
        const state = { history: [] };
        const before = Date.now();
        _pushHistory(state, { role: 'bot', content: 'hola' });
        const entry = state.history[0];

        expect(Object.keys(entry).sort()).toEqual(['content', 'role', 'timestamp']);
        expect(entry.role).toBe('bot');
        expect(entry.content).toBe('hola');
        expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    });

    test('respeta un timestamp explícito', () => {
        const state = { history: [] };
        _pushHistory(state, { role: 'bot', content: 'x', timestamp: 12345 });
        expect(state.history[0].timestamp).toBe(12345);
    });

    test('inicializa history si el state no lo tiene', () => {
        const state = {};
        _pushHistory(state, { role: 'bot', content: 'x' });
        expect(state.history).toHaveLength(1);
    });

    test('capea en 250 conservando los 150 más recientes', () => {
        const state = { history: [] };
        for (let i = 0; i < 250; i++) _pushHistory(state, { role: 'bot', content: `m${i}` });
        expect(state.history).toHaveLength(250);

        // el push 251 dispara el recorte
        _pushHistory(state, { role: 'bot', content: 'm250' });
        expect(state.history).toHaveLength(150);
        expect(state.history[state.history.length - 1].content).toBe('m250');
        // se queda la cola, no la cabeza
        expect(state.history[0].content).toBe('m101');
    });

    test('el cap no se escapa aunque se empuje muy por encima del techo', () => {
        const state = { history: [] };
        for (let i = 0; i < 5000; i++) _pushHistory(state, { role: 'bot', content: `m${i}` });
        expect(state.history.length).toBeLessThanOrEqual(250);
        expect(state.history[state.history.length - 1].content).toBe('m4999');
    });
});
