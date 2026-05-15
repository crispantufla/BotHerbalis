require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
(async () => {
    const before = await pool.query(`SELECT COUNT(*)::int AS c FROM "AiSemanticCache"`);
    console.log('Rows antes:', before.rows[0].c);
    const r = await pool.query(`DELETE FROM "AiSemanticCache"`);
    console.log('Rows borradas:', r.rowCount);
    const after = await pool.query(`SELECT COUNT(*)::int AS c FROM "AiSemanticCache"`);
    console.log('Rows después:', after.rows[0].c);
    await pool.end();
})();
