"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
            // Target 2: File (Rotated Daily / Limit 10MB per file / 30 Days max via pino-roll)
            {
                target: 'pino-roll',
                options: {
                    file: path.join(logDir, 'bot-activity'),
                    size: '10m',
                    frequency: 'daily',
                    mkdir: true,
                    extension: '.log',
                    limit: {
                        count: 30
                    }
                }
            }
        ]
    }
});
// Pino ignores extra string args (unlike console.log).
// This helper merges ('prefix:', 'value') into a single string so nothing gets silently dropped.
function mergeArgs(args) {
    if (args.length <= 1)
        return args;
    // Pino native pattern: (mergingObject, 'message') — keep as-is
    if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error))
        return args;
    // All primitives: concatenate like console.log would
    if (args.every(a => a == null || typeof a !== 'object')) {
        return [args.map(a => (a == null ? '' : String(a))).join(' ')];
    }
    return args;
}
// Polyfill the old legacy custom logger for backwards compatibility with legacy UI/sockets
const customLogger = {
    info: (...args) => logger.info(...mergeArgs(args)),
    warn: (...args) => logger.warn(...mergeArgs(args)),
    error: (...args) => logger.error(...mergeArgs(args)),
    debug: (...args) => logger.debug(...mergeArgs(args)),
    fatal: (...args) => logger.fatal(...mergeArgs(args)),
    logMessage: (chatId, sender, text, step = 'unknown') => {
        // Just delegating local logs to Pino
        logger.info({ chatId, sender, text, step }, `[MSG_TRACK] ${sender?.toUpperCase() || 'UNKNOWN'}`);
    }
};
exports.default = customLogger;
// Dual export: CommonJS require() compatibility for files that haven't migrated to import
module.exports = customLogger;
module.exports.default = customLogger;
