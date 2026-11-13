/**
 * Forma del pedido a los modelos Claude 5.x (Sonnet 5.5 desde el 13-nov-2026).
 *
 * Cambian tres cosas respecto de los 4.x, y cada una da un 400 si se manda como
 * antes: no aceptan `temperature`, no aceptan forzar la herramienta
 * (`tool_choice` tool/any) y el razonamiento no se apaga con `disabled`. Este
 * test fija lo que el bot manda, el respaldo al modelo anterior y la mudanza de
 * direcciones, imágenes y resúmenes. Sin red: el SDK de Anthropic va mockeado.
 */
jest.mock('../db', () => ({ prisma: {} }));
jest.mock('../src/services/semanticCache', () => ({ lookupSemanticCache: jest.fn(async () => null), storeSemanticCache: jest.fn(async () => {}) }));
jest.mock('../src/services/funnelLogger', () => ({ markAiCall: jest.fn(async () => {}), logStepTransition: jest.fn(), logMessage: jest.fn(), markExit: jest.fn(async () => {}) }));

delete process.env.CLAUDE_MODEL_PREMIUM;
delete process.env.CLAUDE_MODEL_LEGACY;
delete process.env.CLAUDE_THINKING;
delete process.env.PARSE_ADDRESS_PROVIDER;
process.env.CLAUDE_AB_SELLERS = '*';
process.env.CLAUDE_AB_PERCENT = '100';

const { aiService } = require('../src/services/ai');
const knowledge = require('../knowledge_v7.json');

const toolReply = (input) => ({ content: [{ type: 'tool_use', name: 'control_dialog_flow', input }], usage: {}, model: 'x' });

function setup(impl) {
    const create = jest.fn(impl);
    aiService._disabled = false;
    aiService._claudeDisabled = false;
    aiService.anthropic = { messages: { create } };
    const openai = jest.fn(async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ response: 'desde GPT', goalMet: false }) } }], content: 'resumen GPT' } }], usage: {}, model: 'gpt-4o' }));
    aiService.client = { chat: { completions: { create: openai } } };
    if (aiService.cache?.flushAll) aiService.cache.flushAll();
    return { create, openai };
}
let n = 0;
const ask = (step, text = 'hola, tengo una duda') => aiService.chat(`${text} ${++n}`, { step, goal: 'objetivo', history: [], summary: '', knowledge, userState: { step }, sellerId: 'horacio', phone: `54900000${n}`, mpEnabled: true, forceClaude: true });

describe('conversación en Sonnet 5.5', () => {
    test('paso sin razonamiento: sin temperature, herramienta en auto y estricta, between_tools, aviso de usar la herramienta', async () => {
        const { create } = setup(async () => toolReply({ response: 'ok', goalMet: false, extractedData: null }));
        const r = await ask('waiting_preference');
        expect(r.response).toBe('ok');
        const req = create.mock.calls[0][0];
        expect(req.model).toBe('claude-sonnet-5-5');
        expect(req).not.toHaveProperty('temperature');
        expect(req.tool_choice).toEqual({ type: 'auto' });
        expect(req.thinking).toEqual({ type: 'between_tools' });
        expect(req.output_config).toEqual({ effort: 'low' });
        expect(req.tools[0].strict).toBe(true);
        expect(req.tools[0].input_schema.additionalProperties).toBe(false);
        expect(req.tools[0].input_schema.required.sort()).toEqual(['extractedData', 'goalMet', 'response']);
        expect(req.tools[0].input_schema.properties.extractedData.type).toEqual(['string', 'null']);
        expect(req.messages[req.messages.length - 1].content).toMatch(/Respondé llamando a la herramienta control_dialog_flow/);
        // El aviso va en el turno del usuario, nunca en el system cacheado.
        expect(JSON.stringify(req.system)).not.toMatch(/Respondé llamando a la herramienta/);
    });

    test.each(['waiting_payment_method', 'waiting_zone', 'waiting_data', 'waiting_final_confirmation'])(
        '%s: razona antes de contestar (esfuerzo medio, sin apagar el razonamiento, más tokens)', async (step) => {
            const { create } = setup(async () => toolReply({ response: 'ok', goalMet: false, extractedData: null }));
            await ask(step);
            const req = create.mock.calls[0][0];
            expect(req).not.toHaveProperty('thinking');
            expect(req.output_config).toEqual({ effort: 'medium' });
            expect(req.max_tokens).toBeGreaterThanOrEqual(4000);
        });

    test('lee por tipo de bloque: la respuesta puede empezar con razonamiento', async () => {
        setup(async () => ({ content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', name: 'control_dialog_flow', input: { response: 'después de pensar', goalMet: true, extractedData: '60' } }], usage: {}, model: 'claude-sonnet-5-5' }));
        expect(await ask('waiting_payment_method')).toMatchObject({ response: 'después de pensar', goalMet: true, extractedData: '60' });
    });

    test('si contesta en texto sin usar la herramienta, se usa ese texto y no avanza de paso', async () => {
        const { openai } = setup(async () => ({ content: [{ type: 'text', text: 'Hola, te cuento' }], usage: {}, model: 'claude-sonnet-5-5' }));
        expect(await ask('waiting_preference')).toMatchObject({ response: 'Hola, te cuento', goalMet: false });
        expect(openai).not.toHaveBeenCalled();
    });

    test.each([
        ['se niega a responder', async (req) => (req.model === 'claude-sonnet-5-5' ? { stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [] } : toolReply({ response: 'desde 4.6', goalMet: false }))],
        ['da error', async (req) => { if (req.model === 'claude-sonnet-5-5') throw new Error('400 invalid_request_error'); return toolReply({ response: 'desde 4.6', goalMet: false }); }],
    ])('si Sonnet 5.5 %s, reintenta en el modelo anterior con la forma de siempre', async (_n, impl) => {
        const { create, openai } = setup(impl);
        const r = await ask('waiting_preference');
        expect(r.response).toBe('desde 4.6');
        expect(create.mock.calls.map(c => c[0].model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-4-6']);
        const legacy = create.mock.calls[1][0];
        expect(legacy.temperature).toBe(0.6);
        expect(legacy.tool_choice).toEqual({ type: 'tool', name: 'control_dialog_flow' });
        expect(legacy).not.toHaveProperty('thinking');
        expect(legacy.messages[legacy.messages.length - 1].content).not.toMatch(/Respondé llamando a la herramienta/);
        expect(openai).not.toHaveBeenCalled();
    });

    test('si fallan los dos modelos de Claude, cae a OpenAI', async () => {
        const { openai } = setup(async () => { throw new Error('caído'); });
        const r = await ask('waiting_preference');
        expect(openai).toHaveBeenCalled();
        expect(r.response).toMatch(/desde GPT/);
    });
});

describe('direcciones, imágenes y resúmenes: primero Claude', () => {
    test('parseAddress lee con Claude (herramienta en auto, estricta, sin temperature) y no llama a OpenAI', async () => {
        const { create, openai } = setup(async () => ({ content: [{ type: 'tool_use', name: 'extract_address', input: { nombre: 'Ana Pérez', calle: 'Mitre 1234', ciudad: 'Rosario', provincia: null, cp: 'null', postdatado: null } }] }));
        const r = await aiService.parseAddress('Ana Pérez, Mitre 1234, Rosario');
        expect(r).toMatchObject({ nombre: 'Ana Pérez', calle: 'Mitre 1234', ciudad: 'Rosario', provincia: null, cp: null });
        const req = create.mock.calls[0][0];
        expect(req).not.toHaveProperty('temperature');
        expect(req.tool_choice).toEqual({ type: 'auto' });
        expect(req.tools[0].strict).toBe(true);
        expect(req.thinking).toEqual({ type: 'between_tools' });
        expect(openai).not.toHaveBeenCalled();
    });

    test('si Claude no devuelve la dirección, la lee OpenAI', async () => {
        const { openai } = setup(async () => ({ content: [{ type: 'text', text: 'no sé' }] }));
        openai.mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ nombre: 'Luis Gómez', calle: null, ciudad: null, provincia: null, cp: null, postdatado: null }) } }] } }], usage: {}, model: 'gpt-4o' });
        const r = await aiService.parseAddress('Luis Gómez (texto raro)');
        expect(openai).toHaveBeenCalledTimes(1);
        expect(r.nombre).toBe('Luis Gómez');
    });

    test('PARSE_ADDRESS_PROVIDER=openai vuelve al orden anterior', async () => {
        process.env.PARSE_ADDRESS_PROVIDER = 'openai';
        const { create, openai } = setup(async () => ({ content: [] }));
        openai.mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ nombre: 'Eva Ruiz' }) } }] } }], usage: {}, model: 'gpt-4o' });
        const r = await aiService.parseAddress('Eva Ruiz, otra dirección');
        delete process.env.PARSE_ADDRESS_PROVIDER;
        expect(r.nombre).toBe('Eva Ruiz');
        expect(create).not.toHaveBeenCalled();
    });

    test('analyzeImage manda la imagen a Claude como bloque de imagen en base64', async () => {
        const { create, openai } = setup(async () => ({ content: [{ type: 'text', text: 'Comprobante por $47.000' }] }));
        expect(await aiService.analyzeImage('QUJD', 'image/jpeg', '¿Qué dice?')).toBe('Comprobante por $47.000');
        const req = create.mock.calls[0][0];
        expect(req.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
        expect(req).not.toHaveProperty('temperature');
        expect(openai).not.toHaveBeenCalled();
    });

    test('analyzeImage cae a OpenAI si Claude falla', async () => {
        const { openai } = setup(async () => { throw new Error('caído'); });
        openai.mockResolvedValueOnce({ choices: [{ message: { content: ' desde GPT ' } }], usage: {}, model: 'gpt-4o-mini' });
        expect(await aiService.analyzeImage('QUJD', 'image/jpeg', '¿Qué dice?')).toBe('desde GPT');
    });

    test('el resumen de una charla larga lo hace Claude con el modelo simple (que sí acepta temperature)', async () => {
        const { create, openai } = setup(async () => ({ content: [{ type: 'text', text: 'Resumen corto.' }] }));
        expect(await aiService._callQueuedSummarize([{ role: 'user', content: 'hola' }, { role: 'bot', content: 'qué tal' }], '', 'horacio')).toBe('Resumen corto.');
        const req = create.mock.calls[0][0];
        expect(req.model).toMatch(/haiku/);
        expect(req.temperature).toBe(0.3);
        expect(openai).not.toHaveBeenCalled();
    });
});
