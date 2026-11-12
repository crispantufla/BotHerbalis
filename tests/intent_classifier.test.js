/**
 * Clasificador de mensajes (services/intentClassifier): contrato del módulo.
 * No llama a la API real: se le inyecta un cliente de mentira.
 */
jest.mock('../src/services/ai', () => ({ aiService: { anthropic: null } }));

const { classifyMessage, isTrivialMessage, isNotAChoice } = require('../src/services/intentClassifier');
const { _asksSomething } = require('../src/flows/utils/flowHelpers');

const fakeClient = (input, delayMs = 0) => ({
    messages: {
        create: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve({ content: input ? [{ type: 'tool_use', input }] : [] }), delayMs))),
    },
});

describe('isTrivialMessage', () => {
    test.each(['si', 'ok dale', '120', 'Capsulas', '', '/9j/4AAQSkZJRg' + 'A'.repeat(300)])('"%s" no se clasifica', (t) => {
        expect(isTrivialMessage(t)).toBe(true);
    });
    test.each(['Se toma una x dia', 'Son de Rosario', 'Quita el apetito?', 'Tengo 73 años'])('"%s" sí se clasifica', (t) => {
        expect(isTrivialMessage(t)).toBe(false);
    });
});

describe('classifyMessage', () => {
    test('devuelve los cuatro campos como booleanos y manda el último mensaje del vendedor', async () => {
        const client = fakeClient({ chooses: false, asks: true, objects: true, health: 'sí' });
        const res = await classifyMessage('tengo tarjeta pero me da miedo', { lastBotMessage: '¿Cómo querés abonar?', step: 'waiting_payment_method' }, client);
        expect(res).toEqual({ chooses: false, asks: true, objects: true, health: false });
        const req = client.messages.create.mock.calls[0][0];
        expect(req.tool_choice).toEqual({ type: 'tool', name: 'clasificar' });
        expect(req.messages[0].content).toContain('¿Cómo querés abonar?');
        expect(req.messages[0].content).toContain('tengo tarjeta pero me da miedo');
    });

    test('mensaje trivial → null sin llamar a la API', async () => {
        const client = fakeClient({ chooses: true, asks: false, objects: false, health: false });
        expect(await classifyMessage('si', {}, client)).toBeNull();
        expect(client.messages.create).not.toHaveBeenCalled();
    });

    test('sin cliente de Anthropic → null', async () => {
        expect(await classifyMessage('Se toma una x dia', {}, null)).toBeNull();
    });

    test('la API falla → null, no tira', async () => {
        const client = { messages: { create: jest.fn().mockRejectedValue(new Error('sin saldo')) } };
        expect(await classifyMessage('Se toma una x dia', {}, client)).toBeNull();
    });

    test('respuesta sin tool_use → null', async () => {
        expect(await classifyMessage('Se toma una x dia', {}, fakeClient(null))).toBeNull();
    });

    test('con INTENT_CLASSIFIER=0 queda apagado', async () => {
        process.env.INTENT_CLASSIFIER = '0';
        const client = fakeClient({ chooses: false, asks: true, objects: false, health: false });
        expect(await classifyMessage('Se toma una x dia', {}, client)).toBeNull();
        expect(client.messages.create).not.toHaveBeenCalled();
        delete process.env.INTENT_CLASSIFIER;
    });
});

describe('cómo lo leen los pasos', () => {
    test('isNotAChoice: pregunta u objeción sin elección', () => {
        expect(isNotAChoice({ chooses: false, asks: true, objects: false, health: false })).toBe(true);
        expect(isNotAChoice({ chooses: false, asks: false, objects: true, health: false })).toBe(true);
        expect(isNotAChoice({ chooses: true, asks: true, objects: false, health: false })).toBe(false);
        expect(isNotAChoice({ chooses: false, asks: false, objects: false, health: true })).toBe(false);
        expect(isNotAChoice(null)).toBe(false);
    });

    test('_asksSomething solo SUMA al detector por palabras', () => {
        const ask = { intent: { chooses: false, asks: true, objects: false, health: false } };
        const choice = { intent: { chooses: true, asks: false, objects: false, health: false } };
        expect(_asksSomething('Se toma una x dia', {})).toBe(false);           // sin IA: como antes
        expect(_asksSomething('Se toma una x dia', ask)).toBe(true);           // la IA la reconoce
        expect(_asksSomething('¿cuánto tarda?', choice)).toBe(true);           // el signo sigue mandando
        expect(_asksSomething('las capsulas', choice)).toBe(false);
    });
});
