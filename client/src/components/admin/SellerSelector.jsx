import React, { useRef, useState, useEffect } from 'react';
import { useSeller } from '../../context/SellerContext';
import { useSocket } from '../../context/SocketContext';
import { ChevronDown, Wifi, WifiOff, Users } from 'lucide-react';

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
        setSelectedSellerId(id);
        if (socket) socket.emit('switch-seller', id);
        setOpen(false);
    };

    const statusDot = (seller) => {
        if (seller.connected) return 'bg-emerald-500';
        if (seller.running) return 'bg-amber-400';
        return 'bg-slate-300 dark:bg-slate-600';
    };

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(v => !v)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors text-sm font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700"
            >
                <Users className="w-4 h-4 text-indigo-500" />
                <span className="max-w-[140px] truncate">
                    {selectedSeller ? selectedSeller.name.charAt(0).toUpperCase() + selectedSeller.name.slice(1) : 'Todos los vendedores'}
                </span>
                {selectedSeller && (
                    <span className={`w-2 h-2 rounded-full ${statusDot(selectedSeller)} flex-shrink-0`} />
                )}
                <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-1.5 w-64 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 overflow-hidden">
                    {/* "All sellers" option */}
                    <button
                        onClick={() => select(null)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors
                            ${!selectedSellerId ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-700 dark:text-slate-200'}`}
                    >
                        <Users className="w-4 h-4 opacity-60" />
                        Todos los vendedores
                    </button>

                    {sellers.length > 0 && <div className="border-t border-slate-100 dark:border-slate-700" />}

                    {sellers.map(seller => (
                        <button
                            key={seller.sellerId}
                            onClick={() => select(seller.sellerId)}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors
                                ${selectedSellerId === seller.sellerId ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-semibold' : 'text-slate-700 dark:text-slate-200'}`}
                        >
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(seller)}`} />
                            <div className="flex-1 text-left min-w-0">
                                <div className="truncate capitalize">{seller.name}</div>
                                {seller.phoneNumber && (
                                    <div className="text-xs text-slate-400 dark:text-slate-500 truncate">+{seller.phoneNumber}</div>
                                )}
                            </div>
                            {seller.connected ? (
                                <Wifi className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                            ) : (
                                <WifiOff className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 flex-shrink-0" />
                            )}
                        </button>
                    ))}

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
