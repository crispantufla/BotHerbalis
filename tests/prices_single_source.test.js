/**
 * Una sola fuente de precios.
 *
 * Hasta el 2026-09-13 prices.json se leía en tres lugares, cada uno con su
 * propia tabla de respaldo escrita en el código:
 *   - pricing.ts (el flujo del bot)
 *   - aiPrompts.ts (los prompts de la IA), con una caché de 60 s
 *   - GET /prices (el Editor de Precios), con una tabla de precios VIEJOS
 * y el lector de pricing.ts se quedaba pegado a un archivo de respaldo aunque
 * después el editor guardara el bueno. Estos tests fijan el comportamiento
 * nuevo, sin tocar el repo: cada uno trabaja en un DATA_DIR temporal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_PRICES = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/prices.json'), 'utf8'));

async function withDataDir(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'));
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = tmp;               // pricing.ts lo lee al cargarse
    try {
        let pricing, aiPrompts;
        jest.isolateModules(() => {
            pricing = require('../src/flows/utils/pricing');
            aiPrompts = require('../src/services/aiPrompts');
        });
        return await fn({ tmp, pricing, aiPrompts });
    } finally {
        if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

const touch = (file, iso) => fs.utimesSync(file, new Date(iso), new Date(iso));

describe('una sola fuente de precios', () => {

    test('lo que guarda el editor en DATA_DIR lo ve el bot sin reiniciar', async () => {
        await withDataDir(async ({ tmp, pricing }) => {
            // Volumen nuevo: DATA_DIR sin prices.json → cae al data/prices.json del repo
            expect(pricing._getPrices()['Cápsulas']['60']).toBe(REPO_PRICES['Cápsulas']['60']);

            // El admin guarda desde el Editor de Precios (POST /prices escribe en DATA_DIR)
            const saved = { ...REPO_PRICES, 'Cápsulas': { '60': '99.999', '120': '99.999' } };
            fs.writeFileSync(path.join(tmp, 'prices.json'), JSON.stringify(saved));

            // Antes quedaba pegado al respaldo y seguía devolviendo el precio viejo
            expect(pricing._getPrices()['Cápsulas']['60']).toBe('99.999');
        });
    });

    test('la IA ve un cambio de precio en la lectura siguiente, no a los 60 s', async () => {
        await withDataDir(async ({ tmp, pricing, aiPrompts }) => {
            const file = path.join(tmp, 'prices.json');
            fs.writeFileSync(file, JSON.stringify(REPO_PRICES));
            touch(file, '2026-01-01T00:00:00Z');
            expect((await aiPrompts._getPrices())['Gotas']['120']).toBe(REPO_PRICES['Gotas']['120']);

            fs.writeFileSync(file, JSON.stringify({ ...REPO_PRICES, 'Gotas': { '60': '1.000', '120': '2.000' } }));
            touch(file, '2026-02-01T00:00:00Z');

            expect((await aiPrompts._getPrices())['Gotas']['120']).toBe('2.000');
            expect(pricing._getPrices()['Gotas']['120']).toBe('2.000');
        });
    });

    test('el flujo y la IA cotizan exactamente lo mismo', async () => {
        await withDataDir(async ({ tmp, pricing, aiPrompts }) => {
            fs.writeFileSync(path.join(tmp, 'prices.json'), JSON.stringify(REPO_PRICES));
            const ai = await aiPrompts._getPrices();
            const flow = pricing._getPrices();
            for (const product of ['Cápsulas', 'Semillas', 'Gotas']) {
                for (const plan of ['60', '120']) expect(ai[product][plan]).toBe(flow[product][plan]);
            }
        });
    });

    test('a los prompts no les falta nada aunque el archivo venga incompleto', async () => {
        await withDataDir(async ({ tmp, pricing, aiPrompts }) => {
            const { costoLogistico, ...sinCosto } = REPO_PRICES;
            fs.writeFileSync(path.join(tmp, 'prices.json'), JSON.stringify(sinCosto));
            expect(pricing._getPrices().costoLogistico).toBeUndefined();
            expect((await aiPrompts._getPrices()).costoLogistico).toBe(pricing.FALLBACK_PRICES.costoLogistico);
        });
    });

    test('la tabla de respaldo es igual a data/prices.json (la copia que viaja en la imagen)', () => {
        const { FALLBACK_PRICES } = require('../src/flows/utils/pricing');
        expect(FALLBACK_PRICES).toEqual(REPO_PRICES);
    });
});
