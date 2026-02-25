require('dotenv').config();
const { prisma, pool } = require('./db.js');

async function main() {
    console.log('--- USERS ---');
    const users = await prisma.user.findMany({ take: 5, orderBy: { createdAt: 'desc' } });
    console.table(users);

    console.log('--- ORDERS ---');
    const orders = await prisma.order.findMany({ take: 5, orderBy: { createdAt: 'desc' }, include: { user: true } });
    console.table(orders.map(o => ({
        id: o.id.substr(0, 8),
        userPhone: o.userPhone,
        userName: o.user?.name,
        orderNombre: o.nombre,
        calle: o.calle,
        products: o.products,
        status: o.status
    })));

    const allUsersCount = await prisma.user.count();
    const allOrdersCount = await prisma.order.count();
    console.log(`\nTotal Users: ${allUsersCount} | Total Orders: ${allOrdersCount}`);
}

main().catch(console.error).finally(() => {
    prisma.$disconnect();
    pool.end();
});
