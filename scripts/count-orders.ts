const { prisma } = require('../db');

async function main() {
    const total = await prisma.order.count();
    const after20Apr = await prisma.order.count({
        where: { createdAt: { gt: new Date('2026-04-20T21:31:55Z') } },
    });
    const denisOrders = await prisma.order.count({ where: { instanceId: 'denis' } });

    console.log(`Total órdenes en DB:                    ${total}`);
    console.log(`Órdenes posteriores al 20/04 21:31 UTC: ${after20Apr}`);
    console.log(`Órdenes de denis (cuenta borrada):      ${denisOrders}`);
    console.log(``);
    console.log(`La orden de Maria Elina (20/04) está en la posición ${after20Apr + 1}`);
    console.log(`Con limit=50 por página, está en la página ${Math.ceil((after20Apr + 1) / 50)}`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
