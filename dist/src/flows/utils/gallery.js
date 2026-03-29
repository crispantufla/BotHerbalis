"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports._getGallery = _getGallery;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const logger_1 = __importDefault(require("../../utils/logger"));
const DATA_DIR = process.env.DATA_DIR || path_1.default.join(__dirname, '../../..');
const GALLERY_JSON = path_1.default.join(DATA_DIR, 'gallery.json');
function _getGallery() {
    try {
        if (fs_1.default.existsSync(GALLERY_JSON)) {
            const data = JSON.parse(fs_1.default.readFileSync(GALLERY_JSON, 'utf8'));
            return Array.isArray(data) ? data : [];
        }
    }
    catch (e) {
        logger_1.default.error('Error reading gallery:', e);
    }
    return [];
}
