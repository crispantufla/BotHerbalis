require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });

(async () => {
    try {
        // Todas las órdenes desde abril, incluyendo canceladas, todos los status
        const r1 = await pool.query(`
            SELECT DATE_TRUNC('day', "createdAt") AS d,
                   status,
                   COUNT(*)::int AS c
            FROM "Order"
            WHERE "createdAt" > '2026-04-01'
            GROUP BY d, status
            ORDER BY d, status
        `);
        console.log('=== ORDERS por día y status (desde abr 1) ===');
        r1.rows.forEach((r: any) => console.log(r.d.toISOString().slice(0, 10), r.status, r.c));

        // Cuántas tablas hay
        const r2 = await pool.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema='public'
            ORDER BY table_name
        `);
        console.log('\n=== TABLAS EN PUBLIC ===');
        r2.rows.forEach((r: any) => console.log(r.table_name));

        // Particiones / columnas de Order
        const r3 = await pool.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema='public' AND table_name='Order'
            ORDER BY ordinal_position
        `);
        console.log('\n=== COLUMNAS DE Order ===');
        r3.rows.forEach((r: any) => console.log(r.column_name, r.data_type));

        // Por instanceId en abril/mayo
        const r4 = await pool.query(`
            SELECT "instanceId", COUNT(*)::int AS c, MIN("createdAt") AS first, MAX("createdAt") AS last
            FROM "User"
            WHERE "createdAt" > '2026-04-01'
            GROUP BY "instanceId"
            ORDER BY c DESC
        `);
        console.log('\n=== USERS abr+may por instanceId ===');
        r4.rows.forEach((r: any) => console.log(r.instanceId, r.c, r.first?.toISOString?.()?.slice(0, 10), r.last?.toISOString?.()?.slice(0, 10)));

        // Orders abril/mayo por instanceId
        const r5 = await pool.query(`
            SELECT "instanceId", COUNT(*)::int AS c, MIN("createdAt") AS first, MAX("createdAt") AS last
            FROM "Order"
            WHERE "createdAt" > '2026-04-01'
            GROUP BY "instanceId"
            ORDER BY c DESC
        `);
        console.log('\n=== ORDERS abr+may por instanceId ===');
        r5.rows.forEach((r: any) => console.log(r.instanceId, r.c, r.first?.toISOString?.()?.slice(0, 10), r.last?.toISOString?.()?.slice(0, 10)));

        // Estado de usuarios actuales — quizás están todos en steps tempranos
        const r6 = await pool.query(`
            SELECT "instanceId", state->>'step' AS step, COUNT(*)::int AS c
            FROM "User"
            WHERE "createdAt" > '2026-04-25'
            GROUP BY "instanceId", state->>'step'
            ORDER BY "instanceId", c DESC
        `);
        console.log('\n=== ESTADO DE USERS (creados desde abr 25) ===');
        r6.rows.forEach((r: any) => console.log(r.instanceId, r.step, r.c));
    } catch (e: any) {
        console.log('ERR', e.message);
    }
    await pool.end();
})();
