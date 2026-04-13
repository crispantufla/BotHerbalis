const fs = require('fs');
const path = require('path');

/**
 * atomicWriteFile (ASYNC version)
 *
 * Writes data to a temporary file first, then renames it to the target file.
 * This prevents data corruption if the process crashes during write.
 * Uses async I/O to avoid blocking the event loop.
 *
 * @param {string} filePath - Absolute path to the target file
 * @param {string} data - String data to write (usually JSON.stringify(...))
 */
async function atomicWriteFile(filePath, data) {
    const tempPath = `${filePath}.tmp`;

    try {
        await fs.promises.writeFile(tempPath, data);
        await fs.promises.rename(tempPath, filePath);
        return true;
    } catch (err) {
        console.error(`🔴 [ATOMIC WRITE ERROR] Failed to write ${filePath}:`, err);
        try {
            await fs.promises.unlink(tempPath).catch(() => {});
        } catch (e) { /* ignore cleanup error */ }
        return false;
    }
}

module.exports = { atomicWriteFile };
