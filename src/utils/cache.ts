const NodeCache = require("node-cache");
const logger = require("./logger");

// Initialize NodeCache
// stdTTL: 30 days (2592000 seconds) - Increased from 24h to prevent session loss for 30 days.
// checkperiod: 1 hour (3600 seconds)
// useClones: false - Store references to objects instead of copying them.
const userCache = new NodeCache({ stdTTL: 2592000, checkperiod: 3600, useClones: false });

// Global event listener for cache expirations (e.g. timeout on long idle users)
userCache.on("expired", (key: string, value: any) => {
    logger.info(`[CACHE] User state automatically expired for ${key} due to TTL`);
    // Optional: We could trigger a database cleanup or a re-engagement mechanism here in the future
});

export { userCache };
