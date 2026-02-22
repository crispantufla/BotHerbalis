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

async function getSheetsDoc() {
    if (!process.env.GOOGLE_SHEET_ID) throw new Error('GOOGLE_SHEET_ID not found in .env');

    let creds;
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
        creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } else if (fs.existsSync(CREDS_PATH)) {
        creds = JSON.parse(fs.readFileSync(CREDS_PATH));
    } else {
        throw new Error('Credentials not found');
    }

    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    return doc;
}

// Ensure columns Tracking and Estado exist by checking headers
async function ensureHeaders(sheet) {
    try {
        await sheet.loadHeaderRow();
    } catch (e) {
        console.warn('⚠️ [SHEETS] No headers found, initializing headers');
        await sheet.setHeaderRow(['Fecha', 'Cliente', 'Destinatario', 'Dirección', 'Ciudad', 'CP', 'Producto', 'Plan', 'Precio', 'Estado', 'Tracking']);
        return;
    }

    let headers = sheet.headerValues;
    if (!headers || headers.length === 0) {
        await sheet.setHeaderRow(['Fecha', 'Cliente', 'Destinatario', 'Dirección', 'Ciudad', 'CP', 'Producto', 'Plan', 'Precio', 'Estado', 'Tracking']);
        return;
    }

    let needsUpdate = false;
    if (!headers.includes('Estado')) { headers.push('Estado'); needsUpdate = true; }
    if (!headers.includes('Tracking')) { headers.push('Tracking'); needsUpdate = true; }

    if (needsUpdate) {
        await sheet.setHeaderRow(headers);
    }
}

async function getOrdersFromSheet() {
    try {
        const doc = await getSheetsDoc();
        const sheet = doc.sheetsByIndex[0];

        // Wait till headers are there
        await ensureHeaders(sheet);

        const rows = await sheet.getRows();

        return rows.map((row, index) => {
            // Generamos un ID virtual basado en el rowNumber para poder identificarlo al editar
            return {
                id: row.rowNumber.toString(),
                createdAt: row.get('Fecha'),
                cliente: row.get('Cliente'),
                nombre: row.get('Destinatario'),
                calle: row.get('Dirección'),
                ciudad: row.get('Ciudad'),
                cp: row.get('CP'),
                producto: row.get('Producto'),
                plan: row.get('Plan'),
                precio: row.get('Precio'),
                status: row.get('Estado') || 'Pendiente',
                tracking: row.get('Tracking') || ''
            };
        });
    } catch (e) {
        console.error('🔴 [SHEETS] Error getting orders:', e.message);
        return [];
    }
}

async function updateOrderInSheet(rowNumber, updates) {
    try {
        const doc = await getSheetsDoc();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();

        // Find the specific row by rowNumber
        const row = rows.find(r => r.rowNumber.toString() === rowNumber.toString());

        if (!row) {
            console.error(`🔴 [SHEETS] Row ${rowNumber} not found.`);
            return null;
        }

        if (updates.status !== undefined) row.assign({ 'Estado': updates.status });
        if (updates.tracking !== undefined) row.assign({ 'Tracking': updates.tracking });

        await row.save();
        console.log(`✅ [SHEETS] Order at row ${rowNumber} updated.`);

        return {
            id: row.rowNumber.toString(),
            status: row.get('Estado'),
            tracking: row.get('Tracking')
        };
    } catch (e) {
        console.error('🔴 [SHEETS] Error updating order:', e.message);
        throw e;

    }
}

async function deleteOrderInSheet(rowNumber) {
    try {
        const doc = await getSheetsDoc();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();

        const row = rows.find(r => r.rowNumber.toString() === rowNumber.toString());

        if (!row) {
            console.error(`🔴 [SHEETS] Row ${rowNumber} not found for deletion.`);
            return false;
        }

        await row.delete();
        console.log(`✅ [SHEETS] Order at row ${rowNumber} deleted.`);
        return true;
    } catch (e) {
        console.error('🔴 [SHEETS] Error deleting order:', e.message);
        return false;
    }
}

module.exports = { appendOrderToSheet, getOrdersFromSheet, updateOrderInSheet, deleteOrderInSheet };
