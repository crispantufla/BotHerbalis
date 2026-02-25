require('dotenv').config();
const { prisma, pool } = require('./db.js');

async function migrateNames() {
    console.log('[MIGRATION] Starting to copy names from User table to Order table...');

    // Find orders that have no explicit name set (usually abandoned carts or legacy orders)
    const ordersToFix = await prisma.order.findMany({
        where: {
            OR: [
                { nombre: null },
                { nombre: '' }
            ]
        },
        include: {
            user: true
        }
    });

    let count = 0;

    for (const order of ordersToFix) {
        if (order.user && order.user.name) {
            await prisma.order.update({
                where: { id: order.id },
                data: { nombre: order.user.name }
            });
            count++;
            console.log(`- Updated Order ${order.id.substring(0, 6)}... with name: ${order.user.name}`);
        }
    }

    console.log(`\n✅ Migration complete! Fixed ${count} orders that were displaying as 'Desconocido'.`);
}

migrateNames().catch(e => console.error(e)).finally(() => {
    prisma.$disconnect();
    pool.end();
});
