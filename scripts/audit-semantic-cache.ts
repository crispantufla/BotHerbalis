/**
 * Audit del semantic cache de IA. Mide:
 *   - Cuántas rows hay por step
 *   - Total de hits por step
 *   - Top-10 respuestas más usadas por step (las más riesgosas si están mal)
 *   - Distribución de longitudes
 *
 * Uso: DATABASE_URL=<url> npx tsx scripts/audit-semantic-cache.ts
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000, max: 5 });

(async () => {
    try {
        // Existe?
        const exists = await pool.query(`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='AiSemanticCache') AS exists`);
        console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
        console.log(`║  AUDIT — AiSemanticCache`);
        console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

        if (!exists.rows[0].exists) {
            console.log('Tabla AiSemanticCache no existe.');
            await pool.end();
            return;
        }

        // Columnas
        const cols = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='AiSemanticCache' ORDER BY ordinal_position`);
        console.log(`📋 Columnas: ${cols.rows.map((r: any) => r.column_name).join(', ')}\n`);

        // Totales por step
        const byStep = await pool.query(`
            SELECT step, COUNT(*)::int AS rows, SUM(hits)::int AS total_hits, MAX(hits)::int AS max_hits, AVG(hits)::float AS avg_hits
            FROM "AiSemanticCache"
            GROUP BY step
            ORDER BY total_hits DESC NULLS LAST
        `);
        console.log(`📊 ROWS Y HITS POR STEP`);
        console.log(`   ${'Step'.padEnd(35)}  ${'Rows'.padStart(6)}  ${'Hits'.padStart(8)}  ${'Max'.padStart(5)}  ${'Avg'.padStart(6)}`);
        byStep.rows.forEach((r: any) => {
            console.log(`   ${(r.step || '(null)').padEnd(35)}  ${String(r.rows).padStart(6)}  ${String(r.total_hits || 0).padStart(8)}  ${String(r.max_hits || 0).padStart(5)}  ${(r.avg_hits || 0).toFixed(1).padStart(6)}`);
        });

        const [totals] = (await pool.query(`SELECT COUNT(*)::int AS rows, SUM(hits)::int AS hits FROM "AiSemanticCache"`)).rows;
        console.log(`\n   TOTAL: ${totals.rows} rows · ${totals.hits || 0} hits acumulados`);

        // Top-10 respuestas más usadas por step (potenciales problemas si la respuesta no calza)
        console.log(`\n🔥 TOP RESPUESTAS MÁS USADAS POR STEP (revisar manualmente)`);
        const steps = byStep.rows.map((r: any) => r.step).slice(0, 5);
        for (const step of steps) {
            console.log(`\n   STEP: ${step}`);
            const top = await pool.query(`
                SELECT id, hits, LEFT(response, 250) AS preview, "lastHit"
                FROM "AiSemanticCache"
                WHERE step = $1
                ORDER BY hits DESC
                LIMIT 5
            `, [step]);
            top.rows.forEach((r: any, i: number) => {
                const preview = (r.preview || '').replace(/\s+/g, ' ').slice(0, 200);
                console.log(`     ${i + 1}. [hits=${r.hits}, lastHit=${r.lastHit?.toISOString?.()?.slice(0, 10)}]`);
                console.log(`        "${preview}"`);
            });
        }

        // Hits totales / total de chats — proxy del impacto del cache
        const [users] = (await pool.query(`SELECT COUNT(*)::int AS c FROM "User"`)).rows;
        const hitRate = totals.hits / (users.c || 1);
        console.log(`\n📈 IMPACTO`);
        console.log(`   Total hits cumulativos: ${totals.hits || 0}`);
        console.log(`   Total chats:            ${users.c}`);
        console.log(`   Ratio (cache hits/chat): ${hitRate.toFixed(2)} hits por chat`);

        console.log(`\n📋 RECOMENDACIONES`);
        console.log(`   1. Revisar los top-5 de cada step arriba — si alguna respuesta`);
        console.log(`      asume contexto (producto/plan/historial) que no era el del`);
        console.log(`      chat actual, esa row debería borrarse o no cachearse.`);
        console.log(`   2. Si encontrás respuestas genéricas-buenas: dejarlas.`);
        console.log(`      Si encontrás respuestas específicas-malas: borrar la row y`);
        console.log(`      subir SIM_THRESHOLD de 0.92 → 0.94 (semanticCache.ts:30).`);
        console.log(`   3. Para limpiar el cache de un step problemático:`);
        console.log(`      DELETE FROM "AiSemanticCache" WHERE step='waiting_X';\n`);

    } catch (e: any) {
        console.log('ERR', e.message);
    }
    await pool.end();
})();
