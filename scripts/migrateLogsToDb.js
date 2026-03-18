require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { prisma } = require('../db');

const LOGS_DIR = path.join(__dirname, '../logs');

async function main() {
    console.log('[MIGRATION] Empezando a migrar los logs de .jsonl a PostgreSQL ChatLog...');
    if (!fs.existsSync(LOGS_DIR)) {
        console.log('[MIGRATION] Carpeta de logs vacía o inexistente.');
        return;
    }

    const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));
    let totalMigrated = 0;
    let totalSkipped = 0;

    for (const file of files) {
        console.log(`[MIGRATION] Procesando archivo: ${file}`);
        const filePath = path.join(LOGS_DIR, file);
        
        const fileStream = fs.createReadStream(filePath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

        for await (const line of rl) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                if (!entry.userId || !entry.content || !entry.role) continue;

                // Protect against long strings throwing DB string errors
                if (entry.content.length > 5000) entry.content = entry.content.substring(0, 5000);

                const cleanPhone = entry.userId.replace('@c.us', '').replace(/\D/g, '');
                if (!cleanPhone) continue;

                // Ensure User exists
                await prisma.user.upsert({
                    where: { phone_instanceId: { phone: cleanPhone, instanceId: "default" } },
                    update: {},
                    create: { phone: cleanPhone, instanceId: "default" }
                });

                await prisma.chatLog.create({
                    data: {
                        userPhone: cleanPhone,
                        role: entry.role,
                        content: entry.content,
                        timestamp: new Date(entry.timestamp),
                        instanceId: "default"
                    }
                });
                totalMigrated++;
            } catch (e) {
                totalSkipped++;
            }
        }
    }
    console.log(`[MIGRATION] Completado. ${totalMigrated} logs insertados. ${totalSkipped} saltados por error/duplicado.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
