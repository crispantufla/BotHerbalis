require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: ['query', 'info', 'warn', 'error'] });

async function main() {
    console.log('Connecting...');
    try {
        await prisma.$connect();
        console.log('Connected!');
        const count = await prisma.user.count();
        console.log('User count:', count);
    } catch (e) {
        console.error('ERROR:', e);
    } finally {
        await prisma.$disconnect();
        console.log('Disconnected.');
    }
}
main();
