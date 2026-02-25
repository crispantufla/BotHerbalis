require('dotenv').config();
const { prisma, pool } = require('./db.js');

async function checkUserState(phone) {
    const user = await prisma.user.findUnique({
        where: { phone: phone }
    });
    console.log(user);
}

checkUserState('621332862').catch(e => console.error(e)).finally(() => { prisma.$disconnect(); pool.end(); });
