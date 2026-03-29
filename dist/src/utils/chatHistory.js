"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLocalHistory = getLocalHistory;
const logger_1 = __importDefault(require("./logger"));
const db_1 = require("../../db");
/**
 * Get chat history from local database.
 * @param {string} chatId - The chat ID to retrieve history for.
 * @param {number} sinceTimestamp - Optional Unix timestamp to filter history.
 * @returns {Array} List of message objects.
 */
async function getLocalHistory(chatId, sinceTimestamp = 0) {
    const cleanPhone = chatId.replace('@c.us', '').replace(/\D/g, '');
    const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
    try {
        const dbLogs = await db_1.prisma.chatLog.findMany({
            where: {
                userPhone: cleanPhone,
                instanceId: INSTANCE_ID,
                timestamp: { gte: new Date(sinceTimestamp * 1000) }
            },
            orderBy: { timestamp: 'asc' }
        });
        return dbLogs.map((log) => ({
            fromMe: log.role === 'bot' || log.role === 'admin' || log.role === 'system',
            body: log.content,
            timestamp: new Date(log.timestamp).getTime(),
            type: 'chat',
            isLocal: true
        }));
    }
    catch (e) {
        logger_1.default.error(`Error fetching DB logs for ${chatId}:`, e.message);
        return [];
    }
}
