// Placeholders de los guiones que el panel resuelve para mostrar un texto (el bot
// los resuelve de verdad en src/flows/utils/messages.ts). Los precios salen SIEMPRE
// del Editor de Precios (/api/prices): si uno no está cargado, su placeholder queda
// visible tal cual, para que nadie mande un número viejo o inventado sin darse cuenta.

export const BANK_ALIAS = 'HERBALIS.TIENDA';
export const BANK_HOLDER = 'BIO ORIGEN S.A.S.';

const PRICE_TAGS = [
    ['PRICE_CAPSULAS_60', (p) => p['Cápsulas']?.['60']],
    ['PRICE_CAPSULAS_120', (p) => p['Cápsulas']?.['120']],
    ['PRICE_SEMILLAS_60', (p) => p['Semillas']?.['60']],
    ['PRICE_SEMILLAS_120', (p) => p['Semillas']?.['120']],
    ['PRICE_GOTAS_60', (p) => p['Gotas']?.['60']],
    ['PRICE_GOTAS_120', (p) => p['Gotas']?.['120']],
    ['ADICIONAL_MAX', (p) => p.adicionalMAX],
    ['COSTO_LOGISTICO', (p) => p.costoLogistico],
];

export function fillPricePlaceholders(text, prices) {
    const p = prices || {};
    let result = text;
    for (const [tag, get] of PRICE_TAGS) {
        const val = get(p);
        if (val != null && val !== '') result = result.replace(new RegExp(`{{${tag}}}`, 'g'), String(val));
    }
    return result;
}
