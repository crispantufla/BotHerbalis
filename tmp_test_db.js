const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const msg = await prisma.chatLog.findFirst({
        where: { content: { contains: 'cemillas qu' } },
        orderBy: { timestamp: 'desc' }
    });
    if (msg) {
        console.log('Found userPhone:', msg.userPhone);
        const order = await prisma.order.findFirst({ where: { userPhone: msg.userPhone } });
        console.log('Order:', order);
        const logs = await prisma.chatLog.count({ where: { userPhone: msg.userPhone } });
        console.log('Total logs:', logs);

        const recentLogs = await prisma.chatLog.findMany({
            where: { userPhone: msg.userPhone },
            orderBy: { timestamp: 'desc' },
            take: 5
        });
        console.log('Recent logs:', recentLogs.map(l => ({role: l.role, body: l.content})));
    } else {
        console.log('Message not found.');
    }
}
main().finally(() => prisma.$disconnect());
