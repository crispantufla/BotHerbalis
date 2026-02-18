const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, 'logs');
const LOG_RETENTION_DAYS = 30;

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

// Clean logs older than LOG_RETENTION_DAYS
function cleanOldLogs() {
    try {
        const files = fs.readdirSync(logDir);
        const cutoff = Date.now() - (LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        let cleaned = 0;
        for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const filePath = path.join(logDir, file);
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff) {
                fs.unlinkSync(filePath);
                cleaned++;
            }
        }
        if (cleaned > 0) console.log(`[LOGGER] Cleaned ${cleaned} old log file(s)`);
    } catch (e) {
        console.error('[LOGGER] Error cleaning old logs:', e.message);
    }
}
cleanOldLogs();

function getLogFileName() {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(logDir, `daily_${date}.jsonl`);
}

function logMessage(userId, role, content, step) {
    const entry = {
        timestamp: new Date().toISOString(),
        userId,
        role, // 'user', 'bot', 'system'
        content,
        step: step || 'unknown'
    };

    const fileName = getLogFileName();

    // Append to file (JSONL style for simplicity and crash resilience)
    fs.appendFile(fileName, JSON.stringify(entry) + '\n', (err) => {
        if (err) console.error("FAILED TO LOG:", err);
    });
}

module.exports = { logMessage };
