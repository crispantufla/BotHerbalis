require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });

(async () => {
    try {
        // Estado de Users abr-may (la columna es 'data' o jsonb, no 'state')
        const r0 = await pool.query(`
            SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND table_name='User' ORDER BY ordinal_position
        `);
        console.log('=== COLUMNAS User ===');
        r0.rows.forEach((r: any) => console.log(r.column_name, r.data_type));

        // ChatLog activity reciente
        const r1 = await pool.query(`
            SELECT DATE_TRUNC('day', "timestamp") AS d, role, COUNT(*)::int AS c
            FROM "ChatLog"
            WHERE "timestamp" > '2026-04-01'
            GROUP BY d, role
            ORDER BY d DESC, role
            LIMIT 60
        `);
        console.log('\n=== ChatLog actividad reciente ===');
        r1.rows.forEach((r: any) => console.log(r.d.toISOString().slice(0, 10), r.role, r.c));

        // DailyStats lo más reciente
        try {
            const r2 = await pool.query(`SELECT * FROM "DailyStats" ORDER BY "date" DESC LIMIT 20`);
            console.log('\n=== DailyStats (últimos 20) ===');
            r2.rows.forEach((r: any) => console.log(JSON.stringify(r)));
        } catch (e: any) { console.log('DailyStats err:', e.message); }

        // BotConfig (donde se guarda activeScript y scriptStats)
        try {
            const r3 = await pool.query(`SELECT "id", "instanceId", "key", "value" FROM "BotConfig" WHERE "key" IN ('activeScript','scriptStats','effectiveScript','config') ORDER BY "instanceId", "key"`);
            console.log('\n=== BotConfig (script & stats) ===');
            r3.rows.forEach((r: any) => console.log(r.instanceId, r.key, '|', JSON.stringify(r.value).slice(0, 300)));
        } catch (e: any) { console.log('BotConfig err:', e.message); }

        // Cuántos User están "pausados"
        const r4 = await pool.query(`
            SELECT "instanceId", COUNT(*) FILTER (WHERE "isPaused"=true)::int AS paused, COUNT(*)::int AS total
            FROM "User"
            GROUP BY "instanceId"
            ORDER BY total DESC
        `);
        console.log('\n=== Users pausados ===');
        r4.rows.forEach((r: any) => console.log(r.instanceId, 'paused:', r.paused, '/', r.total));

        // Último mensaje cualquier sender
        const r5 = await pool.query(`SELECT MAX("timestamp") AS last FROM "ChatLog"`);
        console.log('\n=== Último ChatLog ===', r5.rows[0]);

        // Mensajes último día con role bot
        const r6 = await pool.query(`
            SELECT DATE_TRUNC('day', "timestamp") AS d, role, COUNT(*)::int AS c
            FROM "ChatLog"
            WHERE "timestamp" > '2026-05-01'
            GROUP BY d, role
            ORDER BY d DESC, role
        `);
        console.log('\n=== ChatLog desde may 1 ===');
        r6.rows.forEach((r: any) => console.log(r.d.toISOString().slice(0, 10), r.role, r.c));

        // ¿Cuántos Users en mayo y dónde quedaron?
        const r7 = await pool.query(`
            SELECT phone, "instanceId", "isPaused", "createdAt", LEFT("dataJson"::text, 200) AS data_preview
            FROM "User"
            WHERE "createdAt" > '2026-05-01'
            ORDER BY "createdAt" DESC
            LIMIT 30
        `);
        console.log('\n=== Users de mayo (top 30) ===');
        r7.rows.forEach((r: any) => console.log(r.phone, r.instanceId, 'paused:', r.isPaused, r.createdAt?.toISOString?.()?.slice(0, 10), '|', r.data_preview?.slice(0, 100)));
    } catch (e: any) {
        console.log('ERR', e.message);
    }
    await pool.end();
})();
