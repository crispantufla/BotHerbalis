/**
 * _isAffirmative / _isNegative
 * ULTRA-STRICT matchers — only catch dead-obvious, short, unambiguous messages.
 * Everything else goes to AI for intent classification (fewer false positives).
 * 
 * Matches: "si", "dale", "ok", "listo", "si quiero", "bueno dale"
 * Does NOT match: "si pero primero...", "bueno no sé", "si fuera más barato"
 */
function _isAffirmative(normalizedText: string): boolean {
    const trimmed = normalizedText.trim();
    if (!trimmed) return false;
    const words = trimmed.split(/\s+/);

    // NEVER match if it contains a question mark
    if (trimmed.includes('?')) return false;

    // NEVER match if longer than 6 words — too ambiguous, let AI handle
    if (words.length > 6) return false;

    // NEVER match if contains negation/conditional/doubt words.
    // "no" suelto incluido: "no, dale de baja" contiene \bdale\b y confirmaría.
    // Falso negativo acá es barato (cae a la IA); falso positivo guarda una orden.
    if (/\b(no|pero|primero|antes|aunque|capaz|quizas|tal vez|todavia|mejor|ni idea)\b/.test(trimmed)) return false;

    // Match: standalone strong affirmatives (any length ≤ 6)
    if (/\b(dale|listo|de una|joya|buenisimo|genial|perfecto|por supuesto)\b/.test(trimmed)) return true;

    // Match: mensaje ENTERO de confirmación ("confirmo", "correcto", "acepto").
    // Solo como mensaje completo a propósito: embebidas en una frase más larga
    // ("no confirmo nada") NO alcanzan — eso lo decide la IA.
    if (/^(confirmo|confirmado|correcto|acepto)[\s!.]*$/.test(trimmed)) return true;

    // Match: "si" / "sisi" / "claro" / "ok" / "bueno" / "va" only if message is very short (≤ 3 words)
    if (words.length <= 3 && /\b(si|sisi|claro|ok|bueno|va|vamos|sip|sep|esta bien)\b/.test(trimmed)) return true;

    return false;
}

function _isNegative(normalizedText: string): boolean {
    const trimmed = normalizedText.trim();
    if (!trimmed) return false;
    const words = trimmed.split(/\s+/);

    if (trimmed.includes('?')) return false;
    if (words.length > 6) return false;

    // Strong negatives
    if (/\b(no puedo|imposible|no quiero|ni loca|ni loco|no me interesa|no gracias)\b/.test(trimmed)) return true;

    // Short negatives
    if (words.length <= 3 && /\b(no|nop|nope|nel|nah|para nada)\b/.test(trimmed)) return true;

    return false;
}

export {
    _isAffirmative,
    _isNegative
};
