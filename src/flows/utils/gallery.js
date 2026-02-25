const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');
const GALLERY_JSON = path.join(DATA_DIR, 'gallery.json');

function _getGallery() {
    try {
        if (fs.existsSync(GALLERY_JSON)) {
            return JSON.parse(fs.readFileSync(GALLERY_JSON, 'utf8'));
        }
    } catch (e) { console.error('Error reading gallery:', e); }
    return [];
}

module.exports = {
    _getGallery
};
