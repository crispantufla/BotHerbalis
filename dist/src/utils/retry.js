"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWithRetry = sendWithRetry;
const logger_1 = __importDefault(require("./logger"));
/**
 * Retry a WhatsApp sendMessage call with exponential backoff.
 * Retries only on transient network errors, not on invalid chatId etc.
 */
async function sendWithRetry(client, chatId, content, options, maxRetries = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await client.sendMessage(chatId, content, options);
        }
        catch (err) {
            lastError = err;
            // Don't retry on validation errors (invalid chatId, etc)
            if (err.message?.includes('invalid') || err.message?.includes('not found')) {
                throw err;
            }
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                logger_1.default.warn(`[RETRY] sendMessage to ${chatId} failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    logger_1.default.error(`[RETRY] sendMessage to ${chatId} failed after ${maxRetries} attempts: ${lastError?.message}`);
    throw lastError;
}
