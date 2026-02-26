const { PrismaClient } = require('@prisma/client');

let connectionString = process.env.DATABASE_URL;

if (connectionString) {
    // Ensure connection limit is set for Railway free tier
    if (!connectionString.includes('connection_limit')) {
        const separator = connectionString.includes('?') ? '&' : '?';
        connectionString += `${separator}connection_limit=5&pool_timeout=5`;
    }
    // Prisma automatically picks up process.env.DATABASE_URL
    process.env.DATABASE_URL = connectionString;
}

const prisma = new PrismaClient();

// Polyfill pool to prevent errors in scripts that call pool.end()
const pool = {
    end: async () => { }
};

module.exports = { prisma, pool };
