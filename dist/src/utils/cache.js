"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.userCache = void 0;
const node_cache_1 = __importDefault(require("node-cache"));
const logger_1 = __importDefault(require("./logger"));
// Initialize NodeCache
// stdTTL: 30 days (2592000 seconds) - Increased from 24h to prevent session loss for 30 days.
// checkperiod: 1 hour (3600 seconds)
// useClones: false - Store references to objects instead of copying them.
const userCache = new node_cache_1.default({ stdTTL: 2592000, checkperiod: 3600, useClones: false });
exports.userCache = userCache;
// Global event listener for cache expirations (e.g. timeout on long idle users)
userCache.on("expired", (key, value) => {
    logger_1.default.info(`[CACHE] User state automatically expired for ${key} due to TTL`);
    // Optional: We could trigger a database cleanup or a re-engagement mechanism here in the future
});
