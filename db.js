const { PrismaClient } = require('@prisma/client');

let connectionString = process.env.DATABASE_URL;

const prismaArgs = {};

if (connectionString) {
    // Ensure connection limit is set for Railway free tier
    if (!connectionString.includes('connection_limit')) {
        const separator = connectionString.includes('?') ? '&' : '?';
        connectionString += `${separator}connection_limit=5&pool_timeout=5`;
    }
    prismaArgs.datasources = {
        db: {
            url: connectionString
        }
    };
}

const prisma = new PrismaClient(prismaArgs);

// Polyfill pool to prevent errors in scripts that call pool.end()
const pool = {
    end: async () => { }
};

module.exports = { prisma, pool };
