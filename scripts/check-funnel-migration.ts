require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
(async () => {
    try {
        const r1 = await pool.query(`SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name ILIKE '%funnel%'`);
        console.log('Funnel migrations registradas:');
        if (r1.rows.length === 0) console.log('  (NINGUNA)');
        r1.rows.forEach((x: any) => console.log(' ', x.migration_name, '·', x.finished_at?.toISOString?.()));

        const r2 = await pool.query(`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='FunnelEvent') AS exists`);
        console.log('FunnelEvent table exists:', r2.rows[0].exists);

        const r3 = await pool.query(`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 6`);
        console.log('\nÚltimas 6 migraciones aplicadas:');
        r3.rows.forEach((x: any) => console.log(' ', x.migration_name, '·', x.finished_at?.toISOString?.()?.slice(0, 19)));
    } catch (e: any) {
        console.log('ERR', e.message);
    }
    await pool.end();
})();
