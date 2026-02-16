const fs = require('fs');
const path = require('path');

/**
 * atomicWriteFile
 * 
 * Writes data to a temporary file first, then renames it to the target file.
 * This prevents data corruption if the process crashes during write.
 * 
 * @param {string} filePath - Absolute path to the target file
 * @param {string} data - String data to write (usually JSON.stringify(...))
 */
function atomicWriteFile(filePath, data) {
    const tempPath = `${filePath}.tmp`;

    try {
        // 1. Write to temp file
        fs.writeFileSync(tempPath, data);

        // 2. Rename temp file to target file (Atomic operation on most OSs)
        fs.renameSync(tempPath, filePath);

        return true;
    } catch (err) {
        console.error(`🔴 [ATOMIC WRITE ERROR] Failed to write ${filePath}:`, err);
        // Try to clean up temp file if it exists
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch (e) { /* ignore cleanup error */ }

        return false;
    }
}

module.exports = { atomicWriteFile };
