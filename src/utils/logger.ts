const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Ensure purely local logs directory exists
const logDir = path.join(__dirname, '../../data/logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

const isDev = process.env.NODE_ENV !== 'production';

// Pino configuration (Async logging, doesn't block event loop)
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: {
        targets: [
            // Target 1: Console (Pretty Print if Dev, JSON otherwise)
            {
                target: isDev ? 'pino-pretty' : 'pino/file',
                options: isDev ? {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname'
                } : { destination: 1 } // 1 = STDOUT
            },
            // Target 2: File (JSON for ELK/Datadog or parsing)
            {
                target: 'pino/file',
                options: {
                    destination: path.join(logDir, 'bot-activity.log'),
                    mkdir: true
                }
            }
        ]
    }
});

// Polyfill the old legacy custom logger for backwards compatibility with legacy UI/sockets
const customLogger = {
    info: (...args: any[]) => logger.info(...args),
    warn: (...args: any[]) => logger.warn(...args),
    error: (...args: any[]) => logger.error(...args),
    debug: (...args: any[]) => logger.debug(...args),
    fatal: (...args: any[]) => logger.fatal(...args),

    logMessage: (chatId: string, sender: string, text: string, step = 'unknown') => {
        // Just delegating local logs to Pino
        logger.info({ chatId, sender, text, step }, `[MSG_TRACK] ${sender?.toUpperCase() || 'UNKNOWN'}`);
    }
};

module.exports = customLogger;
