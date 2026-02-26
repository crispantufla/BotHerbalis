const NodeCache = require("node-cache");
const logger = require("./logger");

// Initialize NodeCache
// stdTTL: 24 hours (86400 seconds) - The default time to live for cached items.
// checkperiod: 20 minutes (1200 seconds) - The interval at which the cache checks for and deletes expired items.
// useClones: false - Store references to objects instead of copying them (better performance, mimics previous userState logic).
const userCache = new NodeCache({ stdTTL: 86400, checkperiod: 1200, useClones: false });

// Global event listener for cache expirations (e.g. timeout on long idle users)
userCache.on("expired", (key: string, value: any) => {
    logger.info(`[CACHE] User state automatically expired for ${key} due to TTL`);
    // Optional: We could trigger a database cleanup or a re-engagement mechanism here in the future
});

export { userCache };
