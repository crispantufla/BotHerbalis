// Filtros rápidos de la lista de chats. Funciones puras: se aplican DESPUÉS de
// la búsqueda (useChatSearch), sobre la lista que ya se iba a mostrar.

// "Sin responder": lo último lo dijo el cliente. `lastMessage.fromMe` lo manda
// GET /chats y lo mantiene useChat con cada `new_log`; si no se sabe (null) no cuenta.
export const isUnanswered = (chat) => !!chat?.lastMessage && chat.lastMessage.fromMe === false;

export const CHAT_FILTERS = [
    { id: 'all', label: 'Todos', test: () => true, empty: 'No hay chats' },
    { id: 'unanswered', label: 'Sin responder', test: isUnanswered, empty: 'No hay chats sin responder' },
    { id: 'paused', label: 'Pausados', test: (c) => !!c.isPaused, empty: 'No hay chats pausados' },
    { id: 'customers', label: 'Clientes', test: (c) => !!c.hasBought, empty: 'Todavía no hay clientes' },
];

const byId = new Map(CHAT_FILTERS.map(f => [f.id, f]));

export const getChatFilter = (id) => byId.get(id) || CHAT_FILTERS[0];

// { all: n, unanswered: n, paused: n, customers: n } en una sola pasada.
export function countChatFilters(chats) {
    const counts = {};
    for (const f of CHAT_FILTERS) counts[f.id] = 0;
    for (const chat of chats) {
        for (const f of CHAT_FILTERS) if (f.test(chat)) counts[f.id] += 1;
    }
    return counts;
}

// Con 'all' devuelve la MISMA lista (no una copia): su identidad es lo que deja
// a ChatList saltearse el render.
export function applyChatFilter(chats, id) {
    if (id === 'all') return chats;
    return chats.filter(getChatFilter(id).test);
}
