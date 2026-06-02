/**
 * Guard anti "venta fantasma" — _isGhostClose.
 *
 * La IA no debe poder "cerrar" una venta por texto sin que el flujo haya
 * generado la orden. Este guard detecta ese caso (caso real 5493442465660,
 * Natalia) para pausar + avisar al admin en vez de perder la venta en silencio.
 */
jest.mock('../db', () => ({ prisma: {} }), { virtual: true });

const { _isGhostClose } = require('../src/flows/utils/flowHelpers');

describe('_isGhostClose', () => {
    test('cierre por texto + step abierto + sin pendingOrder → TRUE (venta fantasma)', () => {
        expect(_isGhostClose('¡Listo todo entonces! Cuando retires pagás $36.900 en efectivo', 'waiting_transfer_confirmation', false)).toBe(true);
        expect(_isGhostClose('Tu pedido quedó confirmado, te llega en unos días 👍', 'waiting_payment_method', false)).toBe(true);
        expect(_isGhostClose('Pedido ingresado, ¡gracias!', 'waiting_data', false)).toBe(true);
        expect(_isGhostClose('Ya está tu pedido, en breve te llega', 'waiting_mp_payment', false)).toBe(true);
    });

    test('con pendingOrder (confirmación legítima en curso) → FALSE', () => {
        expect(_isGhostClose('¡Listo todo! Tu pedido: Semillas 60 días', 'waiting_final_confirmation', true)).toBe(false);
    });

    test('en step de cierre real → FALSE', () => {
        expect(_isGhostClose('Pedido confirmado ✅', 'waiting_admin_validation', false)).toBe(false);
        expect(_isGhostClose('listo todo', 'completed', false)).toBe(false);
    });

    test('mensajes normales de mid-flow → FALSE (sin falsos positivos)', () => {
        expect(_isGhostClose('¡Dale! ¿Con cuál arrancás, cápsulas o gotas?', 'waiting_preference', false)).toBe(false);
        expect(_isGhostClose('¿Te tomo los datos para el envío?', 'waiting_data', false)).toBe(false);
        expect(_isGhostClose('Ok, te paso el link de pago 👇', 'waiting_payment_method', false)).toBe(false);
        expect(_isGhostClose('Listo, te paso el alias para transferir', 'waiting_payment_method', false)).toBe(false);
        expect(_isGhostClose('', 'waiting_data', false)).toBe(false);
    });
});
