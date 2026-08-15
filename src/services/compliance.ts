/**
 * compliance.ts — Filtro determinista de claims prohibidos.
 *
 * Ninguna pieza llega a la cola de aprobación sin pasar por aquí. El prompt del
 * generador ya pide no escribir estas cosas, pero un prompt es una petición, no
 * una garantía: esto es la garantía.
 *
 * Las reglas salen de dos sitios distintos y por eso no son negociables:
 *
 * 1. Reglamento (CE) 1924/2006, art. 12(b): prohíbe cualquier declaración que
 *    mencione el ritmo o la magnitud de la pérdida de peso. "Pierde 5 kg en un
 *    mes" es ilegal en la UE para cualquier complemento, haya o no evidencia.
 *    Y la AEMPS ya retiró un producto de nuez de la india del mercado español
 *    (alerta 13/2012) precisamente por presentarlo con propiedades adelgazantes:
 *    con ese claim deja de ser complemento y pasa a ser medicamento ilegal.
 *
 * 2. Normas de publicidad de Meta: los "atributos personales" (dar a entender
 *    que conoces el cuerpo de quien mira: "¿te sobran esos kilos?") y las
 *    imágenes antes/después son motivo de rechazo. El vertical de adelgazantes
 *    es el más vigilado de la plataforma y la reincidencia escala de rechazo de
 *    anuncio a inhabilitación de la cuenta publicitaria y del Business Manager.
 *
 * El coste de un falso positivo es regenerar una pieza. El de un falso negativo
 * es perder la cuenta publicitaria. El filtro es deliberadamente severo.
 */

export interface ComplianceIssue {
    /** Regla que saltó, para poder afinarla luego. */
    rule: string;
    /** Fragmento exacto del texto que la disparó. */
    match: string;
    /** Qué hacer en su lugar — se le devuelve a la IA al regenerar. */
    hint: string;
}

interface Rule {
    id: string;
    pattern: RegExp;
    hint: string;
}

const RULES: Rule[] = [
    {
        // Art. 12(b): magnitud o ritmo de la pérdida de peso.
        id: 'magnitud-perdida-peso',
        pattern: /\b\d+\s*(kg|kilo|kilos|quilos|gramos)\b|\b(pierde|baja|adelgaza|elimina|quema)\s+\w{0,12}\s*\d+/i,
        hint: 'No se puede mencionar cuántos kilos ni en cuánto tiempo. Habla de sensación de ligereza, digestión o rutina.',
    },
    {
        // Un plazo cerca de una palabra de peso/figura, en cualquier orden: da
        // igual si es "3 semanas para tu peso" o "tu peso en 3 semanas".
        id: 'ritmo-perdida-peso',
        pattern: new RegExp(
            '\\b(peso|kilos?|adelgaz\\w*|talla|figura|b[aá]scula)\\b[^.]{0,60}\\ben\\s+(solo\\s+)?\\d+\\s*(d[ií]as?|semanas?|meses?)\\b' +
            '|\\ben\\s+(solo\\s+)?\\d+\\s*(d[ií]as?|semanas?|meses?)\\b[^.]{0,60}\\b(peso|kilos?|adelgaz\\w*|talla|figura)\\b' +
            '|\\b(resultados?|cambios?)\\s+(visibles?\\s+)?en\\s+\\d+\\s*(d[ií]as?|semanas?)',
            'i'
        ),
        hint: 'No se pueden prometer resultados en un plazo concreto. Describe la rutina, no el calendario.',
    },
    {
        // Verbo de adelgazamiento directo — convierte el producto en medicamento
        // ante la AEMPS y es el claim que Meta rechaza.
        id: 'claim-adelgazante',
        // Las conjugaciones importan: el material de la agencia traía "Bajá de
        // peso sin dietas estrictas", que una regla escrita solo para el
        // infinitivo ("bajar de peso") deja pasar entera.
        // OJO con `\w` en español: no incluye vocales acentuadas, así que
        // "Bajá" y "eliminación" se escapaban de una regla escrita con `\w*`.
        pattern: /\badelgaz[a-záéíóúñ]*\b|\bquema\s*grasas?\b|\bquemagrasas?\b|\bderrite\b|\b(baj|perd|pierd|reduc|elimin)[a-záéíóúñ]*\s+(de\s+)?(peso|grasas?|toxinas)\b|\bbaj[éí](?![a-záéíóúñ])/i,
        hint: 'Evita el verbo adelgazar y equivalentes (bajar/perder peso, quemar o eliminar grasa) en cualquier conjugación. La marca dice "control del peso", "sentirte más ligera", "bienestar digestivo".',
    },
    {
        // Meta: atributos personales. Dar por sabido el cuerpo de quien lee.
        id: 'atributos-personales',
        pattern: /\b(tus|esos|tu)\s+(kilos|michelines|grasa|barriga|tripa|abdomen|celulitis)\b|\bte\s+sobran?\b|\b(tienes|sufres|padeces)\s+(sobrepeso|obesidad|barriga|tripa)\b/i,
        hint: 'No te dirijas al cuerpo de quien lee ni des por hecho su situación. Habla en tercera persona o de la experiencia general.',
    },
    {
        id: 'antes-despues',
        pattern: /\bantes\s*(y|\/|-)\s*despu[eé]s\b|\btransformaci[oó]n\s+(corporal|f[ií]sica)\b|\bmira\s+(el|mi|su)\s+cambio\b/i,
        hint: 'Nada de antes/después ni transformaciones corporales: es rechazo directo en Meta.',
    },
    {
        // Claims terapéuticos: frontera con medicamento.
        id: 'claim-medico',
        // "efecto rebote" va SIN el "sin" delante a propósito. La regla pedía
        // la fórmula exacta "sin efecto rebote" y se le colaba "No hay efecto
        // rebote", que es la misma promesa dicha de otra manera: estuvo en la
        // FAQ del guion desde el fork y esta auditoría la daba por buena. Da
        // igual cómo se enuncie — decir que no lo hay es prometer un resultado
        // sostenido en el tiempo, y eso no se puede afirmar ni siquiera para
        // tranquilizar a quien lo pregunta.
        pattern: /\b(cura|curar|sana|sanar|trata|tratar|elimina)\s+(el|la|los|las)\s+\w+|\bmilagro\w*\b|\bgarantiza\w*\s+resultados?\b|\befecto\s+rebote\b|\bdesintoxica\b|\bdetox\b/i,
        hint: 'Sin promesas terapéuticas, milagros, garantías ni "detox". Y nada de "efecto rebote", ni para negarlo. Verbos blandos: acompaña, ayuda a, favorece.',
    },
    {
        // Un testimonio inventado es publicidad engañosa (Directiva UE
        // 2019/2161 sobre reseñas falsas, y Ley de Competencia Desleal). La IA
        // no tiene clientas reales de las que hablar, así que cualquier firma
        // con nombre y edad que produzca es ficción presentada como verdad.
        id: 'testimonio-inventado',
        pattern: /—\s*[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+,?\s*\d{2}\s*años|\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+\(\d{2}\)|\b(cuenta|dice|nos escribe)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\b/,
        hint: 'No inventes clientas ni testimonios. Habla como marca (nosotras) o en general. Un testimonio real se añade a mano y con permiso.',
    },
    {
        id: 'urgencia-falsa',
        pattern: /\b[uú]ltimas?\s+(unidades|plazas|horas)\b|\bsolo\s+hoy\b|\bcorre\b|\bno\s+te\s+lo\s+pierdas\b/i,
        hint: 'La marca no usa urgencia agresiva. Mantén el tono calmado de la web.',
    },
    {
        // Argentinismos: esta cuenta es de España.
        id: 'voseo',
        // Cuidado con los imperativos: "mira", "descarga" y "anda" son tuteo
        // correcto y solo son voseo con tilde final ("mirá", "descargá",
        // "andá"). Aceptar la forma sin tilde marcaba como argentino un texto
        // peninsular perfecto. Y como la tilde no es carácter de palabra, el
        // cierre va con lookahead en vez de \b.
        // "sabes", "vienes" y "haces" son tuteo CORRECTO: el voseo lleva tilde
        // ("sabés", "venís", "hacés"). Aceptar la forma sin tilde marcaba como
        // argentino un texto peninsular perfecto — mismo error que con "mira".
        pattern: /\b(escribinos|seguinos|tenes|podes|queres|sos)\b|\b(sab|ven|hac|ten|pod|quer)[éí]s(?![a-záéíóúñ])|\b(eleg|descarg|mir|and|compr|prob|empez|consult|fijate|acordate)[áí](?![a-záéíóúñ])|\bvos\b(?!\s*otros)/i,
        hint: 'Español de España: tuteo peninsular (elige, descarga, escríbenos, tienes, puedes, empieza).',
    },
];

/**
 * Revisa todos los textos de una pieza. Devuelve los problemas encontrados;
 * vacío = se puede publicar.
 */
export function checkCompliance(texts: Array<string | undefined | null>): ComplianceIssue[] {
    const issues: ComplianceIssue[] = [];
    const joined = texts.filter(Boolean).join('\n');

    for (const rule of RULES) {
        const m = joined.match(rule.pattern);
        if (m) {
            issues.push({ rule: rule.id, match: m[0], hint: rule.hint });
        }
    }
    return issues;
}

/** Resumen de una línea para logs y para el panel. */
export function describeIssues(issues: ComplianceIssue[]): string {
    return issues.map(i => `${i.rule} ("${i.match}")`).join('; ');
}
