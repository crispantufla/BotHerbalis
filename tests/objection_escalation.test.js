/**
 * Tests del detector de objeciones con escalado por tier.
 * Smoke test puro sobre detectObjection — sin mocks de DB ni AI.
 */
const { detectObjection } = require('../src/flows/utils/objectionDetector');

function makeState(overrides = {}) {
    return {
        step: 'waiting_plan_choice',
        history: [],
        cart: [],
        partialAddress: {},
        summary: '',
        stepEnteredAt: Date.now(),
        objectionsHandled: {},
        ...overrides,
    };
}

describe('objectionDetector — escalado por tier', () => {

    describe('Tier 1 (standard) en primera aparición', () => {
        test('"esta caro" → tier=standard, sin pauseAfter', () => {
            const state = makeState();
            const m = detectObjection('waiting_plan_choice', 'la verdad esta caro', state);
            expect(m).not.toBeNull();
            expect(m.type).toBe('caro');
            expect(m.tier).toBe('standard');
            expect(m.pauseAfter).toBe(false);
            expect(state.objectionsHandled.caro).toBe(1);
        });

        test('"tengo que consultar con mi marido" → tier=standard', () => {
            const state = makeState();
            const m = detectObjection('waiting_plan_choice', 'tengo que consultar con mi marido primero', state);
            expect(m.type).toBe('consultar');
            expect(m.tier).toBe('standard');
        });
    });

    describe('Tier 2 (escalated) en segunda aparición misma categoría', () => {
        test('"caro" 2da vez → tier=escalated + oferta concreta en el texto', () => {
            const state = makeState({ objectionsHandled: { caro: 1 } });
            const m = detectObjection('waiting_plan_choice', 'sigue siendo carisimo', state);
            expect(m.tier).toBe('escalated');
            expect(m.pauseAfter).toBe(false);
            // El escalado de "caro" ofrece reservar/apartar el PEDIDO — nunca
            // congelar/reservar el precio (modalidad prohibida, nada la honra).
            expect(m.response).toMatch(/reserv|apartad/i);
            expect(m.response).not.toMatch(/congel|precio de hoy/i);
            expect(state.objectionsHandled.caro).toBe(2);
        });

        test('"postergar" 2da vez → escalated con propuesta de postdatado concreto', () => {
            const state = makeState({ objectionsHandled: { postergar: 1 } });
            const m = detectObjection('waiting_plan_choice', 'cobro el viernes recien', state);
            expect(m.tier).toBe('escalated');
            expect(m.response).toMatch(/postdat|fecha|congel/i);
        });
    });

    describe('Tier 3 (pause) en tercera aparición', () => {
        test('"caro" 3ra vez → tier=pause + pauseAfter=true', () => {
            const state = makeState({ objectionsHandled: { caro: 2 } });
            const m = detectObjection('waiting_plan_choice', 'no, demasiado caro', state);
            expect(m.tier).toBe('pause');
            expect(m.pauseAfter).toBe(true);
            // El mensaje de pausa menciona explícitamente que pasa a un asesor
            expect(m.response).toMatch(/asesor/i);
            expect(state.objectionsHandled.caro).toBe(3);
        });
    });

    describe('Cuarta aparición: AI retoma el control', () => {
        test('"caro" 4ta vez → null (no más rebuttals)', () => {
            const state = makeState({ objectionsHandled: { caro: 3 } });
            const m = detectObjection('waiting_plan_choice', 'sigue caro', state);
            expect(m).toBeNull();
        });
    });

    describe('Categorías son independientes', () => {
        test('caro=3 (agotado) pero consultar=0 → consultar dispara tier standard', () => {
            const state = makeState({ objectionsHandled: { caro: 3 } });
            const m = detectObjection('waiting_plan_choice', 'tengo que consultar con mi esposa', state);
            expect(m).not.toBeNull();
            expect(m.type).toBe('consultar');
            expect(m.tier).toBe('standard');
        });
    });
});
