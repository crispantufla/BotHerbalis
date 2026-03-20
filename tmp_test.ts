import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const msgs = await prisma.chatLog.findMany({
        where: { content: { contains: 'cemillas' } },
        orderBy: { timestamp: 'desc' },
        take: 5
    });
    
    if (msgs.length > 0) {
        for (const msg of msgs) {
            console.log('--- Found message:', msg.content, 'User:', msg.userPhone);
            const order = await prisma.order.findFirst({ where: { userPhone: msg.userPhone } });
            console.log('Order found?', !!order, order ? order.status : '');
            const logsCount = await prisma.chatLog.count({ where: { userPhone: msg.userPhone } });
            console.log('Total logs for user:', logsCount);
        }
    } else {
        console.log('Message not found.');
    }
}

main().finally(() => prisma.$disconnect());
