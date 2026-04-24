const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
    connectionString,
    // Techo del pool. Consumidores reales cuando arranca todo:
    // ~6 workers × 1 concurrency + scheduler crons + analytics tabs cargando
    // 10 endpoints en paralelo + state saves + funnel writes. 20 se satura
    // apenas un admin abre la vista de analítica; 40 deja margen sin
    // acercarnos al tope del plan pago de Railway Postgres.
    max: 40,
    idleTimeoutMillis: 30000,
    // 5s era muy agresivo bajo carga: la query del pool llegaba con delay de
    // red + contención y fallaba antes de tener una conexión disponible.
    connectionTimeoutMillis: 15000
});

pool.on('error', (err) => {
    console.error('🔴 [DB] Unexpected pool error:', err.message);
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

module.exports = { prisma, pool };
