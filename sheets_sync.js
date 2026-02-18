const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(__dirname, 'google-credentials.json');

async function appendOrderToSheet(orderData) {
    try {
        if (!process.env.GOOGLE_SHEET_ID) {
            console.error('🔴 [SHEETS] GOOGLE_SHEET_ID not found in .env');
            return false;
        }

        let creds;
        if (process.env.GOOGLE_CREDENTIALS_JSON) {
            try {
                creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
            } catch (e) {
                console.error('🔴 [SHEETS] Invalid JSON in GOOGLE_CREDENTIALS_JSON env var');
                return false;
            }
        } else if (fs.existsSync(CREDS_PATH)) {
            creds = JSON.parse(fs.readFileSync(CREDS_PATH));
        } else {
            console.error('🔴 [SHEETS] Credentials not found (env GOOGLE_CREDENTIALS_JSON or file google-credentials.json missing)');
            return false;
        }

        // Initialize Auth
        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);

        await doc.loadInfo(); // loads document properties and worksheets
        const sheet = doc.sheetsByIndex[0]; // use the first sheet

        // Append Row
        // orderData: { fecha, cliente, nombre, calle, ciudad, cp, producto, plan, precio }
        await sheet.addRow({
            'Fecha': orderData.fecha || new Date().toLocaleString('es-AR'),
            'Cliente': orderData.cliente,
            'Destinatario': orderData.nombre || '?',
            'Dirección': orderData.calle || '?',
            'Ciudad': orderData.ciudad || '?',
            'CP': orderData.cp || '?',
            'Producto': orderData.producto || '?',
            'Plan': orderData.plan || '?',
            'Precio': orderData.precio || '?'
        });

        console.log(`✅ [SHEETS] Order logged for ${orderData.cliente}`);
        return true;
    } catch (e) {
        console.error('🔴 [SHEETS] Error appending row:', e.message);
        return false;
    }
}

module.exports = { appendOrderToSheet };
