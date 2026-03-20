const { prisma } = require('./db');
// import doesn't always work if it's a .js file

async function main() {
    console.log('Searching for User: Beatriz (5493865344570)');
    
    // Check clean phone
    const cleanPhoneLogs = await prisma.chatLog.count({ where: { userPhone: '5493865344570' } });
    console.log('Logs with cleanPhone (5493865344570):', cleanPhoneLogs);
    
    // Check @c.us phone
    const cusPhoneLogs = await prisma.chatLog.count({ where: { userPhone: '5493865344570@c.us' } });
    console.log('Logs with @c.us (5493865344570@c.us):', cusPhoneLogs);

    // Check LID
    const lidLogs = await prisma.chatLog.count({ where: { userPhone: '247364531015754@lid' } });
    console.log('Logs with LID (247364531015754@lid):', lidLogs);

    // Let's do a text search just to be sure we find her messages
    const textLogs = await prisma.chatLog.findMany({ 
        where: { content: { contains: 'cemillas q' } }
    });
    console.log('Logs containing "cemillas q":', textLogs.map(l => l.userPhone));
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
