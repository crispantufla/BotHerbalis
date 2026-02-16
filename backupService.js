const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, 'backups');

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR);
}

function performBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filesToBackup = ['orders.json', 'persistence.json', 'knowledge.json'];

    console.log(`[BACKUP] Starting backup at ${timestamp}...`);

    let successCount = 0;

    filesToBackup.forEach(file => {
        const sourcePath = path.join(__dirname, file);
        if (fs.existsSync(sourcePath)) {
            try {
                const destPath = path.join(BACKUP_DIR, `${file}.${timestamp}.bak`);
                fs.copyFileSync(sourcePath, destPath);
                successCount++;
            } catch (e) {
                console.error(`🔴 [BACKUP] Failed to copy ${file}:`, e.message);
            }
        }
    });

    console.log(`[BACKUP] Complete. ${successCount}/${filesToBackup.length} files backed up.`);

    // Cleanup old backups (keep last 48 hours = ~150 files if 3 files * 24h * 2)
    // For simplicity, just delete files older than 2 days
    cleanupOldBackups();
}

function cleanupOldBackups() {
    try {
        const files = fs.readdirSync(BACKUP_DIR);
        const twoDaysAgo = Date.now() - (48 * 60 * 60 * 1000);

        files.forEach(file => {
            const filePath = path.join(BACKUP_DIR, file);
            const stats = fs.statSync(filePath);
            if (stats.mtimeMs < twoDaysAgo) {
                fs.unlinkSync(filePath);
                // console.log(`[BACKUP] Deleted old backup: ${file}`);
            }
        });
    } catch (e) {
        console.error(`🔴 [BACKUP] Cleanup failed:`, e.message);
    }
}

// Check if run directly
if (require.main === module) {
    performBackup();
}

module.exports = { performBackup };
