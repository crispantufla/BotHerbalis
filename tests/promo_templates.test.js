/**
 * Campañas promo — el texto que recibe cada persona (oct-2026).
 *
 *  - Cada destinatario recibe una variante distinta; la misma persona en la
 *    misma campaña recibe siempre el mismo texto (reintentos).
 *  - El precio sale de pricing.ts (promoPrice60), nunca del código.
 *  - Nada de placeholders sin resolver ni promesas falsas ("en tu puerta").
 */
const {
    renderPromoMessage, samplePromoMessages, countCombinations,
    resolveSpintax, seededRandom, firstNameFor, DEFAULT_PROMO_TEMPLATES, mergeTemplates,
} = require('../src/services/promo/promoTemplates');
const { _getPromoPrice60 } = require('../src/flows/utils/pricing');

describe('precio promo (pricing.ts)', () => {
    test('cápsulas y gotas bajan al precio promo; semillas se queda con el de lista (más bajo)', () => {
        expect(_getPromoPrice60('Cápsulas de nuez de la india')).toBe('44.900');
        expect(_getPromoPrice60('Gotas')).toBe('44.900');
        expect(_getPromoPrice60('Semillas')).toBe('36.900');
    });
});

describe('renderPromoMessage', () => {
    const base = { campaignId: 'camp-1', phone: '5493411234567' };

    test('es determinístico por (campaña, teléfono) y cambia entre campañas', () => {
        const a = renderPromoMessage(base);
        const b = renderPromoMessage(base);
        const c = renderPromoMessage({ ...base, campaignId: 'camp-2' });
        expect(a).toBe(b);
        expect(c).not.toBe(a);
    });

    test('lleva el precio promo y la palabra PROMO como disparador', () => {
        const t = renderPromoMessage(base);
        expect(t).toMatch(/\$44\.900/);
        expect(t).toMatch(/\*PROMO\*/);
        expect(t).not.toMatch(/\{\{/);
    });

    test('con nombre lo saluda por el nombre; sin nombre o con uno raro, no', () => {
        expect(renderPromoMessage({ ...base, name: 'maría josé pérez' })).toMatch(/María/);
        expect(renderPromoMessage({ ...base, name: 'Juan' })).toMatch(/Juan/);
        const noName = renderPromoMessage({ ...base, name: null });
        expect(noName).not.toMatch(/undefined|null/);
        expect(firstNameFor('5493411234567')).toBe('');
        expect(firstNameFor('a')).toBe('');
    });

    test('200 teléfonos distintos → casi todos textos distintos', () => {
        const seen = new Set();
        for (let i = 0; i < 200; i++) {
            seen.add(renderPromoMessage({ campaignId: 'camp-x', phone: `54934100${String(10000 + i * 37).slice(-5)}` }));
        }
        expect(seen.size).toBeGreaterThan(190);
    });

    test('ninguna variante promete entrega en la puerta ni cartero (a domicilio va prepago)', () => {
        const all = Object.values(DEFAULT_PROMO_TEMPLATES).flat().join('\n');
        expect(all).not.toMatch(/puerta|cartero/i);
        expect(all).not.toMatch(/\d\d\.\d\d\d/); // ningún precio escrito en las plantillas
    });

    test('hay más de 100.000 combinaciones de bloques', () => {
        expect(countCombinations()).toBeGreaterThan(100000);
    });

    test('plantillas propias reemplazan por bloque; líneas vacías se ignoran', () => {
        const tpl = mergeTemplates({ greeting: ['Hola {{NAME}}', '', '  '], cta: null });
        expect(tpl.greeting).toEqual(['Hola {{NAME}}']);
        expect(tpl.cta).toBe(DEFAULT_PROMO_TEMPLATES.cta);
        const t = renderPromoMessage({ ...base, templates: { greeting: ['Hola{{NAME_COMMA}}!!'] } });
        expect(t.startsWith('Hola!!')).toBe(true);
    });

    test('sin precio promo cargado no arma el texto', () => {
        expect(() => renderPromoMessage({ ...base, price60: '' , templates: null })).not.toThrow(); // '' → cae a pricing
        const mod = require('../src/flows/utils/pricing');
        const spy = jest.spyOn(mod, '_getPromoPrice60').mockReturnValue(null);
        // renderPromoMessage importa la función por binding de módulo CJS: el spy aplica.
        try {
            expect(() => renderPromoMessage(base)).toThrow(/precio promo/i);
        } finally { spy.mockRestore(); }
    });
});

describe('spintax y PRNG', () => {
    test('resuelve {a|b} y deja {{PLACEHOLDER}} intacto', () => {
        const r = seededRandom(7);
        const out = resolveSpintax('{uno|dos} {{NAME}} {tres|cuatro}', r);
        expect(out).toMatch(/^(uno|dos) \{\{NAME\}\} (tres|cuatro)$/);
    });
    test('seededRandom es reproducible', () => {
        const a = seededRandom(123), b = seededRandom(123);
        expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    });
    test('samplePromoMessages devuelve n textos', () => {
        expect(samplePromoMessages(4)).toHaveLength(4);
    });
});
