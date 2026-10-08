/**
 * Campañas promo — la IA reescribe el mensaje base (oct-2026).
 *
 *  - El mensaje base del vendedor va con el precio ya puesto; Claude devuelve
 *    una reescritura con ligeras diferencias.
 *  - Lo que vuelve se valida: precio exacto, la palabra PROMO, sin otro precio,
 *    sin placeholders ni links, largo parecido. Si no pasa, se reintenta una
 *    vez y después se cae a las plantillas (buildPromoText).
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../db', () => ({ prisma: {} }));

const { generatePromoVariation, validateVariation, resolveBaseMessage, DEFAULT_BASE_MESSAGE } = require('../src/services/promo/promoVariation');
const { buildPromoText, normalizePromoConfig } = require('../src/services/promo/promoDispatcher');

const PRICE = '44.900';
const base = resolveBaseMessage(DEFAULT_BASE_MESSAGE, PRICE, null);
const good = 'Hola 😊 ¿cómo estás? Nos quedó pendiente tu consulta por el tratamiento y, como arrancar cuesta, armamos algo para que lo pruebes: tratamiento completo de 60 días a $44.900. Envío gratis a todo el país y pago contra entrega: pagás cuando te llega. Hay pocas unidades. Si querés aprovecharla hoy, respondé PROMO y te tomo el pedido en un minuto.';

const client = (...texts) => {
    const create = jest.fn();
    texts.forEach(t => create.mockResolvedValueOnce({ content: [{ type: 'text', text: t }] }));
    return { messages: { create } };
};

describe('resolveBaseMessage', () => {
    test('pone el precio y el nombre en el texto del vendedor', () => {
        expect(base).toContain('$44.900');
        expect(base).not.toContain('{{');
        expect(resolveBaseMessage('Hola{{NAME_COMMA}} 👋', PRICE, 'maría josé')).toBe('Hola, María 👋');
        expect(resolveBaseMessage('Hola{{NAME_COMMA}} 👋', PRICE, null)).toBe('Hola 👋');
    });
});

describe('validateVariation', () => {
    test('acepta una reescritura correcta', () => {
        expect(validateVariation(good, base, PRICE)).toBeNull();
    });
    test.each([
        ['sin el precio', good.replace('$44.900', '$ cuarenta y cuatro mil')],
        ['sin la palabra PROMO', good.replace('PROMO', 'promo')],
        ['con otro precio', good + ' Antes salía $54.900.'],
        ['con placeholders', good + ' {{NAME}}'],
        ['con un link', good + ' https://herbalis.com'],
        ['largo fuera de rango', 'Respondé PROMO. $44.900'],
        ['entre comillas', `"${good}"`],
    ])('rechaza: %s', (reason, text) => {
        expect(validateVariation(text, base, PRICE)).toMatch(reason.split(' ')[0]);
    });
});

describe('generatePromoVariation', () => {
    test('manda el mensaje base con el precio y devuelve la reescritura válida', async () => {
        const c = client(good);
        const out = await generatePromoVariation({ baseMessage: DEFAULT_BASE_MESSAGE, price60: PRICE, name: 'Rosa', anthropic: c, model: 'm' });
        expect(out).toBe(good);
        const call = c.messages.create.mock.calls[0][0];
        expect(call.model).toBe('m');
        expect(call.messages[0].content).toContain('$44.900');
        expect(call.messages[0].content).toContain('Rosa');
        expect(call.system[0].text).toMatch(/PROMO/);
        expect(call.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    test('reintenta una vez si la primera reescritura no pasa', async () => {
        const c = client(good.replace('$44.900', '$44900'), good);
        const out = await generatePromoVariation({ baseMessage: DEFAULT_BASE_MESSAGE, price60: PRICE, anthropic: c, model: 'm' });
        expect(out).toBe(good);
        expect(c.messages.create).toHaveBeenCalledTimes(2);
    });

    test('dos reescrituras inválidas → lanza', async () => {
        const c = client('nada', 'nada');
        await expect(generatePromoVariation({ baseMessage: DEFAULT_BASE_MESSAGE, price60: PRICE, anthropic: c, model: 'm' })).rejects.toThrow(/válida/);
    });

    test('sin cliente de Anthropic → lanza', async () => {
        await expect(generatePromoVariation({ baseMessage: DEFAULT_BASE_MESSAGE, price60: PRICE, anthropic: null, model: 'm' })).rejects.toThrow(/Anthropic/);
    });
});

describe('buildPromoText', () => {
    const cfg = normalizePromoConfig({}, 'horacio');

    test('modo ai: usa la reescritura de la IA', async () => {
        const r = await buildPromoText({ cfg, campaignId: 'c', phone: '5493410000001', price60: PRICE, anthropic: client(good) });
        expect(r).toEqual({ text: good, via: 'ai' });
    });

    test('modo ai con la IA caída → cae a una variante de plantilla, con el precio', async () => {
        const c = { messages: { create: jest.fn().mockRejectedValue(new Error('429')) } };
        const r = await buildPromoText({ cfg, campaignId: 'c', phone: '5493410000001', price60: PRICE, anthropic: c });
        expect(r.via).toBe('templates');
        expect(r.text).toContain('$44.900');
        expect(r.text).toMatch(/\*PROMO\*/);
    });

    test('modo ai sin ANTHROPIC_API_KEY → plantillas', async () => {
        const r = await buildPromoText({ cfg, campaignId: 'c', phone: '5493410000001', price60: PRICE, anthropic: null });
        expect(r.via).toBe('templates');
    });

    test('modo templates: no llama a la IA', async () => {
        const c = client(good);
        const r = await buildPromoText({ cfg: normalizePromoConfig({ variationMode: 'templates' }, 'horacio'), campaignId: 'c', phone: '5493410000001', price60: PRICE, anthropic: c });
        expect(r.via).toBe('templates');
        expect(c.messages.create).not.toHaveBeenCalled();
    });

    test('el mensaje base propio reemplaza al default si tiene al menos 40 caracteres', () => {
        expect(normalizePromoConfig({ baseMessage: 'corto' }, 'h').baseMessage).toBe(DEFAULT_BASE_MESSAGE);
        const mine = 'Hola! Tengo una promo del tratamiento de 60 días a ${{PROMO_60}}. Respondé PROMO.';
        expect(normalizePromoConfig({ baseMessage: mine }, 'h').baseMessage).toBe(mine);
    });
});
