const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, 'logs');

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

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
