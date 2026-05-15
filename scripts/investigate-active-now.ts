/**
 * Datos del seller activo después de abr 17 (bot_secundario, terciario)
 * para entender la conversión "actual" según el dashboard.
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000, max: 5 });

(async () => {
    try {
        // Todos los instanceIds + actividad
        const r1 = await pool.query(`
            SELECT "instanceId",
                   COUNT(*)::int AS users,
                   MIN("createdAt") AS first_user,
                   MAX("createdAt") AS last_user
            FROM "User"
            WHERE "createdAt" > '2026-04-15'
            GROUP BY "instanceId"
            ORDER BY last_user DESC
        `);
        console.log('=== USERS por instanceId (desde abr 15) ===');
        r1.rows.forEach((r: any) => console.log(`  ${r.instanceId.padEnd(20)} users=${r.users}  first=${r.first_user?.toISOString?.()?.slice(0, 10)}  last=${r.last_user?.toISOString?.()?.slice(0, 10)}`));

        const r2 = await pool.query(`
            SELECT "instanceId",
                   COUNT(*)::int AS orders,
                   MIN("createdAt") AS first_order,
                   MAX("createdAt") AS last_order
            FROM "Order"
            WHERE "createdAt" > '2026-04-15'
            GROUP BY "instanceId"
            ORDER BY last_order DESC NULLS LAST
        `);
        console.log('\n=== ORDERS por instanceId (desde abr 15) ===');
        if (r2.rows.length === 0) console.log('  (ninguna)');
        r2.rows.forEach((r: any) => console.log(`  ${r.instanceId.padEnd(20)} orders=${r.orders}  first=${r.first_order?.toISOString?.()?.slice(0, 10)}  last=${r.last_order?.toISOString?.()?.slice(0, 10)}`));

        // bot_secundario users + orders por día desde mayo 1
        const r3 = await pool.query(`
            SELECT DATE_TRUNC('day',"createdAt") AS d, COUNT(*)::int AS c
            FROM "User"
            WHERE "instanceId"='bot_secundario' AND "createdAt" > '2026-04-15'
            GROUP BY d ORDER BY d
        `);
        console.log('\n=== bot_secundario USERS por día ===');
        if (r3.rows.length === 0) console.log('  (ninguno — instance no genera users)');
        r3.rows.forEach((r: any) => console.log(`  ${r.d.toISOString().slice(0, 10)} ${r.c}`));

        // terciario
        const r4 = await pool.query(`
            SELECT DATE_TRUNC('day',"createdAt") AS d, COUNT(*)::int AS c
            FROM "User"
            WHERE "instanceId"='terciario' AND "createdAt" > '2026-04-15'
            GROUP BY d ORDER BY d
        `);
        console.log('\n=== terciario USERS por día ===');
        if (r4.rows.length === 0) console.log('  (ninguno)');
        r4.rows.forEach((r: any) => console.log(`  ${r.d.toISOString().slice(0, 10)} ${r.c}`));

        // ChatLog por instanceId desde abr 15
        const r5 = await pool.query(`
            SELECT "instanceId", role, COUNT(*)::int AS c, MAX("timestamp") AS last
            FROM "ChatLog"
            WHERE "timestamp" > '2026-04-15'
            GROUP BY "instanceId", role
            ORDER BY last DESC NULLS LAST
        `);
        console.log('\n=== ChatLog activity por instanceId+role (desde abr 15) ===');
        r5.rows.forEach((r: any) => console.log(`  ${(r.instanceId || '(null)').padEnd(20)} ${(r.role || '').padEnd(6)} c=${r.c}  last=${r.last?.toISOString?.()?.slice(0, 19)}`));

        // bot_secundario users por status (último step según history o pauseReason)
        const r6 = await pool.query(`
            SELECT
                COALESCE("pauseReason", '(activo, no pausado)') AS reason,
                COUNT(*)::int AS c
            FROM "User"
            WHERE "instanceId" IN ('bot_secundario','terciario') AND "createdAt" > '2026-04-15'
            GROUP BY reason ORDER BY c DESC
        `);
        console.log('\n=== bot_secundario+terciario users por pauseReason ===');
        r6.rows.forEach((r: any) => console.log(`  ${r.reason.padEnd(60)} ${r.c}`));

        // Conversión real bot_secundario vs scriptStats
        const r7 = await pool.query(`
            SELECT "instanceId", COUNT(*)::int AS c
            FROM "User"
            WHERE "instanceId" IN ('bot_secundario','terciario','default')
            GROUP BY "instanceId"
        `);
        const r8 = await pool.query(`
            SELECT "instanceId", COUNT(*)::int AS c, COUNT(*) FILTER (WHERE status != 'Cancelado')::int AS ok
            FROM "Order"
            WHERE "instanceId" IN ('bot_secundario','terciario','default')
            GROUP BY "instanceId"
        `);
        console.log('\n=== Conversión real por instanceId (lifetime) ===');
        for (const u of r7.rows) {
            const o = r8.rows.find((x: any) => x.instanceId === u.instanceId);
            const conv = o ? (o.ok / u.c * 100).toFixed(1) : '0';
            console.log(`  ${u.instanceId.padEnd(20)} users=${u.c}  orders=${o?.c || 0}  no_cancel=${o?.ok || 0}  conv=${conv}%`);
        }

        // Y horacio lifetime
        const [h1] = (await pool.query(`SELECT COUNT(*)::int AS c FROM "User" WHERE "instanceId"='horacio'`)).rows;
        const [h2] = (await pool.query(`SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE status != 'Cancelado')::int AS ok FROM "Order" WHERE "instanceId"='horacio'`)).rows;
        console.log(`  ${'horacio'.padEnd(20)} users=${h1.c}  orders=${h2.c}  no_cancel=${h2.ok}  conv=${(h2.ok / h1.c * 100).toFixed(1)}%`);

    } catch (e: any) {
        console.log('ERR', e.message);
    }
    await pool.end();
})();
