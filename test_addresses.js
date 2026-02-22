require('dotenv').config();
const { aiService } = require('./src/services/ai');

const testCases = [
    "marta pastor bengas 77 rosario 2000",
    "Juan perez, San martin 1234, cordoba capital, cp 5000",
    "mi dirección es av belgrano 45D, san miguel de tucuman",
    "calle falsa 123 esquina siempre viva",
    "12 de octubre 456, entre rios, parana",
    "Me llamo Roberto Carlos, vivo en Mendoza, godoy cruz, calle san juan 890",
    "Buenos aires, CABA, corrientes 348",
    "Avenida Libertador 1234 Piso 5 Depto B, Vicente Lopez, 1638",
    "ruta provincial 5 km 12, villa general belgrano",
    "soy lucia, mendoza 123, bs as"
];

async function runTests() {
    console.log("=== INICIANDO 10 PRUEBAS DE DIRECCIÓN ===");
    for (let i = 0; i < testCases.length; i++) {
        console.log(`\n\nPrueba ${i + 1}: "${testCases[i]}"`);
        try {
            const result = await aiService.parseAddress(testCases[i]);
            let data = result;
            if (result && result.extractedData) data = result.extractedData;
            console.log("Extracción:", JSON.stringify(data, null, 2));
        } catch (e) {
            console.log("Error en extracción:", e.message);
        }
    }
    process.exit(0);
}

runTests();
