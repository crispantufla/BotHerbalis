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
    const logsDir = path.join(__dirname, '../../logs');
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
                    const logTimestamp = Math.floor(new Date(log.timestamp).getTime() / 1000);

                    if (log.userId === chatId && logTimestamp >= sinceTimestamp) {
                        localMessages.push({
                            fromMe: log.role === 'bot' || log.role === 'admin' || log.role === 'system',
                            body: log.content,
                            timestamp: Math.floor(new Date(log.timestamp).getTime() / 1000),
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
