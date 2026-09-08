/**
 * Probe del prompt cache de Anthropic (path Claude de aiService.chat()).
 *
 * Arma la request EXACTAMENTE como _claudeChat (tools + system en bloques con
 * cache_control 1h + turno user) y la manda 3 veces, mostrando los 4 contadores de
 * usage de cada una:
 *   1. step A  → escribe la caché (cache_creation > 0, cache_read = 0)
 *   2. step A  → lee TODO el prefijo (cache_read ≈ tools + system, cache_creation = 0)
 *   3. step B  → lee solo el bloque CORE compartido y escribe el módulo del step B
 * Si en la 2ª cache_read es 0, hay un invalidador silencioso en el prefijo (algo
 * dinámico se coló al system; ver _buildSystemBlocks). Si en la 3ª cache_read es 0,
 * el bloque core NO es byte-idéntico entre steps.
 *
 * Gasta ~US$0.03 en Haiku (una escritura + dos lecturas). No usa el node-cache
 * local (llama al SDK directo), por eso las 3 llamadas llegan a la API.
 *
 * Uso (desde la raíz del repo, con la key de prod):
 *   export ANTHROPIC_API_KEY="$(railway variables -s MainHerbalisBot --kv | grep '^ANTHROPIC_API_KEY=' | cut -d= -f2-)"
 *   npx tsx scripts/ai-cache-probe.ts [stepA=waiting_weight] [stepB=waiting_payment_method] [model=claude-haiku-4-5-20251001]
 */
require('dotenv').config(); // OPENAI_API_KEY del .env, para que el init de aiService no loguee error
import { _buildSystemBlocks, CLAUDE_CACHE_CONTROL, CLAUDE_DIALOG_TOOL } from '../src/services/ai';

const [stepA = 'waiting_weight', stepB = 'waiting_payment_method', model = 'claude-haiku-4-5-20251001'] = process.argv.slice(2);

(async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30_000 });

    const userPrompt = `ETAPA ACTUAL: "${stepA}"\nOBJETIVO DEL PASO: "probe"\nMENSAJE DEL USUARIO: "hola, cuánto sale?"\n\nAplicá las INSTRUCCIONES DE RESPUESTA del system.\n`;
    const send = async (step: string, label: string) => {
        const blocks = await _buildSystemBlocks(step, true);
        const r: any = await client.messages.create({
            model,
            max_tokens: 200,
            temperature: 0.6,
            system: blocks.map(text => ({ type: 'text', text, cache_control: CLAUDE_CACHE_CONTROL })),
            messages: [{ role: 'user', content: userPrompt }],
            tools: [CLAUDE_DIALOG_TOOL],
            tool_choice: { type: 'tool', name: 'control_dialog_flow' },
        });
        const u = r.usage || {};
        console.log(`${label.padEnd(14)} in=${u.input_tokens} cache_w=${u.cache_creation_input_tokens} cache_r=${u.cache_read_input_tokens} out=${u.output_tokens}`);
        return u;
    };

    const u1 = await send(stepA, `1 ${stepA}`);
    const u2 = await send(stepA, `2 ${stepA}`);
    const u3 = await send(stepB, `3 ${stepB}`);

    const okSame = (u2.cache_read_input_tokens || 0) > 0 && (u2.cache_creation_input_tokens || 0) === 0;
    const okCross = (u3.cache_read_input_tokens || 0) > 0;
    console.log(okSame ? '✅ mismo step: prefijo servido de caché' : '❌ mismo step: NO hubo lectura de caché (invalidador silencioso)');
    console.log(okCross ? `✅ otro step: core compartido leído de caché (${u3.cache_read_input_tokens} tok)` : '❌ otro step: el core NO se compartió (bloque[0] no es byte-idéntico)');
    if (!u1.cache_creation_input_tokens) console.log('⚠️ la 1ª llamada no escribió caché (¿prefijo por debajo del mínimo del modelo, o ya estaba caliente?)');
    process.exit(okSame && okCross ? 0 : 1);
})().catch(e => { console.error('ERR', e?.message || e); process.exit(1); });
