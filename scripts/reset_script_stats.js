/**
 * Reinicia los contadores scriptStats (started/completed) para V5 y V6 en
 * todos los sellers de la DB. One-off — ejecutar después de cambios sustanciales
 * en los guiones para empezar a medir conversión de cero.
 *
 * Uso:
 *   DATABASE_URL=postgresql://... node scripts/reset_script_stats.js
 */
const { Client } = require('pg');

(async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
        await client.connect();
        const before = await client.query(
            'SELECT "instanceId", value FROM "BotConfig" WHERE key = $1',
            ['scriptStats']
        );
        console.log(`Encontrados ${before.rows.length} sellers con scriptStats.`);
        for (const row of before.rows) {
            console.log(`  seller=${row.instanceId} (antes): ${row.value}`);
        }
        const newValue = JSON.stringify({
            v5: { started: 0, completed: 0 },
            v6: { started: 0, completed: 0 }
        });
        const res = await client.query(
            'UPDATE "BotConfig" SET value = $1 WHERE key = $2 RETURNING "instanceId"',
            [newValue, 'scriptStats']
        );
        console.log(`Actualizadas ${res.rowCount} filas a ${newValue}.`);
        console.log('OK.');
    } catch (e) {
        console.error('ERROR:', e.message);
        process.exit(1);
    } finally {
        await client.end();
    }
})();
