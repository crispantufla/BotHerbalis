require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data'); // Assuming data exists here for local or Railway
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const STATE_FILE = path.join(DATA_DIR, 'persistence.json');

async function main() {
    console.log('--- EMPEZANDO MIGRACIÓN DE JSON A POSTGRESQL ---');

    // 1. Load Data
    let orders = [];
    if (fs.existsSync(ORDERS_FILE)) {
        orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
        console.log(`> Leídos ${orders.length} pedidos de orders.json`);
    } else {
        console.log('> orders.json no existe. Omitiendo pedidos.');
    }

    let state = {};
    if (fs.existsSync(STATE_FILE)) {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        console.log(`> Leído persistence.json`);
    } else {
        console.log('> persistence.json no existe. Omitiendo config/state.');
    }

    // 2. Migrate Config
    if (state.config) {
        console.log('> Migrando BotConfig...');
        for (const [key, value] of Object.entries(state.config)) {
            await prisma.botConfig.upsert({
                where: { key },
                update: { value: JSON.stringify(value) },
                create: { key, value: JSON.stringify(value) },
            });
        }
    }

    // 3. Migrate Users (from state and orders)
    const usersMap = new Map(); // phone -> user obj

    if (state.userState) {
        for (const [phone, userData] of Object.entries(state.userState)) {
            const cleanPhone = phone.replace('@c.us', '');
            usersMap.set(cleanPhone, {
                phone: cleanPhone,
                profileData: userData.profile || null
            });
        }
    }

    for (const o of orders) {
        if (!o.cliente) continue;
        const cleanPhone = o.cliente.replace('@c.us', '').replace(/\D/g, '');
        if (!usersMap.has(cleanPhone)) {
            usersMap.set(cleanPhone, {
                phone: cleanPhone,
                name: o.nombre || null,
            });
        } else {
            if (!usersMap.get(cleanPhone).name && o.nombre) {
                usersMap.get(cleanPhone).name = o.nombre;
            }
        }
    }

    console.log(`> Migrando ${usersMap.size} usuarios únicos...`);
    for (const user of usersMap.values()) {
        await prisma.user.upsert({
            where: { phone: user.phone },
            update: { name: user.name, profileData: user.profileData },
            create: { phone: user.phone, name: user.name, profileData: user.profileData },
        });
    }

    // 4. Migrate Orders
    console.log(`> Migrando ${orders.length} pedidos...`);
    for (const o of orders) {
        if (!o.cliente) continue;
        const cleanPhone = o.cliente.replace('@c.us', '').replace(/\D/g, '');

        // Convert price
        let priceNum = 0;
        if (o.precio) {
            priceNum = parseFloat(o.precio.toString().replace(/[^\d.-]/g, ''));
        }

        try {
            let parsedDate = o.createdAt ? new Date(o.createdAt) : new Date();
            if (isNaN(parsedDate.getTime()) && typeof o.createdAt === 'string') {
                const parts = o.createdAt.split(/[^\d]/);
                if (parts.length >= 3) {
                    parsedDate = new Date(parts[2], parts[1] - 1, parts[0], parts[3] || 0, parts[4] || 0, parts[5] || 0);
                }
            }
            if (isNaN(parsedDate.getTime())) {
                parsedDate = new Date();
            }

            await prisma.order.create({
                data: {
                    id: o.id || undefined,
                    userPhone: cleanPhone,
                    status: o.status || 'Pendiente',
                    products: o.producto || 'Desconocido',
                    totalPrice: isNaN(priceNum) ? 0 : priceNum,
                    tracking: o.tracking || null,
                    postdated: o.postdatado || null,
                    createdAt: parsedDate,
                }
            });
        } catch (e) {
            console.error(`[Aviso] Error insertando pedido ${o.id} - Puede ser duplicado. Omitiendo.`, e.message);
        }
    }

    console.log('--- MIGRACIÓN COMPLETADA EXITOSAMENTE ---');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
