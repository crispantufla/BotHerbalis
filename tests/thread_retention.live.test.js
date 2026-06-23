/**
 * SIM LIVE — retención del hilo contra el MODELO REAL.
 *
 * Corre conversaciones-TRAMPA (diseñadas para tentar al bot a re-preguntar datos
 * ya dados) contra el LLM de verdad y verifica que NO pierda el hilo. Es la única
 * forma de testear el COMPORTAMIENTO (lo que el sim determinista no puede).
 *
 * ⚠️ GATED: solo corre con RUN_LLM_SIMS=1 (consume tokens, es no-determinista y
 * lento). En `npm test` aparece como skipped. Para correrlo:  npm run test:sim
 *
 * Engine-aware: prueba el motor que tenga API key — Claude (path estructurado) si
 * hay ANTHROPIC_API_KEY, OpenAI si hay OPENAI_API_KEY. Así valida el motor real de
 * prod. Las aserciones son NEGATIVAS (el bot NO debe re-preguntar) → robustas ante
 * la variación de redacción del modelo.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { aiService } = require('../src/services/ai');

const knowledge = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v7.json'), 'utf8')); }
    catch { return {}; }
})();

const RUN = process.env.RUN_LLM_SIMS === '1';
const ENGINES = [
    { name: 'Claude', forceClaude: true, available: !!process.env.ANTHROPIC_API_KEY },
    { name: 'OpenAI', forceClaude: false, available: !!process.env.OPENAI_API_KEY },
];

// Re-pregunta del NOMBRE (el cliente ya lo dio) — no debe aparecer.
const RE_ASK_NAME = /c[óo]mo te llam|cu[áa]l es tu nombre|tu nombre completo|me dec[íi]s.*nombre|dec[íi]me tu nombre|pas[áa]me tu nombre/i;
// Re-pregunta de la LOCALIDAD (ya la dio) — no debe aparecer.
const RE_ASK_CITY = /de qu[ée] (localidad|ciudad|provincia)|en qu[ée] (localidad|ciudad)|de d[óo]nde (sos|nos escrib)/i;

async function runConversation(turns, forceClaude) {
    const history = [];
    const userState = { partialAddress: {}, cart: [] };
    const transcript = [];
    for (const turn of turns) {
        history.push({ role: 'user', content: turn.user, timestamp: Date.now() });
        const res = await aiService.chat(turn.user, {
            step: turn.step, goal: turn.goal, history, knowledge, userState,
            sellerId: 'horacio', phone: 'sim-thread-retention', forceClaude,
        });
        const bot = (res && res.response) || '';
        history.push({ role: 'bot', content: bot, timestamp: Date.now() });
        transcript.push({ user: turn.user, bot, assertNot: turn.assertNot });
    }
    return transcript;
}

const DATA_GOAL = 'Tomar los datos de envío: nombre, localidad y código postal';

// El cliente da nombre y localidad temprano; después pregunta otra cosa. Un bot que
// pierde el hilo re-pregunta el nombre o la localidad. No debe.
const NAME_TRAP = [
    { user: 'Hola! Quiero comprar las cápsulas. Me llamo Lucía', step: 'waiting_data', goal: DATA_GOAL },
    { user: 'soy de Merlo, Buenos Aires', step: 'waiting_data', goal: DATA_GOAL },
    { user: '¿y el pago cómo es?', step: 'waiting_data', goal: DATA_GOAL, assertNot: [RE_ASK_NAME, RE_ASK_CITY] },
    { user: 'ah dale, perfecto', step: 'waiting_data', goal: DATA_GOAL, assertNot: [RE_ASK_NAME] },
];

const describeFn = RUN ? describe : describe.skip;

describeFn('SIM LIVE — retención del hilo (modelo real)', () => {
    jest.setTimeout(90_000);

    for (const engine of ENGINES) {
        const testFn = engine.available ? test : test.skip;

        testFn(`[${engine.name}] no re-pregunta el nombre/localidad ya dados`, async () => {
            const transcript = await runConversation(NAME_TRAP, engine.forceClaude);

            const dialog = transcript.map(t => `👤 ${t.user}\n🤖 ${t.bot}`).join('\n');
            console.log(`\n===== [${engine.name}] TRAMPA NOMBRE =====\n${dialog}\n`);

            // Sanity: el bot respondió en todos los turnos.
            transcript.forEach((t) => expect(t.bot.length).toBeGreaterThan(0));

            // Aserción de hilo: ningún turno marcado re-pregunta lo ya dado. Si falla,
            // el diálogo completo ya quedó logueado arriba para diagnosticar.
            for (const t of transcript) {
                for (const re of (t.assertNot || [])) {
                    expect(t.bot).not.toMatch(re);
                }
            }
        });
    }
});
