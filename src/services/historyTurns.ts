/**
 * Normaliza el historial del bot a turnos user/assistant válidos para la
 * Messages API de Claude. Hoy el historial viaja APLANADO como texto dentro de
 * un único turno de usuario (ai.ts), lo que degrada el seguimiento del hilo;
 * pasarlo como turnos nativos sigue mucho mejor la conversación.
 *
 * Claude exige que el PRIMER mensaje de messages[] sea 'user'. Esta función
 * deja el array listo para usarse como `[...turns, { role:'user', content: <mensaje actual> }]`:
 *
 *  - Mapea roles: 'user' -> 'user'; 'bot'/'admin'/'system'/cualquier otro -> 'assistant'.
 *  - Saca la última entrada si es el mensaje ACTUAL del usuario (salesFlow lo
 *    pushea al history ANTES de correr el step; sin esto quedarían dos 'user'
 *    seguidos o se duplicaría el mensaje).
 *  - Mergea entradas consecutivas del mismo role (varios steps —greeting,
 *    preference, data— pushean la respuesta del bot en 2+ entradas por turno).
 *  - Descarta turnos 'assistant' iniciales (Claude rechaza un primer mensaje assistant → 400).
 */

export interface ChatTurn {
    role: 'user' | 'assistant';
    content: string;
}

interface RawHistoryEntry {
    role?: string;
    content?: string;
    timestamp?: number;
}

export function buildHistoryTurns(
    history: RawHistoryEntry[] | undefined | null,
    currentUserText: string = ''
): ChatTurn[] {
    if (!Array.isArray(history) || history.length === 0) return [];

    let entries = history;

    // 1. Sacar el mensaje actual del usuario (último), ya pusheado antes del step.
    const last = entries[entries.length - 1];
    if (last && last.role === 'user' && (last.content || '').trim() === (currentUserText || '').trim()) {
        entries = entries.slice(0, -1);
    }

    // 2. Mapear roles y descartar vacíos.
    const mapped: ChatTurn[] = [];
    for (const m of entries) {
        const content = m && typeof m.content === 'string' ? m.content : '';
        if (!content.trim()) continue;
        mapped.push({ role: m.role === 'user' ? 'user' : 'assistant', content });
    }

    // 3. Mergear consecutivos del mismo role.
    const merged: ChatTurn[] = [];
    for (const t of mapped) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === t.role) prev.content += '\n' + t.content;
        else merged.push({ role: t.role, content: t.content });
    }

    // 4. Claude exige que el primer turno sea 'user'.
    while (merged.length && merged[0].role === 'assistant') merged.shift();

    return merged;
}
