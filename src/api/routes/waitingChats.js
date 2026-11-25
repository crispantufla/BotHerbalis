/**
 * Bandeja "Te esperan" de Inicio: los chats PAUSADOS donde el último en hablar
 * fue el cliente. Una pausa no se libera sola (ver CLAUDE.md), así que esos
 * clientes quedan esperando hasta que alguien mire: esta lista es ese "alguien".
 *
 * Función pura (sin DB) para poder probarla: recibe los usuarios pausados y sus
 * filas recientes de ChatLog, y devuelve a quién hay que contestarle.
 */

const SNIPPET_MAX = 280;

/**
 * @param {Array<{phone:string,name?:string|null,pauseReason?:string|null,pausedAt?:Date|string|null}>} pausedUsers
 * @param {Array<{userPhone:string,role:string,content:string,timestamp:Date|string}>} rows
 *        Filas de ChatLog de esos teléfonos, de la más nueva a la más vieja.
 * @param {(content:string)=>boolean} isAutoReply  La bienvenida automática de
 *        WhatsApp Business queda como 'admin' pero no es una respuesta.
 * @returns {Array<{id:string,phone:string,name:string|null,pauseReason:string|null,pausedAt:any,waitingSince:number,pendingCount:number,lastMessage:string}>}
 *          Del que escribió más recién al que lleva más tiempo.
 */
function pickWaitingChats(pausedUsers, rows, isAutoReply = () => false) {
    const byPhone = new Map();
    for (const r of rows || []) {
        if (!byPhone.has(r.userPhone)) byPhone.set(r.userPhone, []);
        byPhone.get(r.userPhone).push(r);
    }

    const out = [];
    for (const u of pausedUsers || []) {
        const list = byPhone.get(u.phone);
        if (!list) continue;
        // Lo que el cliente escribió después de la última respuesta (bot o
        // persona). Mismo criterio que _pendingClientText de /resume-chat.
        const pending = [];
        for (const row of list) {
            if (row.role === 'system') continue;
            if (row.role === 'admin' && isAutoReply(row.content)) continue;
            if (row.role !== 'user') break;
            pending.push(row);
        }
        if (!pending.length) continue;

        const text = pending.slice().reverse().map((p) => String(p.content || '').trim()).filter(Boolean).join(' ');
        out.push({
            id: `${u.phone}@c.us`,
            phone: u.phone,
            name: u.name || null,
            pauseReason: u.pauseReason || null,
            pausedAt: u.pausedAt || null,
            // Desde cuándo espera: su PRIMER mensaje sin responder.
            waitingSince: new Date(pending[pending.length - 1].timestamp).getTime(),
            lastMessageAt: new Date(pending[0].timestamp).getTime(),
            pendingCount: pending.length,
            lastMessage: text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX - 1).trimEnd() + '…' : text,
        });
    }
    return out.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

module.exports = { pickWaitingChats };
