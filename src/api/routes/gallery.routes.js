const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../../middleware/auth');
const { atomicWriteFile } = require('../../../safeWrite');

module.exports = (client, sharedState) => {
    const router = express.Router();
    const { io } = sharedState;

    // DATA_DIR for metadata (persistent on Railway)
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..');
    const GALLERY_JSON = path.join(DATA_DIR, 'gallery.json');

    // Public directory for image files
    const PUBLIC_DIR = path.join(__dirname, '../../../public');
    const GALLERY_DIR = path.join(PUBLIC_DIR, 'media', 'gallery');

    // Ensure directories exist
    if (!fs.existsSync(GALLERY_DIR)) {
        fs.mkdirSync(GALLERY_DIR, { recursive: true });
    }

    // Load gallery data helper
    const loadGallery = () => {
        if (fs.existsSync(GALLERY_JSON)) {
            try {
                return JSON.parse(fs.readFileSync(GALLERY_JSON, 'utf8'));
            } catch (e) {
                console.error("Error reading gallery.json:", e);
                return [];
            }
        }
        return [];
    };

    // Save gallery data helper
    const saveGallery = (data) => {
        atomicWriteFile(GALLERY_JSON, JSON.stringify(data, null, 2));
    };

    // GET /gallery - List all images
    router.get('/gallery', authMiddleware, (req, res) => {
        const gallery = loadGallery();
        res.json(gallery);
    });

    // POST /gallery - Upload new image
    router.post('/gallery', authMiddleware, (req, res) => {
        try {
            const { image, filename, tags, category } = req.body; // image is base64

            if (!image || !filename) {
                return res.status(400).json({ error: "Missing image data or filename" });
            }

            // Decode base64
            // Handle data:image/png;base64, prefix if present
            const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            let buffer;

            if (matches && matches.length === 3) {
                buffer = Buffer.from(matches[2], 'base64');
            } else {
                buffer = Buffer.from(image, 'base64');
            }

            // Generate unique filename
            const ext = path.extname(filename) || '.jpg';
            const cleanName = path.basename(filename, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const uniqueName = `${cleanName}_${Date.now()}${ext}`;
            const filePath = path.join(GALLERY_DIR, uniqueName);
            const publicUrl = `/media/gallery/${uniqueName}`;

            // Save file
            fs.writeFileSync(filePath, buffer);

            // Update metadata
            const gallery = loadGallery();
            const newImage = {
                id: Date.now().toString(),
                filename: uniqueName,
                originalName: filename,
                url: publicUrl,
                tags: tags || [], // Array of strings e.g. ['capsulas', 'oferta']
                category: category || 'general', // 'product', 'greeting', etc
                createdAt: new Date().toISOString()
            };

            gallery.unshift(newImage); // Add to beginning
            saveGallery(gallery);

            if (io) io.emit('gallery_update', gallery);

            res.json({ success: true, image: newImage });

        } catch (e) {
            console.error("Error uploading image:", e);
            res.status(500).json({ error: "Internal server error uploading image" });
        }
    });

    // DELETE /gallery/:id - Delete image
    router.delete('/gallery/:id', authMiddleware, (req, res) => {
        try {
            const { id } = req.params;
            let gallery = loadGallery();
            const imageIndex = gallery.findIndex(img => img.id === id);

            if (imageIndex === -1) {
                return res.status(404).json({ error: "Image not found" });
            }

            const image = gallery[imageIndex];
            const filePath = path.join(GALLERY_DIR, image.filename);

            // Delete file if exists
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }

            // Remove from metadata
            gallery.splice(imageIndex, 1);
            saveGallery(gallery);

            if (io) io.emit('gallery_update', gallery);

            res.json({ success: true, message: "Image deleted" });

        } catch (e) {
            console.error("Error deleting image:", e);
            res.status(500).json({ error: "Internal server error deleting image" });
        }
    });

    return router;
};
