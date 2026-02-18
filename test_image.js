const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');

const imagePath = path.join(process.cwd(), 'public', 'media', 'Gretings.jpg');

console.log('--- DIAGNOSTIC START ---');
console.log('CWD:', process.cwd());
console.log('Target Path:', imagePath);

if (fs.existsSync(imagePath)) {
    console.log('✅ File exists.');
    try {
        const media = MessageMedia.fromFilePath(imagePath);
        console.log('✅ MessageMedia loaded successfully.');
        console.log('Mimetype:', media.mimetype);
        console.log('Data length:', media.data ? media.data.length : '0');
    } catch (e) {
        console.error('❌ Failed to load MessageMedia:', e);
    }
} else {
    console.error('❌ File does NOT exist.');
    // List directory to see what's there
    const dir = path.dirname(imagePath);
    if (fs.existsSync(dir)) {
        console.log(`Contents of ${dir}:`);
        fs.readdirSync(dir).forEach(file => console.log(' -', file));
    } else {
        console.log(`Directory ${dir} does not exist either.`);
    }
}
console.log('--- DIAGNOSTIC END ---');
