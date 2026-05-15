require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000, max: 5 });
(async () => {
    const r = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='ChatLog' ORDER BY ordinal_position`);
    console.log('ChatLog cols:');
    r.rows.forEach((x: any) => console.log(' ', x.column_name, x.data_type));
    await pool.end();
})();
