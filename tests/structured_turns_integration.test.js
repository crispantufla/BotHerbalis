/**
 * Regresión del fix de retención de contexto (commit 5a4f928): garantiza que el
 * historial LLEGA a Claude como TURNOS user/assistant reales (no aplanado como
 * texto en un solo turno) y con el system cacheado. Es el guard contra que alguien
 * revierta el fix al blob sin que ningún test lo cace.
 *
 * No prueba el COMPORTAMIENTO del modelo (seguir el hilo) — eso depende del LLM y
 * el repo no tiene harness de simulación V7. Prueba el CABLEADO, que es lo
 * determinista y lo que de hecho se rompió: cómo se le entrega el contexto a Claude.
 */

const { aiService } = require('../src/services/ai');

// Activa el path Claude sin red real: mockeamos el SDK de Anthropic.
function stubClaude(service) {
    const create = jest.fn().mockResolvedValue({
        content: [{ type: 'tool_use', input: { response: 'ok', goalMet: false, extractedData: null } }],
    });
    service._disabled = false;
    service._claudeDisabled = false;
    service.anthropic = { messages: { create } };
    return create;
}

describe('structured turns — cableado a Claude', () => {
    test('CON turnos: el historial va como messages[] estructurados + system cacheado', async () => {
        const create = stubClaude(aiService);
        const turns = [
            { role: 'user', content: 'quiero info' },
            { role: 'assistant', content: 'te paso precios' },
        ];
        // userPrompt único por test → cache miss garantizado (si no, create no se llamaría).
        const userPrompt = 'MENSAJE DEL USUARIO: "cuanto sale" [t1]';

        await aiService._claudeChat('SYSTEM_PROMPT_ESTABLE', userPrompt, 'waiting_preference', 'horacio', turns);

        expect(create).toHaveBeenCalledTimes(1);
        const arg = create.mock.calls[0][0];

        // 1. El historial llega como turnos reales, con el mensaje actual como último 'user'.
        expect(arg.messages).toEqual([
            { role: 'user', content: 'quiero info' },
            { role: 'assistant', content: 'te paso precios' },
            { role: 'user', content: userPrompt },
        ]);
        // 2. El historial NO está embebido como texto dentro de un único turno (regresión al blob).
        expect(arg.messages.length).toBeGreaterThan(1);
        // 3. El system va como bloque cacheado (cache_control ephemeral).
        expect(Array.isArray(arg.system)).toBe(true);
        expect(arg.system[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(arg.system[0].text).toBe('SYSTEM_PROMPT_ESTABLE');
    });

    test('SIN turnos: comportamiento clásico (un solo turno user, system string, sin cache)', async () => {
        const create = stubClaude(aiService);
        const userPrompt = 'PROMPT CLASICO CON HISTORIAL EMBEBIDO [t2]';

        await aiService._claudeChat('SYSTEM_PROMPT', userPrompt, 'waiting_preference', 'horacio');

        expect(create).toHaveBeenCalledTimes(1);
        const arg = create.mock.calls[0][0];

        expect(arg.messages).toEqual([{ role: 'user', content: userPrompt }]);
        expect(arg.system).toBe('SYSTEM_PROMPT'); // string, sin cache_control
    });

    test('primer turno SIEMPRE user, aunque el bot haya saludado primero (anti-400)', async () => {
        const create = stubClaude(aiService);
        // Simula lo que arma chat(): normaliza el history con buildHistoryTurns.
        const { buildHistoryTurns } = require('../src/services/historyTurns');
        const history = [
            { role: 'bot', content: 'Hola! Soy Elena' },     // el bot abrió
            { role: 'user', content: 'hola' },
            { role: 'bot', content: 'parte 1' },
            { role: 'bot', content: 'parte 2' },              // 2 'bot' seguidos
            { role: 'user', content: 'mensaje actual [t3]' },
        ];
        const turns = buildHistoryTurns(history, 'mensaje actual [t3]');
        const userPrompt = 'bloque del mensaje actual [t3]';

        await aiService._claudeChat('SYS', userPrompt, 'waiting_preference', 'horacio', turns);

        const arg = create.mock.calls[0][0];
        // El primer mensaje que ve Claude debe ser 'user' (si fuera 'assistant' → 400).
        expect(arg.messages[0].role).toBe('user');
        // Los 2 'bot' seguidos se mergearon en un único turno assistant.
        expect(arg.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
        expect(arg.messages.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true);
    });
});
