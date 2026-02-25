require('dotenv').config();
const { prisma, pool } = require('./db.js');

async function deleteUserCascade(phoneSuffix) {
    try {
        console.log(`[DELETE] Buscando usuarios que coincidan con: ${phoneSuffix}...`);

        // Find the user, partial match to handle different country codes if necessary
        const targetUsers = await prisma.user.findMany({
            where: {
                phone: {
                    contains: phoneSuffix
                }
            }
        });

        if (targetUsers.length === 0) {
            console.log(`❌ No se encontró ningún usuario con el número ${phoneSuffix}`);
            return;
        }

        for (const user of targetUsers) {
            console.log(`\n🗑️ Encontrado: ${user.name || 'Desconocido'} (${user.phone})`);

            // 1. Delete associated orders first
            const deletedOrders = await prisma.order.deleteMany({
                where: { userPhone: user.phone }
            });
            console.log(`  - Borradas ${deletedOrders.count} órdenes u órdenes relacionadas.`);

            // 2. Delete associated chat logs
            const deletedChats = await prisma.chatLog.deleteMany({
                where: { userPhone: user.phone }
            });
            console.log(`  - Borrados ${deletedChats.count} registros de chat.`);

            // 3. Delete the user
            await prisma.user.delete({
                where: { phone: user.phone }
            });
            console.log(`✅ Usuario ${user.phone} borrado exitosamente de la base de datos.`);
        }

    } catch (e) {
        console.error('🔴 Error al intentar borrar:', e);
    } finally {
        prisma.$disconnect();
        pool.end();
    }
}

// Check if a number was passed as argument, otherwise use the test number
const targetNumber = process.argv[2] || "621332862";
deleteUserCascade(targetNumber);
