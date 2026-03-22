import path from 'path';
import fs from 'fs';
import logger from '../../utils/logger';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');
const GALLERY_JSON = path.join(DATA_DIR, 'gallery.json');

function _getGallery(): any[] {
    try {
        if (fs.existsSync(GALLERY_JSON)) {
            const data = JSON.parse(fs.readFileSync(GALLERY_JSON, 'utf8'));
            return Array.isArray(data) ? data : [];
        }
    } catch (e) { logger.error('Error reading gallery:', e); }
    return [];
}

export { _getGallery };

