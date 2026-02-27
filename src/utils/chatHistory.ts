const logger = require('./logger');
const fs = require('fs');
const path = require('path');

/**
 * Get chat history from local JSONL logs.
 * @param {string} chatId - The chat ID to retrieve history for.
 * @param {number} sinceTimestamp - Optional Unix timestamp to filter history.
 * @returns {Array} List of message objects.
 */
function getLocalHistory(chatId: string, sinceTimestamp: number = 0): any[] {
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../..');
    const logsDir = path.join(DATA_DIR, 'logs');
    if (!fs.existsSync(logsDir)) return [];

    const files = fs.readdirSync(logsDir).filter((f: string) => f.endsWith('.jsonl'));
    let localMessages: any[] = [];

    files.forEach((file: string) => {
        try {
            const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
            const lines = content.split('\n').filter((l: string) => l.trim());
            lines.forEach((line: string) => {
                try {
                    const log = JSON.parse(line);
                    const logTimestampMs = new Date(log.timestamp).getTime();

                    // sinceTimestamp is in seconds (from WA), convert to ms for comparison
                    if (log.userId === chatId && logTimestampMs >= sinceTimestamp * 1000) {
                        localMessages.push({
                            fromMe: log.role === 'bot' || log.role === 'admin' || log.role === 'system',
                            body: log.content,
                            timestamp: new Date(log.timestamp).getTime(), // ms for frontend consistency
                            type: 'chat',
                            isLocal: true
                        });
                    }
                } catch (jsonErr) {
                    // Ignore malformed lines
                }
            });
        } catch (e: any) {
            logger.error(`Error reading log file ${file}:`, e.message);
        }
    });

    return localMessages;
}

export { getLocalHistory };
