import logger from './logger';
import { prisma } from '../../db';

/**
 * Get chat history from local database.
 * @param {string} chatId - The chat ID to retrieve history for.
 * @param {number} sinceTimestamp - Optional Unix timestamp to filter history.
 * @returns {Array} List of message objects.
 */
async function getLocalHistory(chatId: string, sinceTimestamp: number = 0): Promise<any[]> {
    const cleanPhone = chatId.replace('@c.us', '').replace(/\D/g, '');
    const INSTANCE_ID = process.env.INSTANCE_ID || 'default';

    try {
        const dbLogs = await prisma.chatLog.findMany({
            where: {
                userPhone: cleanPhone,
                instanceId: INSTANCE_ID,
                timestamp: { gte: new Date(sinceTimestamp * 1000) }
            },
            orderBy: { timestamp: 'asc' }
        });

        return dbLogs.map((log: any) => ({
            fromMe: log.role === 'bot' || log.role === 'admin' || log.role === 'system',
            body: log.content,
            timestamp: new Date(log.timestamp).getTime(),
            type: 'chat',
            isLocal: true
        }));
    } catch (e: any) {
        logger.error(`Error fetching DB logs for ${chatId}:`, e.message);
        return [];
    }
}

export { getLocalHistory };
