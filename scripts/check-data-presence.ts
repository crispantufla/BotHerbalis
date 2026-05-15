require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });

(async () => {
    try {
        const r1 = await pool.query(`SELECT DATE_TRUNC('day', "createdAt") AS d, COUNT(*)::int AS c FROM "User" WHERE "createdAt" > '2026-03-01' GROUP BY d ORDER BY d`);
        console.log('=== USERS por día (desde Mar 1) ===');
        r1.rows.forEach((r: any) => console.log(r.d.toISOString().slice(0, 10), r.c));

        const r2 = await pool.query(`SELECT DATE_TRUNC('day', "createdAt") AS d, COUNT(*)::int AS c FROM "Order" WHERE "createdAt" > '2026-03-01' GROUP BY d ORDER BY d`);
        console.log('\n=== ORDERS por día (desde Mar 1) ===');
        r2.rows.forEach((r: any) => console.log(r.d.toISOString().slice(0, 10), r.c));

        const r3 = await pool.query(`SELECT MAX("createdAt") AS last_user FROM "User"`);
        const r4 = await pool.query(`SELECT MAX("createdAt") AS last_order FROM "Order"`);
        console.log('\nÚltimo User:', r3.rows[0].last_user);
        console.log('Última Order:', r4.rows[0].last_order);

        const r5 = await pool.query(`SELECT COUNT(*)::int AS c FROM "User"`);
        const r6 = await pool.query(`SELECT COUNT(*)::int AS c FROM "Order"`);
        console.log('\nTotal Users:', r5.rows[0].c);
        console.log('Total Orders:', r6.rows[0].c);

        const r7 = await pool.query(`SELECT "instanceId", COUNT(*)::int AS c FROM "User" GROUP BY "instanceId" ORDER BY c DESC`);
        console.log('\n=== Users por instanceId ===');
        r7.rows.forEach((r: any) => console.log(r.instanceId, r.c));

        // FunnelEvent disponibilidad
        try {
            const r8 = await pool.query(`SELECT DATE_TRUNC('day', "enteredAt") AS d, COUNT(*)::int AS c FROM "FunnelEvent" WHERE "enteredAt" > '2026-03-01' GROUP BY d ORDER BY d`);
            console.log('\n=== FunnelEvent por día ===');
            r8.rows.slice(-30).forEach((r: any) => console.log(r.d.toISOString().slice(0, 10), r.c));
        } catch (e: any) { console.log('FunnelEvent error:', e.message); }
    } catch (e: any) {
        console.log('ERR', e.message);
    }
    await pool.end();
})();
