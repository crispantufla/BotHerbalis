/**
 * AIService.chat() — qué le manda exactamente a Claude y a OpenAI.
 *
 * chat() arma el turno user (conocimiento del paso, estado del cliente,
 * historial, último mensaje del bot), decide el motor, consulta el cache
 * semántico y llama al proveedor. Este test fija los payloads exactos (system,
 * messages, tools, modelo), las claves de caché y lo que devuelve, en un
 * conjunto de escenarios y sin red: los SDKs, el cache semántico y el embudo
 * están mockeados.
 *
 * Con AI_TRACE_FILE=<ruta> vuelca la traza completa (una firma por cada texto)
 * para comparar byte a byte antes y después de un refactor.
 */
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

jest.mock('../src/services/semanticCache', () => ({
    lookupSemanticCache: jest.fn(async () => null),
    storeSemanticCache: jest.fn(async () => {}),
}));
jest.mock('../src/services/funnelLogger', () => ({
    incrementAiCallCount: jest.fn(async () => {}),
    incrementMessageCount: jest.fn(async () => {}),
    logStepTransition: jest.fn(async () => {}),
    markExit: jest.fn(async () => {}),
}));
jest.mock('../db', () => ({ prisma: {} }));

const { aiService } = require('../src/services/ai');
const { lookupSemanticCache, storeSemanticCache } = require('../src/services/semanticCache');
const { incrementAiCallCount } = require('../src/services/funnelLogger');
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v7.json'), 'utf8'));

const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const sig = (v) => (v == null ? null : `${crypto.createHash('sha256').update(text(v)).digest('hex').slice(0, 16)}:${text(v).length}`);

const traces = [];
afterAll(() => {
    if (process.env.AI_TRACE_FILE) fs.writeFileSync(process.env.AI_TRACE_FILE, JSON.stringify(traces, null, 2));
});
beforeEach(() => {
    lookupSemanticCache.mockReset().mockResolvedValue(null);
    storeSemanticCache.mockReset().mockResolvedValue(undefined);
    incrementAiCallCount.mockReset().mockResolvedValue(undefined);
});

/** Proveedores falsos que registran cada request. */
function stub(svc, { claude = 'ok', openai = 'ok', useClaude } = {}) {
    const calls = { claude: [], openai: [] };
    svc._disabled = false;
    svc._claudeDisabled = false;
    svc.anthropic = {
        messages: {
            create: jest.fn(async (args) => {
                calls.claude.push(args);
                if (claude === 'no_tool') return { content: [{ type: 'text', text: 'hola' }] };
                if (claude === 'throw') throw Object.assign(new Error('boom'), { status: 400 });
                return { content: [{ type: 'tool_use', input: { response: '**Hola** desde Claude', goalMet: false, extractedData: '' } }] };
            }),
        },
    };
    svc.client = {
        chat: {
            completions: {
                create: jest.fn(async (args) => {
                    calls.openai.push(args);
                    if (openai === 'no_tool') return { choices: [{ message: {} }] };
                    if (openai === 'throw') throw Object.assign(new Error('boom'), { status: 400 });
                    const goalMet = openai === 'goal';
                    return { choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ response: '## Hola desde GPT', goalMet, extractedData: goalMet ? 'PRODUCTO: capsulas' : '' }) } }] } }] };
                }),
            },
        },
    };
    if (useClaude !== undefined) svc._useClaudeFor = jest.fn(() => useClaude);
    svc.cache.flushAll();
    const hashSpy = jest.spyOn(svc, '_hashKey');
    hashSpy.mockClear();
    return { svc, calls, hashSpy };
}

function record(name, h, result) {
    traces.push({
        name,
        result,
        claude: h.calls.claude.map(a => ({
            model: a.model, max_tokens: a.max_tokens, temperature: a.temperature,
            system: Array.isArray(a.system) ? a.system.map(b => ({ type: b.type, text: sig(b.text), cache_control: b.cache_control })) : sig(a.system),
            messages: a.messages.map(m => ({ role: m.role, content: sig(m.content) })),
            tools: sig(a.tools), tool_choice: a.tool_choice,
        })),
        openai: h.calls.openai.map(a => ({
            model: a.model, temperature: a.temperature, max_tokens: a.max_tokens,
            messages: a.messages.map(m => ({ role: m.role, content: sig(m.content) })),
            tools: sig(a.tools), tool_choice: a.tool_choice,
        })),
        cacheKeys: h.hashSpy.mock.calls.map(c => sig(c[0])),
        semanticLookup: lookupSemanticCache.mock.calls.map(c => [c[1], sig(c[2]), c[3]]),
        semanticStore: storeSemanticCache.mock.calls.map(c => [c[1], sig(c[2]), sig(c[3]), c[4]]),
        aiCallCount: incrementAiCallCount.mock.calls,
    });
}

const HISTORY = [
    { role: 'user', content: 'hola, quiero bajar de peso' },
    { role: 'bot', content: '¡Hola! Soy Elena. ¿Cuántos kilos querés bajar?' },
    { role: 'user', content: 'unos 12 kilos' },
    { role: 'bot', content: 'Perfecto, para 12 kilos te recomiendo el plan de 120 días.' },
];
const base = (o = {}) => ({
    knowledge, step: 'waiting_weight', goal: 'Saber cuántos kilos quiere bajar',
    history: HISTORY, sellerId: 'horacio', phone: '5491111111111', ...o,
});
const lastUser = (h, who = 'claude') => {
    const msgs = h.calls[who][0].messages;
    return msgs[msgs.length - 1].content;
};

describe('Claude, turnos estructurados', () => {
    test('waiting_weight: system en 2 bloques cacheados, historial como turnos, último mensaje del bot', async () => {
        const h = stub(aiService);
        const r = await aiService.chat('cuánto sale?', base({ forceClaude: true }));
        const arg = h.calls.claude[0];
        expect(arg.system).toHaveLength(2);
        expect(arg.system.every(b => b.cache_control && b.cache_control.ttl === '1h')).toBe(true);
        expect(arg.messages.length).toBeGreaterThan(1);
        const u = lastUser(h);
        expect(u).toContain('MENSAJE DEL USUARIO: "cuánto sale?"');
        expect(u).not.toContain('HISTORIAL RECIENTE');
        expect(u).toContain('TU ÚLTIMO MENSAJE');
        expect(u).toContain('plan de 120 días');
        expect(r).toEqual({ response: '*Hola* desde Claude', goalMet: false, extractedData: null });
        expect(incrementAiCallCount).toHaveBeenCalledWith('horacio', '5491111111111');
        record('claude waiting_weight', h, r);
    });

    const steps = [
        ['waiting_preference', { mpEnabled: false }, 'fuera de servicio'],
        ['waiting_price_confirmation', {}, 'todavía NO vio precios'],
        ['waiting_plan_choice', {}, 'PRECIOS:'],
        ['closing', { mpEnabled: false }, 'POLÍTICA DE ENVÍO Y PAGO'],
        ['waiting_ok', {}, 'POLÍTICA DE ENVÍO Y PAGO'],
        ['waiting_data', {}, 'PROHIBIDO PEDIR NÚMERO DE TELÉFONO'],
        ['waiting_final_confirmation', {}, 'INFORMACIÓN RELEVANTE PARA ESTE PASO'],
        ['paso_inventado', {}, 'ETAPA ACTUAL: "paso_inventado"'],
    ];
    for (const [step, extra, expected] of steps) {
        test(`${step}${extra.mpEnabled === false ? ' (MP apagado)' : ''}`, async () => {
            const h = stub(aiService);
            const r = await aiService.chat('y cómo es el envío?', base({ forceClaude: true, step, ...extra }));
            expect(lastUser(h)).toContain(expected);
            record(`claude ${step} mp=${extra.mpEnabled !== false}`, h, r);
        });
    }

    test('sin knowledge: sin bloque de información del paso', async () => {
        const h = stub(aiService);
        const r = await aiService.chat('hola', base({ forceClaude: true, knowledge: undefined }));
        expect(lastUser(h)).not.toContain('INFORMACIÓN RELEVANTE');
        record('claude sin knowledge', h, r);
    });
    test('con resumen previo', async () => {
        const h = stub(aiService);
        const r = await aiService.chat('hola', base({ forceClaude: true, summary: 'Quiere bajar 12 kg y prefiere cápsulas.' }));
        expect(lastUser(h)).toContain('RESUMEN PREVIO');
        record('claude con resumen', h, r);
    });
    test('sin historial', async () => {
        const h = stub(aiService);
        const r = await aiService.chat('hola', base({ forceClaude: true, history: [] }));
        expect(lastUser(h)).not.toContain('TU ÚLTIMO MENSAJE');
        record('claude sin historial', h, r);
    });
    test('historial solo del cliente: no hay "último mensaje del bot"', async () => {
        const h = stub(aiService);
        const r = await aiService.chat('hola?', base({ forceClaude: true, history: [{ role: 'user', content: 'hola' }] }));
        expect(lastUser(h)).not.toContain('TU ÚLTIMO MENSAJE');
        record('claude historial solo cliente', h, r);
    });
});

describe('estado del cliente en el turno user', () => {
    const cases = [
        ['carrito y total', { selectedProduct: 'Cápsulas de nuez de la india', cart: [{ product: 'Cápsulas', plan: '120', price: '68.900' }], totalPrice: '68.900' }, 'TOTAL AUTORITATIVO A PAGAR: $68.900'],
        ['tarjeta', { selectedProduct: 'Gotas', totalPrice: '54.900', paymentMethod: 'mercadopago' }, 'Tarjeta de crédito (ya pagó online)'],
        ['transferencia', { paymentMethod: 'transferencia' }, 'Transferencia bancaria'],
        ['retiro', { paymentMethod: 'contrarembolso', shippingChoice: 'retiro' }, 'Contrarrembolso — retiro en sucursal'],
        ['legacy seña pagada', { paymentMethod: 'contrarembolso', senaPaid: true, senaAmount: 10000 }, '[Legacy] Contra reembolso con seña pagada'],
        ['legacy seña pendiente', { paymentMethod: 'efectivo', senaAmount: 10000 }, 'esperando seña de $10.000'],
        ['contrarrembolso sin seña', { paymentMethod: 'contrarembolso' }, 'Contrarrembolso — retiro en sucursal'],
        ['método desconocido', { paymentMethod: 'bitcoin' }, 'Método de pago elegido: bitcoin'],
        ['datos parciales', { partialAddress: { nombre: 'Ana', calle: 'Mitre 100' } }, 'Datos parciales: Ana, Mitre 100, ?, CP ?'],
    ];
    for (const [name, userState, expected] of cases) {
        test(name, async () => {
            const h = stub(aiService);
            const r = await aiService.chat('ok', base({ forceClaude: true, step: 'waiting_final_confirmation', userState }));
            expect(lastUser(h)).toContain(expected);
            record(`estado ${name}`, h, r);
        });
    }
});

describe('fallbacks entre motores', () => {
    test('Claude sin tool_use → cae a OpenAI', async () => {
        const h = stub(aiService, { claude: 'no_tool' });
        const r = await aiService.chat('hola', base({ forceClaude: true }));
        expect(h.calls.claude).toHaveLength(1);
        expect(h.calls.openai).toHaveLength(1);
        expect(r.response).toBe('*Hola desde GPT*');
        record('claude sin tool_use', h, r);
    });
    test('Claude tira error → cae a OpenAI', async () => {
        const h = stub(aiService, { claude: 'throw' });
        const r = await aiService.chat('hola', base({ forceClaude: true }));
        expect(h.calls.openai).toHaveLength(1);
        record('claude tira', h, r);
    });
    test('OpenAI directo: system + user con historial embebido', async () => {
        const h = stub(aiService);
        const r = await aiService.chat('cuánto sale?', base({ forceClaude: false }));
        expect(h.calls.claude).toHaveLength(0);
        const msgs = h.calls.openai[0].messages;
        expect(msgs.map(m => m.role)).toEqual(['system', 'user']);
        expect(msgs[1].content).toContain('HISTORIAL RECIENTE');
        expect(msgs[1].content).toContain('INSTRUCCIONES:');
        record('openai waiting_weight', h, r);
    });
    test('OpenAI con MP apagado y carrito', async () => {
        const h = stub(aiService);
        const r = await aiService.chat('lo quiero', base({ forceClaude: false, step: 'waiting_plan_choice', mpEnabled: false, userState: { cart: [{ product: 'Gotas', plan: '60', price: '54.900' }], totalPrice: '54.900' } }));
        record('openai plan_choice mp off', h, r);
    });
    test('OpenAI sin tool_calls → aiUnavailable', async () => {
        const h = stub(aiService, { openai: 'no_tool' });
        const r = await aiService.chat('hola', base({ forceClaude: false }));
        expect(r).toEqual({ response: null, goalMet: false, aiUnavailable: true });
        record('openai sin tool_calls', h, r);
    });
    test('OpenAI tira error → aiUnavailable', async () => {
        const h = stub(aiService, { openai: 'throw' });
        const r = await aiService.chat('hola', base({ forceClaude: false }));
        expect(r.aiUnavailable).toBe(true);
        record('openai tira', h, r);
    });
});

describe('cache semántico, A/B y embudo', () => {
    test('A/B → Claude: miss, y guarda la respuesta con namespace claude', async () => {
        const h = stub(aiService, { useClaude: true });
        const r = await aiService.chat('de dónde son?', base({ step: 'waiting_weight', history: [] }));
        expect(lookupSemanticCache).toHaveBeenCalledWith(expect.anything(), 'waiting_weight', 'de dónde son?', 'claude');
        expect(storeSemanticCache).toHaveBeenCalledWith(expect.anything(), 'waiting_weight', 'de dónde son?', '**Hola** desde Claude', 'claude');
        record('semantico claude miss', h, r);
    });
    test('A/B → OpenAI: namespace openai', async () => {
        const h = stub(aiService, { useClaude: false });
        const r = await aiService.chat('de dónde son?', base({ history: [] }));
        expect(lookupSemanticCache.mock.calls[0][3]).toBe('openai');
        record('semantico openai miss', h, r);
    });
    test('MP apagado separa el namespace (:nomp)', async () => {
        const h = stub(aiService, { useClaude: false });
        const r = await aiService.chat('de dónde son?', base({ history: [], mpEnabled: false }));
        expect(lookupSemanticCache.mock.calls[0][3]).toBe('openai:nomp');
        record('semantico nomp', h, r);
    });
    test('hit: devuelve la cacheada y no llama a ningún proveedor', async () => {
        lookupSemanticCache.mockResolvedValueOnce({ response: '**cacheada**' });
        const h = stub(aiService, { useClaude: true });
        const r = await aiService.chat('de dónde son?', base({ history: [] }));
        expect(r).toEqual({ response: '*cacheada*', goalMet: false, extractedData: null });
        expect(h.calls.claude).toHaveLength(0);
        expect(h.calls.openai).toHaveLength(0);
        expect(incrementAiCallCount).not.toHaveBeenCalled();
        record('semantico hit', h, r);
    });
    test('con contexto de pedido no consulta ni guarda el cache semántico', async () => {
        const h = stub(aiService, { useClaude: true });
        const r = await aiService.chat('ok', base({ userState: { cart: [{ product: 'Gotas', plan: '60', price: '54.900' }], totalPrice: '54.900' } }));
        expect(lookupSemanticCache).not.toHaveBeenCalled();
        expect(storeSemanticCache).not.toHaveBeenCalled();
        record('semantico con pedido', h, r);
    });
    test('postdatado cuenta como contexto de pedido', async () => {
        const h = stub(aiService, { useClaude: false });
        const r = await aiService.chat('ok', base({ userState: { postdatado: '2026-10-01' } }));
        expect(lookupSemanticCache).not.toHaveBeenCalled();
        record('semantico postdatado', h, r);
    });
    test('si avanzó el paso (goalMet) no se guarda en el cache semántico', async () => {
        const h = stub(aiService, { useClaude: false, openai: 'goal' });
        const r = await aiService.chat('quiero cápsulas', base({ history: [] }));
        expect(storeSemanticCache).not.toHaveBeenCalled();
        expect(r).toEqual({ response: '*Hola desde GPT*', goalMet: true, extractedData: 'PRODUCTO: capsulas' });
        record('semantico goalMet', h, r);
    });
    test('sin seller/teléfono no se cuenta la llamada en el embudo', async () => {
        const h = stub(aiService);
        const r = await aiService.chat('hola', base({ forceClaude: false, sellerId: undefined, phone: undefined }));
        expect(incrementAiCallCount).not.toHaveBeenCalled();
        record('embudo sin seller', h, r);
    });
    test('cache exact-match: la misma llamada dos veces le pega una sola vez al proveedor', async () => {
        const h = stub(aiService);
        const ctx = base({ forceClaude: false });
        const r1 = await aiService.chat('hola repetido', ctx);
        const r2 = await aiService.chat('hola repetido', ctx);
        expect(h.calls.openai).toHaveLength(1);
        expect(r2).toEqual(r1);
        record('cache exact-match', h, [r1, r2]);
    });
});

describe('turnos no estructurados (WA_STRUCTURED_TURNS=0)', () => {
    test('historial embebido en un solo turno y system en un string', async () => {
        const prev = process.env.WA_STRUCTURED_TURNS;
        process.env.WA_STRUCTURED_TURNS = '0';
        let svc;
        jest.isolateModules(() => { svc = require('../src/services/ai').aiService; });
        if (prev === undefined) delete process.env.WA_STRUCTURED_TURNS; else process.env.WA_STRUCTURED_TURNS = prev;

        const h = stub(svc);
        const r = await svc.chat('cuánto sale?', base({ forceClaude: true }));
        const arg = h.calls.claude[0];
        expect(typeof arg.system).toBe('string');
        expect(arg.messages).toHaveLength(1);
        expect(arg.messages[0].content).toContain('HISTORIAL RECIENTE');
        record('no estructurado', h, r);
    });
});
