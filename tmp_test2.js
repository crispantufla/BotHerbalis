const { prisma } = require('./src/db');

async function main() {
    console.log('Querying DB for messages with "cemillas"...');
    const msgs = await prisma.chatLog.findMany({
        where: { content: { contains: 'cemillas' } },
        orderBy: { timestamp: 'desc' },
        take: 5
    });

    if (msgs.length > 0) {
        for (const msg of msgs) {
            console.log('--- Found message:', msg.content);
            console.log('UserPhone in DB:', msg.userPhone);
            const order = await prisma.order.findFirst({ where: { userPhone: msg.userPhone } });
            console.log('Order found?', !!order, order ? order.status : '');
            const logsCount = await prisma.chatLog.count({ where: { userPhone: msg.userPhone } });
            console.log('Total logs for user:', logsCount);
            
            const adminMsgs = await prisma.chatLog.count({
                where: { userPhone: msg.userPhone, role: { in: ['bot', 'admin', 'system'] } }
            });
            console.log('Total outgoing messages:', adminMsgs);
        }
    } else {
        console.log('Message not found.');
    }
}
main().finally(() => process.exit(0));
