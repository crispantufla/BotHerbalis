const querystring = require('querystring');

async function testWebScrape() {
    try {
        const url = 'https://www.correoargentino.com.ar/sites/all/modules/custom/ca_forms/api/wsFacade.php';

        const bodyData = {
            action: 'ondnc',
            id: '767694665',
            producto: 'CO',
            pais: 'AR'
        };

        console.log("POSTing to wsFacade.php:", bodyData);

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

        const text = await response.text();
        console.log("RESPONSE HTTP CODE:", response.status);
        console.log("DATA:", text);

    } catch (err) {
        console.error("ERROR:", err.message);
    }
}
testWebScrape();
