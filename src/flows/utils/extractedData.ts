/**
 * extractedData.ts
 *
 * Parseo centralizado del string `extractedData` que la IA emite vía la tool
 * `control_dialog_flow`. Antes cada step tenía su propio regex suelto, lo que
 * hacía fácil perder un tag o duplicar lógica. Acá viven los parsers comunes.
 *
 * NOTA: la elección de producto/plan tiene vocabulario distinto según el step
 * (waiting_plan_choice usa CHANGE_PRODUCT; waiting_final_confirmation usa
 * CAMBIO_PRODUCTO) — `parseProductChange` tolera ambos.
 */

// Tags de CONTROL DE FLUJO: disparan un estado terminal o una pausa. El orden
// importa — el primero que matchea gana (REJECT_MEDICAL es el más crítico).
// Sólo van acá los tags cuyo falso positivo es RECUPERABLE y NO afecta a un
// comprador legítimo (rechazo médico, abuso, cancelación, reventa). La
// "indecisión" y el rechazo genérico NO se rigen por tag a propósito: ahí un
// disparo de más pausaría a un comprador dudoso y golpearía la conversión.
export const CONTROL_TAGS = ['REJECT_MEDICAL', 'ADVERSE_REACTION', 'ABUSE', 'CANCEL_ORDER', 'RESELLER'] as const;
export type ControlTag = typeof CONTROL_TAGS[number];

/** Devuelve el primer tag de control presente en extractedData, o null. */
export function parseControlTag(extractedData: string | null | undefined): ControlTag | null {
    if (!extractedData) return null;
    const ed = String(extractedData).toUpperCase();
    for (const t of CONTROL_TAGS) {
        if (ed.includes(t)) return t;
    }
    return null;
}

/** "POSTDATADO: 1 de julio" → "1 de julio" (o null si no hay). */
export function parsePostdatado(extractedData: string | null | undefined): string | null {
    if (!extractedData || !/POSTDATADO/i.test(extractedData)) return null;
    const m = String(extractedData).match(/POSTDATADO:\s*(.+)/i);
    return m ? m[1].trim() : null;
}

/** "PROFILE: 44 años, diabetes" → "44 años, diabetes" (o null). */
export function parseProfile(extractedData: string | null | undefined): string | null {
    if (!extractedData) return null;
    const m = String(extractedData).match(/PROFILE:\s*(.+)/i);
    return m ? m[1].trim() : null;
}

/**
 * "ENVIO: retiro" | "ENVIO: domicilio" → 'retiro' | 'domicilio' (o null).
 * Lo emite el AI fallback de waiting_payment_method cuando el cliente eligió
 * tipo de envío en un mensaje que la clasificación desvió al fallback — permite
 * que la máquina de estados transicione igual (caso real 5492215731759).
 */
export function parseShippingChoice(extractedData: string | null | undefined): 'retiro' | 'domicilio' | null {
    if (!extractedData) return null;
    // ENV[IÍ]O: el goal prima la grafía acentuada ("TIPO DE ENVÍO") y el modelo
    // escribe español — si emite "ENVÍO: retiro" con tilde, el tag tiene que
    // matchear igual (si no, la falla es silenciosa y reproduce el bug original).
    const m = String(extractedData).match(/ENV[IÍ]O:\s*(retiro|domicilio)/i);
    return m ? (m[1].toLowerCase() as 'retiro' | 'domicilio') : null;
}

/**
 * Cambio de producto/plan. Tolera "CAMBIO_PRODUCTO: Gotas PLAN: 120" y
 * "CHANGE_PRODUCT: Gotas". Devuelve { product, plan } (plan puede ser null).
 */
export function parseProductChange(extractedData: string | null | undefined): { product: string | null; plan: string | null } {
    if (!extractedData) return { product: null, plan: null };
    const ed = String(extractedData);
    const pm = ed.match(/(?:CAMBIO_PRODUCTO|CHANGE_PRODUCT):\s*(.+?)(?:\s+PLAN:|$)/i);
    const plm = ed.match(/PLAN:\s*(\d+)/i);
    return { product: pm ? pm[1].trim() : null, plan: plm ? plm[1] : null };
}
