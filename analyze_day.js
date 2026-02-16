require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const logDir = path.join(__dirname, 'logs');

async function analyzeDailyLogs(dateStr) {
    // If no date given, default to today
    if (!dateStr) {
        dateStr = new Date().toISOString().split('T')[0];
    }

    const logFile = path.join(logDir, `daily_${dateStr}.jsonl`);

    if (!fs.existsSync(logFile)) {
        console.log(`No log file found for ${dateStr}.`);
        return null;
    }

    // Read JSONL log file
    const rawLines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    const entries = rawLines.map(line => {
        try { return JSON.parse(line); }
        catch (e) { return null; }
    }).filter(Boolean);

    if (entries.length === 0) {
        console.log("No valid entries found.");
        return null;
    }

    // Group by user for conversation context
    const conversations = {};
    for (const entry of entries) {
        if (!conversations[entry.userId]) {
            conversations[entry.userId] = [];
        }
        conversations[entry.userId].push(entry);
    }

    // Build a summarized view for the AI
    let conversationSummary = '';
    let userCount = 0;
    let totalMessages = 0;
    let aiTriggers = 0;

    for (const [userId, msgs] of Object.entries(conversations)) {
        userCount++;
        conversationSummary += `\n--- Usuario ${userCount} (${userId}) ---\n`;
        for (const m of msgs) {
            totalMessages++;
            if (m.role === 'system' && m.content.includes('AI Smart Response')) {
                aiTriggers++;
            }
            conversationSummary += `[${m.role}|${m.step}] ${m.content}\n`;
        }
    }

    console.log(`📊 Stats: ${userCount} users, ${totalMessages} messages, ${aiTriggers} AI triggers`);
    console.log(`Sending to AI for analysis...`);

    const prompt = `
Eres un analista de ventas para "Herbalis" (Nuez de la India). 
Analiza las siguientes conversaciones del día ${dateStr}.

CONVERSACIONES:
${conversationSummary}

Genera un INFORME DIARIO con las siguientes secciones:

1. **📊 RESUMEN**: Cuantos usuarios, cuantos llegaron al final del embudo (completed), cuantos abandonaron y en qué paso.

2. **❌ PROBLEMAS DETECTADOS**: 
   - Mensajes que el bot NO supo responder (donde se activó la IA como fallback).
   - Preguntas frecuentes que NO están cubiertas en las FAQs.
   - Momentos donde el usuario se confundió o no entendió.

3. **💡 SUGERENCIAS DE MEJORA**:
   - Nuevas keywords para agregar a knowledge.js (con el texto exacto del keyword).
   - Nuevas FAQs recomendadas.
   - Cambios al guion de ventas.

4. **🏆 MEJORES PRÁCTICAS**: Qué funcionó bien, qué patrones de respuesta generaron más engagement.

5. **⚠️ PREGUNTAS PARA EL ADMINISTRADOR**: Si hay algo que no entendiste o necesitas aclaración del admin.

Formato: Markdown. Sé conciso pero específico. Incluye ejemplos del texto real del usuario cuando sea relevante.
`;

    try {
        const result = await model.generateContent(prompt);
        const report = result.response.text();

        // Save report
        const reportFile = path.join(logDir, `report_${dateStr}.md`);
        fs.writeFileSync(reportFile, report, 'utf-8');
        console.log(`✅ Report saved to: ${reportFile}`);

        return report;
    } catch (e) {
        console.error("❌ AI Analysis Error:", e);
        return null;
    }
}

// If run directly from the command line: node analyze_day.js [YYYY-MM-DD]
if (require.main === module) {
    const dateArg = process.argv[2] || null;
    analyzeDailyLogs(dateArg).then(report => {
        if (report) {
            console.log("\n========== INFORME DIARIO ==========\n");
            console.log(report);
        } else {
            console.log("No report generated.");
        }
        process.exit(0);
    });
}

module.exports = { analyzeDailyLogs };
