import React, { useEffect, useId, useRef } from 'react';
import { cn } from '../../ui';

// Varias vistas bajo una misma entrada del menú, como pestañas. Es controlado:
// quien lo usa guarda cuál está activa (`activeId` + `onChange`) y solo se monta
// esa, así que cada vista sigue bajando su propio chunk recién al abrirla.
//
// tabs: [{ id, label, icon?, render: () => nodo }]. Con una sola pestaña no se
// dibuja la barra (queda la vista sola dentro del panel).
//
// Teclado (patrón de pestañas de WAI-ARIA, activación automática): flechas
// izquierda/derecha recorren en círculo, Inicio/Fin van a los extremos, y solo la
// pestaña activa entra en el orden de tabulación.
//
// `fill`: para las vistas que manejan su propio alto y scroll (el panel ocupa el
// alto que queda y no crece); sin él, el panel crece y scrollea el contenedor.
export default function TabbedView({ tabs, activeId, onChange, ariaLabel, fill = false, className }) {
    const baseId = useId();
    const listRef = useRef(null);
    const active = tabs.find(t => t.id === activeId) || tabs[0];
    const activeTabId = active?.id;

    // En el teléfono la barra scrollea de costado: la pestaña activa queda a la vista.
    useEffect(() => {
        const el = listRef.current?.querySelector('[aria-selected="true"]');
        el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }, [activeTabId]);

    if (!active) return null;

    const tabDomId = (id) => `${baseId}-tab-${id}`;
    const panelDomId = `${baseId}-panel`;
    const showBar = tabs.length > 1;

    const handleKeyDown = (event) => {
        const index = tabs.findIndex(t => t.id === active.id);
        let next = -1;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next < 0 || next === index) return;
        event.preventDefault();
        const target = tabs[next];
        onChange(target.id);
        // El botón ya existe (solo cambia cuál está seleccionado): el foco sigue a la pestaña.
        document.getElementById(tabDomId(target.id))?.focus();
    };

    return (
        <div className={cn('flex-1 flex flex-col w-full', fill && 'min-h-0', className)}>
            {showBar && (
                <div
                    ref={listRef}
                    role="tablist"
                    aria-label={ariaLabel}
                    aria-orientation="horizontal"
                    onKeyDown={handleKeyDown}
                    className="flex-shrink-0 flex items-stretch gap-1 mb-3 sm:mb-4 overflow-x-auto hide-scrollbar border-b border-slate-200 dark:border-slate-700/70"
                >
                    {tabs.map(({ id, label, icon: Icon }) => {
                        const selected = id === active.id;
                        return (
                            <button
                                key={id}
                                id={tabDomId(id)}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                aria-controls={panelDomId}
                                tabIndex={selected ? 0 : -1}
                                onClick={() => onChange(id)}
                                className={cn(
                                    'relative flex-shrink-0 inline-flex items-center gap-2 min-h-[44px] px-3 sm:px-4 -mb-px rounded-t-control border-b-2 text-sm whitespace-nowrap',
                                    'transition-colors motion-reduce:transition-none',
                                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500',
                                    selected
                                        ? 'border-accent-600 dark:border-accent-400 text-accent-700 dark:text-accent-300 font-semibold'
                                        : 'border-transparent text-slate-600 dark:text-slate-400 font-medium hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100/70 dark:hover:bg-slate-800/60'
                                )}
                            >
                                {Icon && <Icon className="w-4 h-4 flex-shrink-0" aria-hidden="true" strokeWidth={selected ? 2.5 : 2} />}
                                {label}
                            </button>
                        );
                    })}
                </div>
            )}
            <div
                id={panelDomId}
                role={showBar ? 'tabpanel' : undefined}
                aria-labelledby={showBar ? tabDomId(active.id) : undefined}
                className={cn('flex-1 flex flex-col w-full', fill && 'min-h-0')}
            >
                {active.render()}
            </div>
        </div>
    );
}
