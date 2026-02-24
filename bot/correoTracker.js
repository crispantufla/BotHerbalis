const cheerio = require('cheerio');
const querystring = require('querystring');

/**
 * Consulta el estado de un envío nacional en Correo Argentino (Track & Trace).
 * @param {string} trackingCode - Ej: 'CO767694665AR', o solo '767694665'.
 * @returns {Promise<Object>} Resultado JSON con el array de eventos de tracking o un mensaje de error.
 */
async function getTrackingNacional(trackingCode) {
    try {
        // Limpiamos la entrada para asegurar que extraemos el código correctamente
        const cleanCode = trackingCode.trim().toUpperCase();

        let producto = 'CO';
        let idNumber = cleanCode;
        let pais = 'AR';

        // Si nos pasan el código completo ej CO123456789AR, extraigámoslo.
        const matchFull = cleanCode.match(/^([A-Z]{2})(\d{9})([A-Z]{2})$/);
        // Si nos pasan CO123456789
        const matchPartial = cleanCode.match(/^([A-Z]{2})(\d{9})$/);
        // Si nos pasan solo 9 digitos
        const matchDigits = cleanCode.match(/^(\d{9})$/);

        if (matchFull) {
            producto = matchFull[1];
            idNumber = matchFull[2];
            pais = matchFull[3];
        } else if (matchPartial) {
            producto = matchPartial[1];
            idNumber = matchPartial[2];
        } else if (matchDigits) {
            idNumber = matchDigits[1];
        } else {
            return {
                success: false,
                error: "Formato de código de seguimiento inválido. Debe ser de 9 dígitos numéricos (ej. 767694665) o formato completo (ej. CO767694665AR)."
            };
        }

        const url = 'https://www.correoargentino.com.ar/sites/all/modules/custom/ca_forms/api/wsFacade.php';

        const bodyData = {
            action: 'ondnc', // Origen Nacional a Destino Nacional
            id: idNumber,
            producto: producto,
            pais: pais
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': 'https://www.correoargentino.com.ar',
                'Referer': 'https://www.correoargentino.com.ar/formularios/ondnc'
            },
            body: querystring.stringify(bodyData)
        });

        if (!response.ok) {
            return { success: false, error: `Error HTTP en la consulta: ${response.status}` };
        }

        const htmlText = await response.text();
        const $ = cheerio.load(htmlText);

        // Verificar si la pieza fue encontrada o si tira el alerta "No se encontraron resultados"
        const alertInfo = $('.alert-info').text().trim();
        if (alertInfo && alertInfo.includes('No se encontraron resultados') || alertInfo.includes('Pieza mal ingresada')) {
            return {
                success: false,
                error: "No se encontraron resultados para ese envío, o la pieza fue mal ingresada. Recuerda revisar bien el código."
            };
        }

        // Parsear los resultados (Si la tabla existe)
        const events = [];

        $('table tbody tr').each((i, row) => {
            const columns = $(row).find('td');
            if (columns.length >= 3) {
                events.push({
                    fecha: $(columns[0]).text().trim(),
                    planta: $(columns[1]).text().trim(),
                    historia: $(columns[2]).text().trim()
                });
            }
        });

        if (events.length === 0) {
            return {
                success: true,
                events: [],
                message: "No hay eventos registrados, pero el código fue interrogado. Todavía podría no haber entrado en el sistema postal."
            };
        }

        return {
            success: true,
            events: events,    // Del más viejo al más actual (suele venir así)
            latestEvent: events[events.length - 1],
            trackingCode: cleanCode
        };

    } catch (error) {
        console.error("[CorreoTracker] Error interno:", error.message);
        return {
            success: false,
            error: "Error interno del servidor al consultar Correo Argentino. " + error.message
        };
    }
}

// Permitir testeo local rápidamente ejecutando `node bot/correoTracker.js CO767694665AR`
if (require.main === module) {
    const code = process.argv[2] || 'CO767694665AR';
    console.log(`Buscando Tracking test: ${code}`);
    getTrackingNacional(code).then(result => {
        console.log(JSON.stringify(result, null, 2));
    });
}

module.exports = {
    getTrackingNacional
};
