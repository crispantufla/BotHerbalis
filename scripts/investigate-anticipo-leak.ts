/**
 * Investiga por qué el bot SIGUE mencionando "anticipo $10.000"
 * después de que se supone que el modelo se reemplazó.
 *
 * Busca el mensaje literal en ChatLog y revisa:
 * - Cuándo fue (timestamp)
 * - Qué seller
 * - Qué versión de guion tiene activa ese seller
 * - Qué mensajes adyacentes en la conversación
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

async function q(sql: string, params: any[] = []) {
    const r = await pool.query(sql, params);
    return r.rows;
}

async function main() {
    console.log('═══ MENSAJES DEL BOT MENCIONANDO "anticipo" o "10.000" POST 2026-05-13 ═══\n');

    const rows = await q(
        `SELECT cl."instanceId", cl."userPhone", cl."content", cl."timestamp"
         FROM "ChatLog" cl
         WHERE cl."timestamp" >= $1
         AND cl.role = 'bot'
         AND (cl.content ILIKE '%anticipo%' OR cl.content ILIKE '%10.000%' OR cl.content ILIKE '%10000%')
         ORDER BY cl."timestamp" DESC
         LIMIT 50`,
        ['2026-05-13T00:00:00-03:00']
    );

    console.log(`Encontrados: ${rows.length}\n`);
    rows.forEach((r: any) => {
        const ts = new Date(r.timestamp).toISOString();
        console.log(`[${ts}] seller=${r.instanceId} phone=${r.userPhone}`);
        console.log(`  ${String(r.content).slice(0, 280)}\n`);
    });

    // Por fecha — agrupar
    console.log('\n═══ AGREGADO POR DIA ═══');
    const grouped = await q(
        `SELECT DATE("timestamp" AT TIME ZONE 'America/Argentina/Buenos_Aires') AS day,
                "instanceId",
                COUNT(*)::int AS c
         FROM "ChatLog"
         WHERE "timestamp" >= $1 AND role = 'bot'
         AND (content ILIKE '%anticipo%' OR content ILIKE '%$10.000%' OR content ILIKE '%10.000%')
         GROUP BY day, "instanceId"
         ORDER BY day DESC, c DESC`,
        ['2026-05-13T00:00:00-03:00']
    );
    grouped.forEach((g: any) => {
        console.log(`  ${g.day.toISOString().slice(0, 10)}  ${g.instanceId.padEnd(15)}  ${g.c} mensajes`);
    });

    // Activos scripts por seller
    console.log('\n═══ activeScript POR SELLER ═══');
    const scripts = await q(
        `SELECT "instanceId", value FROM "BotConfig" WHERE key = 'activeScript' ORDER BY "instanceId"`
    );
    scripts.forEach((s: any) => {
        console.log(`  ${s.instanceId.padEnd(15)}  -> ${s.value}`);
    });

    // Check semantic cache for legacy responses
    console.log('\n═══ AiSemanticCache — entries que mencionan anticipo/10000 ═══');
    try {
        const cache = await q(
            `SELECT step, "userText", response, hits, "lastHit"
             FROM "AiSemanticCache"
             WHERE response ILIKE '%anticipo%' OR response ILIKE '%10.000%' OR response ILIKE '%10000%'
             ORDER BY hits DESC LIMIT 30`
        );
        if (cache.length === 0) {
            console.log('  (vacío — bien)');
        } else {
            cache.forEach((c: any) => {
                console.log(`  step=${c.step} hits=${c.hits}  lastHit=${c.lastHit.toISOString()}`);
                console.log(`    userText: ${c.userText.slice(0, 100)}`);
                console.log(`    response: ${c.response.slice(0, 200)}\n`);
            });
        }
    } catch (e: any) {
        console.log('  (tabla no existe o error:', e.message, ')');
    }
}

main().catch(console.error).finally(() => pool.end());
