import React, { useRef, useState, useEffect } from 'react';
import { useSeller } from '../../context/SellerContext';
import { useSocket } from '../../context/SocketContext';
import { ChevronDown, Users, Wifi, WifiOff } from 'lucide-react';
import { capitalize } from '../../utils/format';

const SellerSelector = () => {
    const { sellers, selectedSellerId, setSelectedSellerId, selectedSeller } = useSeller();
    const { socket } = useSocket();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    // Close on outside click
    useEffect(() => {
        const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const select = (id) => {
        setSelectedSellerId(id); // SellerContext emits switch-seller automatically
        setOpen(false);
    };

    // Dot = web presence: online=green, idle=orange, offline=grey
    const presenceDot = (seller) => {
        if (seller.webPresence === 'online') return 'bg-emerald-500';
        if (seller.webPresence === 'idle')   return 'bg-orange-400';
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
                onClick={() => setOpen(v => !v)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors text-sm font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700"
            >
                <Users className="w-4 h-4 text-indigo-500" />
                <span className="max-w-[140px] truncate">
                    {selectedSeller ? capitalize(selectedSeller.name) : 'Seleccionar vendedor'}
                </span>
                {selectedSeller && (
                    <span className={`w-2 h-2 rounded-full ${presenceDot(selectedSeller)} flex-shrink-0`} />
                )}
                <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-1.5 w-64 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 overflow-hidden">
                    {sellers.map(seller => {
                        const archived = seller.isActive === false;
                        return (
                            <button
                                key={seller.sellerId}
                                onClick={() => select(seller.sellerId)}
                                title={archived ? 'Vendedor archivado — sus ventas siguen disponibles para consulta' : undefined}
                                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors
                                    ${selectedSellerId === seller.sellerId ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-700 dark:text-slate-200'}
                                    ${archived ? 'opacity-60' : ''}`}
                            >
                                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${presenceDot(seller)}`} title={presenceTitle(seller)} />
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
                                        <div className="text-xs text-slate-400 dark:text-slate-500 truncate">+{seller.phoneNumber}</div>
                                    )}
                                </div>
                                {seller.connected ? (
                                    <Wifi className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" title="Bot conectado" />
                                ) : (
                                    <WifiOff className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 flex-shrink-0" title="Bot desconectado" />
                                )}
                            </button>
                        );
                    })}

                    {sellers.length === 0 && (
                        <div className="px-4 py-3 text-xs text-slate-400 dark:text-slate-500 text-center">
                            Sin vendedores activos
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default SellerSelector;
