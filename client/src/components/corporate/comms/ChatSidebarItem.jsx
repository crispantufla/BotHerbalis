import React from 'react';
import { ShoppingCart, Zap } from 'lucide-react';
import { Badge, cn } from '../../ui';

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

function displayName(chat) {
    const rawId = chat.id?.split('@')[0] || '';
    const rawName = chat.name || '';
    const cleanName = rawName.replace(/\D/g, '');
    if (rawName.includes('+47') || cleanName.length > 13) return 'Contacto de Anuncio';
    if (rawId.length > 13 && cleanName.length >= 10 && cleanName.length <= 13 && rawName.includes('+')) {
        return 'Contacto de Anuncio';
    }
    return rawName || 'Desconocido';
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

export default function ChatSidebarItem({ chat, isSelected, hasAlert, searchTerm, onSelect }) {
    const handleClick = () => onSelect(chat);

    return (
        <button
            type="button"
            onClick={handleClick}
            className={cn(
                'w-full text-left p-3 mb-1 rounded-control flex transition-colors duration-150',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                isSelected
                    ? 'bg-accent-600 text-white'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
            )}
        >
            <div className="flex-1 min-w-0">
                <div className="flex justify-between items-start gap-2 mb-0.5">
                    <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-1.5">
                            <h3 className={cn(
                                'font-semibold text-sm tracking-tight',
                                isSelected ? 'text-white' : 'text-slate-900 dark:text-slate-100'
                            )}>
                                +{displayPhone(chat)}
                            </h3>
                            {hasAlert ? (
                                <span
                                    className="w-2 h-2 rounded-full bg-danger-500 animate-pulse"
                                    title="Atención requerida"
                                    aria-label="Atención requerida"
                                />
                            ) : chat.isPaused && (
                                <span
                                    className="w-2 h-2 rounded-full bg-warning-500 animate-pulse"
                                    title="Bot pausado"
                                    aria-label="Bot pausado"
                                />
                            )}
                            {chat.hasBought && (
                                <span
                                    className={cn(
                                        'inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-medium gap-1',
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
                        <span className={cn(
                            'text-xs truncate',
                            isSelected ? 'text-accent-100' : 'text-slate-500 dark:text-slate-400'
                        )}>
                            {displayName(chat)}
                        </span>
                    </div>
                    <span className={cn(
                        'text-[11px] font-mono tabular-nums flex-shrink-0',
                        isSelected ? 'text-accent-100' : 'text-slate-400 dark:text-slate-500'
                    )}>
                        {chat.time}
                    </span>
                </div>

                <div className="flex items-center gap-2 mt-0.5">
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
                                isSelected ? 'text-white/70' : 'text-slate-400 dark:text-slate-500'
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
                            isSelected ? 'text-accent-100' : 'text-slate-500 dark:text-slate-400'
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
