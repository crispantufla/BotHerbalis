import React from 'react';
import { ShoppingCart, Zap } from 'lucide-react';
import { Badge, cn } from '../../ui';
import { isUnanswered } from './chatFilters';

// Display helpers — antes vivían inline en el .map(), los extraigo para que se
// lean linealmente.
//
// IDs largos (>13 chars) son LIDs/proxies de Meta (anuncios) y NO el teléfono
// real del cliente. Cuando el nombre del contacto sí tiene un teléfono AR
// (10-13 dígitos), preferimos mostrar ese.
function displayPhone(chat) {
    const rawId = chat.id?.split('@')[0] || '';
    const cleanName = (chat.name || '').replace(/\D/g, '');
    if (rawId.length > 13 && cleanName.length >= 10 && cleanName.length <= 13) return cleanName;
    if (rawId.length > 13) return 'Anuncio (Oculto)';
    return rawId;
}

// Nombre real del contacto, o null. El backend manda `+<teléfono>` cuando no hay
// nombre, un chat creado por socket trae el id (`549…@c.us`) y la búsqueda manda
// null: nada de eso es un nombre. Lo es solo si, sacado lo que parece un id,
// queda alguna letra.
function realName(chat) {
    const rawName = (chat.name || '').trim();
    if (!rawName || rawName.includes('@')) return null;
    if (!/\p{L}/u.test(rawName)) return null;
    return rawName;
}

// Teléfono legible. Los dígitos nunca se cambian, solo se agrupan: código de país
// y, para los móviles argentinos (549 + 10 dígitos), el número en bloques.
function formatPhone(digits) {
    if (!/^\d+$/.test(digits)) return digits;
    if (digits.length === 13 && digits.startsWith('549')) {
        const n = digits.slice(3);
        // AMBA (11) usa 2 dígitos de característica; el resto se agrupa 3-3-4.
        return n.startsWith('11')
            ? `+54 9 11 ${n.slice(2, 6)}-${n.slice(6)}`
            : `+54 9 ${n.slice(0, 3)} ${n.slice(3, 6)}-${n.slice(6)}`;
    }
    return `+${digits}`;
}

// Título y segunda línea de la fila: con nombre real, el nombre arriba y el
// número en chico; sin nombre, el número arriba y nada debajo (antes se repetía).
function rowLabels(chat) {
    const phone = displayPhone(chat);
    const phoneLabel = /^\d+$/.test(phone) ? formatPhone(phone) : null; // null: id de anuncio sin teléfono
    const name = realName(chat);
    if (name) return { title: name, subtitle: phoneLabel || 'Contacto de anuncio' };
    return { title: phoneLabel || 'Contacto de anuncio', subtitle: null };
}

// Highlight de match en snippet de búsqueda. Mantenemos un margen pequeño
// (20/40 chars) para que el snippet quepa en la card sin overflow.
function highlightSnippet(text, term) {
    const i = text.toLowerCase().indexOf(term.toLowerCase());
    if (i < 0) return text;
    const start = Math.max(0, i - 20);
    const end = Math.min(text.length, i + term.length + 40);
    return {
        before: (start > 0 ? '…' : '') + text.slice(start, i),
        match: text.slice(i, i + term.length),
        after: text.slice(i + term.length, end) + (end < text.length ? '…' : ''),
    };
}

// Memoizado: con `chat` y `onSelect` estables, la fila no se vuelve a renderizar
// cuando cambia otra cosa de CommsView (cada tecla en la caja de mensaje).
function ChatSidebarItem({ chat, isSelected, hasAlert, searchTerm, onSelect }) {
    const handleClick = () => onSelect(chat);
    const { title, subtitle } = rowLabels(chat);
    const unanswered = isUnanswered(chat);

    return (
        <button
            type="button"
            onClick={handleClick}
            className={cn(
                'w-full text-left p-3 rounded-control flex transition-colors duration-150',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                isSelected
                    ? 'bg-accent-600 text-white'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
            )}
        >
            <div className="flex-1 min-w-0">
                <div className="flex justify-between items-start gap-2 mb-0.5">
                    <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <h3 className={cn(
                                'font-semibold text-sm tracking-tight truncate',
                                isSelected ? 'text-white' : 'text-slate-900 dark:text-slate-100'
                            )}>
                                {title}
                            </h3>
                            {hasAlert ? (
                                <span
                                    role="img"
                                    className="w-2 h-2 rounded-full flex-shrink-0 bg-danger-500 animate-pulse motion-reduce:animate-none"
                                    title="Atención requerida"
                                    aria-label="Atención requerida"
                                />
                            ) : chat.isPaused && (
                                <span
                                    role="img"
                                    className="w-2 h-2 rounded-full flex-shrink-0 bg-warning-500 animate-pulse motion-reduce:animate-none"
                                    title="Bot pausado"
                                    aria-label="Bot pausado"
                                />
                            )}
                            {chat.hasBought && (
                                <span
                                    className={cn(
                                        'inline-flex items-center flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium gap-1',
                                        isSelected
                                            ? 'bg-white/20 text-white'
                                            : 'bg-success-50 dark:bg-success-900/30 text-success-700 dark:text-success-500'
                                    )}
                                    title="Cliente recurrente"
                                >
                                    <ShoppingCart className="w-2.5 h-2.5" />
                                    Cliente
                                </span>
                            )}
                        </div>
                        {subtitle && (
                            <span className={cn(
                                'text-xs truncate tabular-nums',
                                isSelected ? 'text-accent-100' : 'text-slate-500 dark:text-slate-400'
                            )}>
                                {subtitle}
                            </span>
                        )}
                    </div>
                    <span className={cn(
                        'text-[11px] font-mono tabular-nums flex-shrink-0',
                        isSelected ? 'text-accent-100' : 'text-slate-500 dark:text-slate-400'
                    )}>
                        {chat.time}
                    </span>
                </div>

                <div className="flex items-center gap-2 mt-0.5">
                    {/* Sin responder: punto + texto para lectores de pantalla + preview en peso medio (no solo color). */}
                    {unanswered && (
                        <span className="flex items-center flex-shrink-0">
                            <span
                                aria-hidden="true"
                                title="Sin responder"
                                className={cn(
                                    'w-1.5 h-1.5 rounded-full',
                                    isSelected ? 'bg-white' : 'bg-accent-600 dark:bg-accent-400'
                                )}
                            />
                            <span className="sr-only">Sin responder.</span>
                        </span>
                    )}
                    {chat.searchSnippet ? (
                        <p
                            className={cn(
                                'text-xs truncate flex-1 leading-snug',
                                isSelected ? 'text-accent-100' : 'text-slate-500 dark:text-slate-300'
                            )}
                            title={chat.searchSnippet}
                        >
                            <span className={cn(
                                'text-[10px] uppercase font-medium mr-1',
                                isSelected ? 'text-white/80' : 'text-slate-500 dark:text-slate-400'
                            )}>
                                {chat.searchSnippetRole === 'user' ? 'cliente' : chat.searchSnippetRole === 'bot' ? 'bot' : ''}
                            </span>
                            {(() => {
                                const term = searchTerm?.trim() || '';
                                if (!term) return chat.searchSnippet;
                                const h = highlightSnippet(chat.searchSnippet, term);
                                if (typeof h === 'string') return h;
                                return (
                                    <>
                                        {h.before}
                                        <mark className={cn(
                                            'rounded px-0.5',
                                            isSelected
                                                ? 'bg-yellow-300/40 text-white'
                                                : 'bg-yellow-200 dark:bg-yellow-700/60 text-slate-900 dark:text-yellow-100'
                                        )}>{h.match}</mark>
                                        {h.after}
                                    </>
                                );
                            })()}
                        </p>
                    ) : (
                        <p className={cn(
                            'text-xs truncate flex-1 leading-snug',
                            unanswered && 'font-medium',
                            isSelected
                                ? (unanswered ? 'text-white' : 'text-accent-100')
                                : (unanswered ? 'text-slate-700 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400')
                        )}>
                            {chat.lastMessage?.body || 'Sin mensajes'}
                        </p>
                    )}
                    {chat.unreadCount > 0 && !isSelected && (
                        <Badge tone="danger" size="sm" className="flex-shrink-0 !px-1.5 min-w-[1.25rem] justify-center">
                            {chat.unreadCount}
                        </Badge>
                    )}
                </div>
            </div>
        </button>
    );
}

export default React.memo(ChatSidebarItem);
