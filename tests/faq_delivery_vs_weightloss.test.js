/**
 * Regresión (reporte admin 2026-06-19, 5493425380805): el cliente preguntó
 * "Demora mucho en bajar eso kilo?" (cuánto TARDA EN BAJAR DE PESO) y el bot
 * soltó el menú de ENVÍO ("📦 Envíos por Correo Argentino — 7 a 10 días…").
 *
 * Causa: la FAQ de envío en knowledge_v7.json tiene keywords ambiguas
 * ("tarda", "demora", "tiempo"). "demora" matcheaba aunque la pregunta era
 * sobre el ritmo de descenso, no sobre el envío.
 *
 * Fix: guard en globalFaq.handleFaq — si el keyword que matchea es de tiempo
 * (tarda/demora/tiempo) y el mensaje habla de bajar/kilos/peso, NO dispara la
 * FAQ de envío (la responde el paso/IA). Las preguntas de envío reales siguen.
 */
jest.mock('../db', () => ({ prisma: {} }));
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../src/services/funnelLogger', () => ({
    logStepTransition: jest.fn(), markExit: jest.fn().mockResolvedValue(undefined), logMessage: jest.fn().mockResolvedValue(undefined),
}));

const fs = require('fs');
const path = require('path');
const { handleFaq } = require('../src/flows/globals/globalFaq');
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v7.json'), 'utf8'));

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function run(text, step = 'waiting_preference') {
    const sent = [];
    const state = { step, history: [] };
    const deps = { sendMessageWithDelay: async (_id, m) => { sent.push(m); }, saveState: jest.fn() };
    return handleFaq('u@c.us', text, norm(text), state, knowledge, deps).then(res => ({ res, sent }));
}

describe('globalFaq — envío vs. ritmo de descenso', () => {
    test('"Demora mucho en bajar eso kilo?" NO dispara la FAQ de envío', async () => {
        const { res, sent } = await run('Demora mucho en bajar eso kilo?');
        // No matchea la FAQ → cae al paso/IA. Y si por algo respondiera, NUNCA el menú de envío.
        expect(res).toBeNull();
        expect(sent.join(' ')).not.toMatch(/Correo Argentino|Retiro en sucursal|días hábiles/i);
    });

    test('variantes de "tardar en bajar" tampoco disparan envío', async () => {
        for (const t of ['cuanto tarda en bajar de peso', 'en cuanto tiempo bajo 10 kilos', 'tarda mucho en bajar?']) {
            const { res, sent } = await run(t);
            expect(sent.join(' ')).not.toMatch(/Correo Argentino|Retiro en sucursal/i);
            expect(res).toBeNull();
        }
    });

    test('REGRESIÓN: preguntas de envío reales SIGUEN respondiendo el menú de envío', async () => {
        for (const t of ['cuanto tarda en llegar?', 'como lo recibo?', 'cuanto demora el envio?']) {
            const { res, sent } = await run(t);
            expect(res).toEqual({ matched: true });
            expect(sent.join(' ')).toMatch(/Correo Argentino/i);
        }
    });
});
