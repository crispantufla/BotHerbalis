require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000, max: 5 });
(async () => {
    const r = await pool.query(`SELECT "pauseReason", COUNT(*)::int AS c FROM "User" WHERE "pauseReason" IS NOT NULL GROUP BY "pauseReason" ORDER BY c DESC`);
    console.log('=== Razones de pausa distintas ===');
    r.rows.forEach((x: any) => console.log(x.c, '|', x.pauseReason));
    await pool.end();
})();
