import logger from './logger';

/**
 * Retry a WhatsApp sendMessage call with exponential backoff.
 * Retries only on transient network errors, not on invalid chatId etc.
 */
export async function sendWithRetry(
    client: { sendMessage: (chatId: string, content: string, options?: any) => Promise<any> },
    chatId: string,
    content: string,
    options?: any,
    maxRetries: number = 3
): Promise<any> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await client.sendMessage(chatId, content, options);
        } catch (err: any) {
            lastError = err;
            // Don't retry on validation errors (invalid chatId, etc)
            if (err.message?.includes('invalid') || err.message?.includes('not found')) {
                throw err;
            }
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                logger.warn(`[RETRY] sendMessage to ${chatId} failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    logger.error(`[RETRY] sendMessage to ${chatId} failed after ${maxRetries} attempts: ${lastError?.message}`);
    throw lastError;
}
