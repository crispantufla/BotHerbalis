import React, { useRef, useState, useEffect } from 'react';
import { ChevronDown, Users, Wifi, WifiOff } from 'lucide-react';
import { useSeller } from '../../context/SellerContext';
import { capitalize } from '../../utils/format';
import { cn } from '../ui';

// Dropdown chico — no se refactoriza a Modal porque su UX es de menu anchor
// (cierra al click afuera, sin backdrop). Mantenemos el patrón nativo pero
// estilado con los tokens del design system.
const SellerSelector = () => {
    const { sellers, selectedSellerId, setSelectedSellerId, selectedSeller } = useSeller();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const select = (id) => {
        setSelectedSellerId(id);
        setOpen(false);
    };

    // Presencia web: online=verde, idle=naranja, offline=gris.
    const presenceDot = (seller) => {
        if (seller.webPresence === 'online') return 'bg-success-500';
        if (seller.webPresence === 'idle')   return 'bg-warning-500';
        return 'bg-slate-300 dark:bg-slate-600';
    };
    const presenceTitle = (seller) => {
        if (seller.webPresence === 'online') return 'Con la web abierta';
        if (seller.webPresence === 'idle')   return 'Inactivo más de 10 min';
        return 'Sin sesión web activa';
    };

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-haspopup="listbox"
                aria-expanded={open}
                className={cn(
                    'inline-flex items-center gap-2 px-3 h-9 rounded-control text-sm font-medium',
                    'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700',
                    'text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500'
                )}
            >
                <Users className="w-4 h-4 text-accent-600 dark:text-accent-400" aria-hidden="true" />
                <span className="max-w-[140px] truncate">
                    {selectedSeller ? capitalize(selectedSeller.name) : 'Seleccionar vendedor'}
                </span>
                {selectedSeller && (
                    <span className={cn('w-2 h-2 rounded-full flex-shrink-0', presenceDot(selectedSeller))} />
                )}
                <ChevronDown
                    aria-hidden="true"
                    className={cn(
                        'w-3.5 h-3.5 text-slate-400 transition-transform',
                        open && 'rotate-180'
                    )}
                />
            </button>

            {open && (
                <div
                    role="listbox"
                    className="absolute right-0 top-full mt-1.5 w-64 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-card shadow-elevated z-50 overflow-hidden"
                >
                    {sellers.map(seller => {
                        const archived = seller.isActive === false;
                        const isSelected = selectedSellerId === seller.sellerId;
                        return (
                            <button
                                key={seller.sellerId}
                                type="button"
                                role="option"
                                aria-selected={isSelected}
                                onClick={() => select(seller.sellerId)}
                                title={archived ? 'Vendedor archivado — sus ventas siguen disponibles para consulta' : undefined}
                                className={cn(
                                    'w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                                    'hover:bg-slate-50 dark:hover:bg-slate-700/60',
                                    'focus:outline-none focus-visible:bg-slate-100 dark:focus-visible:bg-slate-700',
                                    isSelected
                                        ? 'bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300 font-semibold'
                                        : 'text-slate-700 dark:text-slate-200',
                                    archived && 'opacity-60'
                                )}
                            >
                                <span
                                    className={cn('w-2 h-2 rounded-full flex-shrink-0', presenceDot(seller))}
                                    title={presenceTitle(seller)}
                                />
                                <div className="flex-1 text-left min-w-0">
                                    <div className="truncate capitalize flex items-center gap-1.5">
                                        <span>{seller.name}</span>
                                        {archived && (
                                            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-normal">
                                                archivado
                                            </span>
                                        )}
                                    </div>
                                    {seller.phoneNumber && (
                                        <div className="text-xs text-slate-400 dark:text-slate-500 truncate font-mono">
                                            +{seller.phoneNumber}
                                        </div>
                                    )}
                                </div>
                                {seller.connected ? (
                                    <Wifi className="w-3.5 h-3.5 text-success-500 flex-shrink-0" aria-label="Bot conectado" />
                                ) : (
                                    <WifiOff className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 flex-shrink-0" aria-label="Bot desconectado" />
                                )}
                            </button>
                        );
                    })}

                    {sellers.length === 0 && (
                        <p className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400 text-center">
                            Sin vendedores activos
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};

export default SellerSelector;
