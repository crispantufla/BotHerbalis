const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
    connectionString,
    max: 5,                      // Max 5 connections (Railway free tier friendly)
    idleTimeoutMillis: 30000,    // Close idle connections after 30s
    connectionTimeoutMillis: 5000 // Fail fast if DB is unreachable
});

pool.on('error', (err) => {
    console.error('🔴 [DB] Unexpected pool error:', err.message);
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

module.exports = { prisma, pool };
