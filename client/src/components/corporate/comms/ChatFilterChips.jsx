import React from 'react';
import { cn } from '../../ui';
import { CHAT_FILTERS } from './chatFilters';

// Fila de filtros rápidos de la lista de chats. Son botones de alternar
// (`aria-pressed`) dentro de un grupo con nombre: se recorren con Tab y se
// activan con Enter o Espacio. Si no caben, la fila se desplaza en horizontal;
// el foco usa anillo interior porque el contenedor con scroll recortaría uno exterior.
function ChatFilterChips({ value, counts, onChange }) {
    return (
        <div
            role="group"
            aria-label="Filtrar chats"
            className="flex gap-1.5 overflow-x-auto overscroll-x-contain px-3 sm:px-4 py-2 border-b border-slate-200 dark:border-slate-800 flex-shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
            {CHAT_FILTERS.map((f) => {
                const active = value === f.id;
                return (
                    <button
                        key={f.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange(f.id)}
                        className={cn(
                            'inline-flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap rounded-full px-3 text-xs font-medium',
                            'min-h-[40px] md:min-h-[32px] transition-colors duration-150',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset',
                            active
                                ? 'bg-accent-600 text-white focus-visible:ring-white'
                                : 'bg-slate-100 dark:bg-slate-700/60 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 focus-visible:ring-accent-500'
                        )}
                    >
                        {f.label}
                        <span
                            className={cn(
                                'tabular-nums text-[11px]',
                                active ? 'text-accent-100' : 'text-slate-500 dark:text-slate-400'
                            )}
                        >
                            {counts[f.id] ?? 0}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

export default React.memo(ChatFilterChips);
