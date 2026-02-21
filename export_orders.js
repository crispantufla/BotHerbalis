require('dotenv').config();
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(__dirname, 'google-credentials.json');
const ORDERS_FILE = path.join(__dirname, 'orders.json');

async function exportOrders() {
    try {
        console.log('🔄 Iniciando migración de orders.json a Google Sheets...');
        if (!fs.existsSync(ORDERS_FILE)) {
            console.error('❌ No se encontró orders.json');
            return;
        }

        const orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
        if (orders.length === 0) {
            console.log('⚠️ No hay órdenes locales para exportar.');
            return;
        }

        let creds;
        if (process.env.GOOGLE_CREDENTIALS_JSON) {
            creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        } else if (fs.existsSync(CREDS_PATH)) {
            creds = JSON.parse(fs.readFileSync(CREDS_PATH));
        } else {
            console.error('❌ No hay credenciales configuradas.');
            return;
        }

        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];

        // Ensure headers
        try {
            await sheet.loadHeaderRow();
        } catch (e) {
            await sheet.setHeaderRow(['Fecha', 'Cliente', 'Destinatario', 'Dirección', 'Ciudad', 'CP', 'Producto', 'Plan', 'Precio', 'Estado', 'Tracking']);
        }

        let headers = sheet.headerValues;
        let needsUpdate = false;
        if (!headers.includes('Estado')) { headers.push('Estado'); needsUpdate = true; }
        if (!headers.includes('Tracking')) { headers.push('Tracking'); needsUpdate = true; }
        if (needsUpdate) await sheet.setHeaderRow(headers);

        console.log(`📦 Se encontraron ${orders.length} órdenes. Agregando a Sheets en bloque (batch)...`);

        const rowsToAdd = orders.map(order => ({
            'Fecha': new Date(order.createdAt).toLocaleString('es-AR'),
            'Cliente': order.cliente || '',
            'Destinatario': order.nombre || '',
            'Dirección': order.calle || '',
            'Ciudad': order.ciudad || '',
            'CP': order.cp || '',
            'Producto': order.producto || '',
            'Plan': order.plan || '',
            'Precio': order.precio || '',
            'Estado': order.status || 'Pendiente',
            'Tracking': order.tracking || ''
        }));

        await sheet.addRows(rowsToAdd);
        console.log(`✅ ¡Migración completada exitosamente! ${rowsToAdd.length} filas insertadas.`);

        // Optionally rename old files to keep backup but avoid using it again
        fs.renameSync(ORDERS_FILE, path.join(__dirname, 'orders.backup.json'));
        console.log('♻️ El archivo orders.json fue renombrado a orders.backup.json por seguridad.');

    } catch (e) {
        console.error('🔴 Error en la migración:', e);
    }
}

exportOrders();
