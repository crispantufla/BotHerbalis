/**
 * Regresión del fix de retención de contexto (commit 5a4f928): garantiza que el
 * historial LLEGA a Claude como TURNOS user/assistant reales (no aplanado como
 * texto en un solo turno) y con el system cacheado. Es el guard contra que alguien
 * revierta el fix al blob sin que ningún test lo cace.
 *
 * Desde sep-2026 también cubre el cableado del prompt cache: el system viaja en
 * bloques (core compartido + módulo del step), cada uno con breakpoint de 1h, y el
 * bloque core es byte-idéntico entre steps (si no, el prefijo no se comparte y la
 * caché sale más cara que no cachear).
 *
 * No prueba el COMPORTAMIENTO del modelo (seguir el hilo) — eso depende del LLM y
 * el repo no tiene harness de simulación V7. Prueba el CABLEADO, que es lo
 * determinista y lo que de hecho se rompió: cómo se le entrega el contexto a Claude.
 */

const { aiService, _buildSystemBlocks, _buildSystemPrompt, CLAUDE_CACHE_CONTROL, CLAUDE_DIALOG_TOOL } = require('../src/services/ai');

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
        // 3. El system va como bloque cacheado con TTL de 1h (el de 5 min no llegaba a
        //    pegar entre llamadas: gaps de 10-40 min en prod).
        expect(Array.isArray(arg.system)).toBe(true);
        expect(arg.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(arg.system[0].text).toBe('SYSTEM_PROMPT_ESTABLE');
    });

    test('system en BLOQUES: un breakpoint 1h por bloque, en orden, y la tool compartida', async () => {
        const create = stubClaude(aiService);
        const userPrompt = 'MENSAJE DEL USUARIO: "hola" [t4]';

        await aiService._claudeChat(['CORE_COMPARTIDO', 'MODULO_DEL_STEP'], userPrompt, 'waiting_weight', 'horacio', []);

        const arg = create.mock.calls[0][0];
        expect(arg.system).toEqual([
            { type: 'text', text: 'CORE_COMPARTIDO', cache_control: CLAUDE_CACHE_CONTROL },
            { type: 'text', text: 'MODULO_DEL_STEP', cache_control: CLAUDE_CACHE_CONTROL },
        ]);
        expect(CLAUDE_CACHE_CONTROL).toEqual({ type: 'ephemeral', ttl: '1h' });
        // La tool va ANTES del system en el prefijo cacheado: tiene que ser el mismo objeto siempre.
        expect(arg.tools).toEqual([CLAUDE_DIALOG_TOOL]);
        expect(arg.tool_choice).toEqual({ type: 'tool', name: 'control_dialog_flow' });
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

describe('prompt cache — bloques del system', () => {
    const INSTR = 'INSTRUCCIONES:\n1. Fijate';

    test('el bloque CORE es byte-idéntico entre steps y modelos (prefijo compartido)', async () => {
        const weight = await _buildSystemBlocks('waiting_weight', true);      // haiku
        const plan = await _buildSystemBlocks('waiting_plan_choice', true);   // sonnet
        const data = await _buildSystemBlocks('waiting_data', true);          // sonnet
        expect(weight).toHaveLength(2);
        expect(weight[0]).toBe(plan[0]);
        expect(weight[0]).toBe(data[0]);
        // El módulo sí cambia por step.
        expect(weight[1]).not.toBe(plan[1]);
        expect(plan[1]).not.toBe(data[1]);
        // Determinista: dos builds seguidos dan lo mismo (nada de fechas/random).
        expect(await _buildSystemBlocks('waiting_weight', true)).toEqual(weight);
    });

    test('las instrucciones de respuesta viven en el CORE (cacheado), no en cada turno user', async () => {
        const [core, stepBlock] = await _buildSystemBlocks('waiting_weight', true);
        expect(core).toContain(INSTR);
        expect(stepBlock).not.toContain(INSTR);
        // Nada del turno user se coló al system (rompería el prefijo).
        expect(core).not.toContain('MENSAJE DEL USUARIO');
        expect(stepBlock).not.toContain('MENSAJE DEL USUARIO');
        // El system clásico (path OpenAI) NO las incluye: ahí siguen en el turno user.
        expect(await _buildSystemPrompt('waiting_weight', '', false, true)).not.toContain(INSTR);
    });

    test('el interruptor de MP cambia el CORE (no puede compartir caché entre ON y OFF)', async () => {
        const [coreOn] = await _buildSystemBlocks('waiting_weight', true);
        const [coreOff] = await _buildSystemBlocks('waiting_weight', false);
        expect(coreOn).not.toBe(coreOff);
    });
});
