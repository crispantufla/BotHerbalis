import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';
import { useOrders } from '../../hooks/useOrders';
import { useAuth } from '../../context/AuthContext';
import { useSeller } from '../../context/SellerContext';
import { capitalize } from '../../utils/format';

import { RefreshCw as Refresh, Download, Search, Filter, ChevronDown, MessageCircle as Chat, Edit2 as Edit, Trash2 as Trash, FileText as Script, Save, X as XIcon, Copy, Check } from 'lucide-react';

const SalesView = ({ onGoToChat, initialSearch = '' }) => {
    const { toast, confirm } = useToast();
    // Any admin (with or without home sellerId) sees the cross-seller filter
    // and can view orders from all sellers to supervise.
    const { isAdmin } = useAuth();
    const { sellers } = useSeller();
    const [page, setPage] = useState(1);

    // Custom Hook Data
    const { orders, pagination, isLoading, isFetching, updateDetails, updateStatus, deleteOrder, refetch } = useOrders(page, 50);

    // Advanced Filters V2
    const [searchTerm, setSearchTerm] = useState(initialSearch);
    const [statusFilter, setStatusFilter] = useState('Todos');
    const [sellerFilter, setSellerFilter] = useState('Todos');
    // Historical instanceIds present in Order table — includes "ghost" sellers
    // whose Account was hard-deleted but whose ventas se preservaron (denis).
    const [historicalSellerIds, setHistoricalSellerIds] = useState([]);

    useEffect(() => {
        if (!isAdmin) return;
        let cancelled = false;
        api.get('/api/orders/sellers')
            .then(({ data }) => { if (!cancelled) setHistoricalSellerIds(data?.instanceIds || []); })
            .catch(() => { /* fall back to current-page derivation */ });
        return () => { cancelled = true; };
    }, [isAdmin]);

    // Viewing / Details State
    const [viewingOrder, setViewingOrder] = useState(null);
    const [isDetailEditing, setIsDetailEditing] = useState(false);
    const [detailEditData, setDetailEditData] = useState({});
    const [savingDetails, setSavingDetails] = useState(false);

    // Editing State
    const [editingOrder, setEditingOrder] = useState(null);
    const [editStatus, setEditStatus] = useState('');
    const [editTracking, setEditTracking] = useState('');
    const [savingOrder, setSavingOrder] = useState(false);

    // Tracking State
    const [isTracking, setIsTracking] = useState(false);
    const [trackingData, setTrackingData] = useState(null);
    const [showOriginalAddress, setShowOriginalAddress] = useState(false);

    const startDetailEdit = (order) => {
        setDetailEditData({
            nombre: order.nombre || '',
            calle: order.calle || '',
            ciudad: order.ciudad || '',
            cp: order.cp || '',
            provincia: order.provincia || '',
            producto: order.producto || '',
            precio: order.precio || '0',
            tracking: order.tracking || '',
            postdatado: order.postdatado || ''
        });
        setIsDetailEditing(true);
    };

    const cancelDetailEdit = () => {
        setIsDetailEditing(false);
        setDetailEditData({});
    };

    const handleSaveOrderDetails = async () => {
        if (!viewingOrder) return;
        setSavingDetails(true);
        try {
            await updateDetails({ id: viewingOrder.id, data: detailEditData });
            setViewingOrder((prev) => ({ ...prev, ...detailEditData }));
            setIsDetailEditing(false);
            toast.success('Orden actualizada');
        } catch (err) {
            toast.error('Error al guardar: ' + err.message);
        } finally {
            setSavingDetails(false);
        }
    };

    const handleDetailField = (field, value) => {
        setDetailEditData(prev => ({ ...prev, [field]: value }));
    };

    // Tracking Request
    const handleTrackOrder = async (trackingCode) => {
        if (!trackingCode) return;
        setIsTracking(true);
        setTrackingData(null);
        try {
            const res = await api.get(`/api/orders/tracking/${trackingCode}`);
            setTrackingData(res.data);
        } catch (e) {
            toast.error("Error al consultar seguimiento.");
        } finally {
            setIsTracking(false);
        }
    };

    // Export CSV
    const handleExportCSV = () => {
        if (orders.length === 0) return;
        const headers = ['Fecha', 'Cliente', 'Nombre', 'Producto', 'Plan', 'Precio', 'Postdatado', 'Estado', 'Tracking', 'Ciudad', 'Calle', 'CP'];
        const rows = orders.map(o => [
            o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '',
            o.cliente || '', o.nombre || '', o.producto || '', o.plan || '', o.precio || '',
            o.postdatado || '', o.status || '', o.tracking || '', o.ciudad || '', o.calle || '', o.cp || ''
        ]);
        const csvContent = [headers.join(','), ...rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `pedidos_${new Date().toISOString().split('T')[0]}.csv`; a.click();
        URL.revokeObjectURL(url);
    };

    // Edit logic
    const openEdit = (order) => {
        setEditingOrder(order);
        setEditStatus(order.status || 'Pendiente');
        setEditTracking(order.tracking || '');
    };

    const handleSaveEdit = async () => {
        if (!editingOrder) return;
        setSavingOrder(true);
        try {
            await updateStatus({ id: editingOrder.id, status: editStatus, tracking: editTracking });
            toast.success("Pedido actualizado");
            setEditingOrder(null);
        } catch (e) { toast.error('Error al guardar'); }
        setSavingOrder(false);
    };

    const handleDeleteOrder = async () => {
        if (!editingOrder) return;
        const ok = await confirm(`¿Eliminar definitivamente el pedido de ${editingOrder.nombre}?`);
        if (!ok) return;
        try {
            await deleteOrder(editingOrder.id);
            setEditingOrder(null);
            toast.success('Pedido eliminado');
        } catch (e) { toast.error('Error eliminando pedido'); }
    };

    const handleGoToChat = async (clienteStr, sellerPhone) => {
        if (!clienteStr) {
            toast.warning('El pedido no tiene un teléfono asociado.');
            return;
        }

        const toastId = toast.info('Buscando chat...');
        try {
            // Check connected number
            const statusRes = await api.get('/api/status');
            const connectedPhoneInfo = statusRes.data?.info?.wid?.user;
            // Best effort fallback
            const connectedPhone = connectedPhoneInfo || (statusRes.data?.config?.alertNumber) || (statusRes.data?.config?.alertNumbers?.[0]);

            if (sellerPhone && connectedPhone) {
                const cleanedSeller = sellerPhone.replace(/\D/g, '');
                const cleanedConnected = connectedPhone.replace(/\D/g, '');
                // Allow matches if one ends with the other (e.g. 549341... vs 341...)
                if (!cleanedSeller.endsWith(cleanedConnected) && !cleanedConnected.endsWith(cleanedSeller)) {
                    toast.dismiss(toastId);
                    toast.warning('Esta venta se hizo desde otro \u00fanumero.');
                    return;
                }
            }

            const res = await api.get('/api/chats');
            const chats = res.data;
            const cleaned = clienteStr.replace(/\D/g, ''); // phone numbers only mode

            const chatExists = chats.find(c => {
                const cCleaned = String(c.id).replace(/\D/g, '');
                return c.id === clienteStr ||
                    c.id === `${clienteStr}@c.us` ||
                    c.id.includes(cleaned) ||
                    cCleaned.endsWith(cleaned) ||
                    cleaned.endsWith(cCleaned) ||
                    (c.name && c.name.includes(clienteStr));
            });

            if (chatExists) {
                if (onGoToChat) onGoToChat(chatExists.id);
                toast.dismiss(toastId);
            } else {
                // If it doesn't exist in recent chats, but we know it belongs to us, we can force-go to the ID
                if (onGoToChat) onGoToChat(`${cleaned}@c.us`);
                toast.dismiss(toastId);
            }
        } catch (e) {
            toast.dismiss(toastId);
            toast.error('Error de conexión al verificar chats activos.');
        }
    };

    const handleCopySaleDetails = (order) => {
        const rawPhone = order.cliente ? order.cliente.split('@')[0] : '';
        const phoneDisplay = rawPhone.length > 13 ? `Oculto por Anuncio Meta (${rawPhone})` : rawPhone || 'Desconocido';

        const payLabel = order.paymentMethod === 'mercadopago' ? 'MercadoPago' : order.paymentMethod === 'transferencia' ? 'Transferencia' : 'Contra reembolso';
        const textToCopy = `Nombre: ${order.nombre || 'Cliente'}
Teléfono: ${phoneDisplay}
Producto: ${order.producto}
Total: $${order.precio}
Pago: ${payLabel}
Dirección: ${order.calle || '—'}
Ciudad: ${order.ciudad || '—'}
Provincia: ${order.provincia || '—'}
CP: ${order.cp || '—'}`;

        navigator.clipboard.writeText(textToCopy)
            .then(() => toast.success('Venta copiada al portapapeles'))
            .catch(() => toast.error('Error al copiar venta'));
    };

    // Styling Maps
    const statusOptions = ['Pendiente', 'Confirmado', 'En sistema', 'Enviado', 'Entregado', 'Cancelado'];
    const statusStyles = {
        'Pendiente': 'bg-amber-100/80 text-amber-700 border-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.2)]',
        'Confirmado': 'bg-sky-100/80 text-sky-700 border-sky-300 shadow-[0_0_10px_rgba(14,165,233,0.2)]',
        'En sistema': 'bg-fuchsia-100/80 text-fuchsia-700 border-fuchsia-300 shadow-[0_0_10px_rgba(217,70,239,0.2)]',
        'Enviado': 'bg-purple-100/80 text-purple-700 border-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.2)]',
        'Entregado': 'bg-emerald-100/80 text-emerald-700 border-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]',
        'Cancelado': 'bg-rose-100/80 text-rose-700 border-rose-300 shadow-[0_0_10px_rgba(244,63,94,0.2)]'
    };

    // Filters logic
    // Admin: filter by seller account (instanceId → name). Seller: filter by phone number (order.seller).
    // Para que las ventas históricas de cuentas borradas (e.g. denis post-hard-delete)
    // sigan filtrables, mergeamos sellers actuales + instanceIds presentes en Order.
    const sellerIdToName = Object.fromEntries((sellers || []).map(s => [s.sellerId, capitalize(s.name)]));

    const uniqueFilterOptions = isAdmin
        ? (() => {
            const fromAccounts = (sellers || []).map(s => s.sellerId).filter(Boolean);
            const merged = new Set([...fromAccounts, ...historicalSellerIds]);
            return Array.from(merged);
        })()
        : Array.from(new Set(orders.map(o => o.seller).filter(Boolean)));

    // Label fallback: si el instanceId no tiene Account (ghost), uso el id capitalizado.
    const labelForSeller = (sid) => sellerIdToName[sid] || capitalize(sid || '');

    const filteredOrders = orders.filter(order => {
        const matchesSearch = searchTerm === '' ||
            (order.nombre || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
            (order.cliente || '').includes(searchTerm) ||
            (order.tracking || '').toLowerCase().includes(searchTerm.toLowerCase());

        const matchesStatus = statusFilter === 'Todos' || (order.status || 'Pendiente') === statusFilter;

        const matchesSeller = sellerFilter === 'Todos'
            || (isAdmin ? order.instanceId === sellerFilter : order.seller === sellerFilter);

        return matchesSearch && matchesStatus && matchesSeller;
    });

    // Timezone & Date Formatter
    const formatDateBA = (dateStr) => {
        if (!dateStr) return '—';
        try {
            // Handle DB legacy strings like "22/02/2026, 17:30" or ISO
            let d = new Date(dateStr);
            if (isNaN(d.getTime()) && dateStr.includes('/')) {
                // Try strictly parsing DD/MM/YYYY
                const parts = dateStr.split(/[^\d]/);
                if (parts.length >= 3) {
                    d = new Date(parts[2], parts[1] - 1, parts[0], parts[3] || 0, parts[4] || 0, parts[5] || 0);
                }
            }
            if (isNaN(d.getTime())) return 'Invalid Date';

            return d.toLocaleString('es-AR', {
                timeZone: 'America/Argentina/Buenos_Aires',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });
        } catch (e) {
            return dateStr;
        }
    };

    return (
        <div className="h-full flex flex-col animate-fade-in relative z-10 w-full space-y-2 sm:space-y-6">

            {/* V2 Header & Advanced Filters */}
            <div className="bg-white/4 dark:bg-slate-800/40 backdrop-blur-xl rounded-[1.5rem] sm:rounded-[2rem] border border-white/6 dark:border-slate-700/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] p-2.5 sm:p-5 lg:p-6">
                <div className="flex flex-row justify-between items-center gap-2 mb-2 sm:mb-5">
                    <div className="min-w-0">
                        <h1 className="text-lg sm:text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600 tracking-tight truncate">
                            Logística y Pedidos
                        </h1>
                        <p className="hidden sm:block text-slate-500 mt-2 text-sm sm:text-base font-medium">Gestión inteligente de estados y envíos en tiempo real.</p>
                    </div>

                    <div className="flex gap-2 flex-shrink-0">
                        <button onClick={() => refetch()} className="p-2 sm:p-3 bg-white border border-slate-200 rounded-xl text-slate-600 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all shadow-sm active:scale-95 group">
                            <span className={`group-hover:rotate-180 transition-transform duration-500 block ${isFetching ? 'animate-spin text-indigo-500' : ''}`}><Refresh className="w-4 h-4" /></span>
                        </button>
                        <button onClick={handleExportCSV} disabled={orders.length === 0} className="px-3 sm:px-6 py-2 sm:py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-105 transition-all flex items-center gap-2 disabled:opacity-50 disabled:scale-100">
                            <Download className="w-4 h-4" />
                            <span className="hidden sm:inline">Exportar CSV</span>
                        </button>
                    </div>
                </div>

                {/* Filters Bar V2 */}
                <div className="flex flex-col lg:flex-row gap-2 sm:gap-4">
                    <div className="flex-1 relative group">
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Buscar por cliente, teléfono o tracking..."
                            className="w-full bg-white/8 dark:bg-slate-800/80 border border-white rounded-xl pl-10 sm:pl-12 pr-4 py-2 sm:py-3.5 text-sm font-medium focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all text-slate-700 shadow-inner placeholder:text-slate-400"
                        />
                        <span className="absolute left-3 sm:left-4 top-2 sm:top-3.5 text-slate-400 group-focus-within:text-indigo-500 transition-colors"><Search className="w-4 h-4 sm:w-5 sm:h-5" /></span>
                    </div>

                    {/* Estado filter — single styled select for all viewports (no overflow) */}
                    <div className="relative sm:w-56 flex-shrink-0">
                        <Filter className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 w-4 h-4 sm:w-5 sm:h-5 text-slate-400 pointer-events-none" />
                        <select
                            value={statusFilter}
                            onChange={e => setStatusFilter(e.target.value)}
                            className="w-full appearance-none bg-white/8 dark:bg-slate-800/80 border border-white dark:border-slate-700 rounded-xl pl-10 sm:pl-12 pr-9 py-2 sm:py-3.5 text-sm font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all shadow-inner cursor-pointer"
                        >
                            {['Todos', ...statusOptions].map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                    </div>

                    {/* Vendedor (admin) / Número (seller) filter — single styled select */}
                    {(isAdmin || uniqueFilterOptions.length > 1) && (
                        <div className="relative sm:w-56 flex-shrink-0">
                            <span className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 text-[10px] font-black uppercase tracking-widest text-slate-400 pointer-events-none">
                                {isAdmin ? 'Vend.' : 'Núm.'}
                            </span>
                            <select
                                value={sellerFilter}
                                onChange={e => setSellerFilter(e.target.value)}
                                className="w-full appearance-none bg-white/8 dark:bg-slate-800/80 border border-white dark:border-slate-700 rounded-xl pl-14 sm:pl-16 pr-9 py-2 sm:py-3.5 text-sm font-semibold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-4 focus:ring-blue-500/20 focus:border-blue-400 transition-all shadow-inner cursor-pointer"
                            >
                                <option value="Todos">Todos</option>
                                {uniqueFilterOptions.map(opt => (
                                    <option key={opt} value={opt}>
                                        {isAdmin ? labelForSeller(opt) : `+${opt.replace(/\D/g, '')}`}
                                    </option>
                                ))}
                            </select>
                            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                        </div>
                    )}
                </div>
            </div>

            {/* V2 Glassmorphism Table */}
            <div className="flex-1 bg-white/6 dark:bg-slate-800/60 backdrop-blur-xl rounded-[1.25rem] sm:rounded-[2rem] border border-white/8 dark:border-slate-700/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden flex flex-col relative text-sm">

                {/* Background Glow */}
                <div className="absolute -bottom-32 -left-32 w-96 h-96 bg-purple-400/10 blur-[100px] rounded-full pointer-events-none"></div>

                <div className="overflow-auto custom-scrollbar flex-1 relative z-10">
                    {/* PC & Tablet Table View */}
                    <table className="w-full text-left border-collapse whitespace-nowrap hidden md:table">
                        <thead className="bg-white/4 dark:bg-slate-800/40 border-b border-white/6 dark:border-slate-700/60 sticky top-0 z-20 backdrop-blur-md">
                            <tr className="text-xs uppercase tracking-widest text-slate-500 font-extrabold">
                                <th className="px-4 sm:px-8 py-5 hidden md:table-cell">Fecha</th>
                                <th className="px-4 sm:px-8 py-5 w-full">Cliente</th>
                                <th className="px-4 sm:px-8 py-5 whitespace-nowrap">Teléfono</th>
                                <th className="px-4 sm:px-8 py-5 text-center">Vendedor</th>
                                <th className="px-4 sm:px-8 py-5 text-center">Estado</th>
                                <th className="px-4 sm:px-8 py-5 text-right w-10">Acciones</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200/50">
                            {isLoading ? (
                                Array.from({ length: 5 }).map((_, i) => (
                                    <tr key={`skel-${i}`} className="animate-pulse">
                                        <td className="px-4 py-5 hidden md:table-cell"><div className="h-4 bg-slate-200 dark:bg-slate-700/50 rounded w-16"></div></td>
                                        <td className="px-4 py-5"><div className="flex gap-3 items-center"><div className="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-700/50"></div><div className="h-4 bg-slate-200 dark:bg-slate-700/50 rounded w-24"></div></div></td>
                                        <td className="px-4 py-5 text-center"><div className="h-4 bg-slate-200 dark:bg-slate-700/50 rounded w-20"></div></td>
                                        <td className="px-4 py-5 text-center"><div className="h-4 bg-slate-200 dark:bg-slate-700/50 rounded w-16 mx-auto"></div></td>
                                        <td className="px-4 py-5 text-center"><div className="h-6 bg-slate-200 dark:bg-slate-700/50 rounded-full w-20 mx-auto"></div></td>
                                        <td className="px-4 py-5"><div className="flex gap-2 justify-end"><div className="w-10 h-10 rounded-xl bg-slate-200 dark:bg-slate-700/50"></div></div></td>
                                    </tr>
                                ))
                            ) : filteredOrders.length === 0 ? (
                                <tr><td colSpan="5" className="text-center py-20">
                                    <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4 border-2 border-dashed border-slate-300">
                                        <Search className="w-5 h-5" />
                                    </div>
                                    <p className="text-slate-500 font-bold text-lg">No se encontraron pedidos</p>
                                    <p className="text-slate-400 text-sm mt-1">Intentá ajustar los filtros de búsqueda.</p>
                                </td></tr>
                            ) : (
                                filteredOrders.map(order => (
                                    <tr key={order.id} className="hover:bg-white/5 dark:bg-slate-800/50 transition-colors group">
                                        <td className="px-4 py-5 hidden md:table-cell w-32">
                                            {(() => {
                                                const dt = formatDateBA(order.createdAt);
                                                if (typeof dt === 'string' && dt.includes(',')) {
                                                    const [datePart, timePart] = dt.split(',');
                                                    return (
                                                        <div className="flex flex-col whitespace-nowrap">
                                                            <span className="font-sans text-[13px] font-extrabold text-slate-700">{datePart.trim()}</span>
                                                            <span className="font-mono text-xs font-bold text-indigo-400 tracking-wider mt-0.5">{timePart.trim()}</span>
                                                        </div>
                                                    );
                                                }
                                                return <span className="font-sans text-[13px] font-extrabold text-slate-700">{dt}</span>;
                                            })()}
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 w-full min-w-[200px] sm:max-w-md truncate">
                                            <button onClick={() => { setViewingOrder(order); setTrackingData(null); }} className="text-left group/click focus:outline-none flex items-center gap-3 w-full">
                                                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-50 to-purple-50 flex items-center justify-center text-indigo-600 font-extrabold text-[13px] shrink-0 border border-indigo-100/80 shadow-sm hidden sm:flex">
                                                    {order.nombre ? order.nombre.substring(0, 2).toUpperCase() : '??'}
                                                </div>
                                                <div className="flex flex-col truncate">
                                                    <p className="font-extrabold text-[14px] text-slate-800 group-hover/click:text-indigo-600 transition-colors truncate">
                                                        {order.nombre || 'Desconocido'}
                                                    </p>
                                                </div>
                                            </button>
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 whitespace-nowrap">
                                            <p className="text-[12px] text-slate-500 font-mono flex items-center gap-2 opacity-90 hover:opacity-100 transition-opacity">
                                                <svg className="w-4 h-4 text-emerald-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                                                {order.cliente ? '+' + order.cliente.split('@')[0].replace(/\D/g, '') : '—'}
                                            </p>
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 text-center">
                                            {order.instanceId || order.seller ? (
                                                <div className="flex flex-col items-center gap-0.5">
                                                    {order.instanceId && (
                                                        <span className="text-[11px] font-extrabold text-slate-700 capitalize">
                                                            {labelForSeller(order.instanceId)}
                                                        </span>
                                                    )}
                                                    {order.seller && (
                                                        <span className="text-[9px] text-blue-500 font-mono">
                                                            (+{order.seller.replace(/\D/g, '').slice(-10)})
                                                        </span>
                                                    )}
                                                </div>
                                            ) : (
                                                <span className="text-[10px] text-slate-400 font-medium">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 text-center">
                                            <span className={`px-3 py-1 rounded-full text-xs font-extrabold uppercase tracking-widest border ${statusStyles[order.status] || statusStyles['Pendiente']}`}>
                                                {order.status || 'Pendiente'}
                                            </span>
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 text-right">
                                            <div className="flex justify-end gap-3 transition-opacity">
                                                <button onClick={(e) => { e.stopPropagation(); handleGoToChat(order.cliente, order.seller); }} className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 hover:bg-emerald-500 hover:text-white transition-all flex items-center justify-center shadow-sm" title="Ir al Chat">
                                                    <Chat className="w-4 h-4" />
                                                </button>
                                                <button onClick={() => openEdit(order)} className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 hover:bg-indigo-500 hover:text-white transition-all flex items-center justify-center shadow-sm" title="Editar Pedido">
                                                    <Edit className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>

                    {/* Mobile Cards View (sm and below) */}
                    <div className="md:hidden flex flex-col gap-2 p-3">
                        {isLoading ? (
                            Array.from({ length: 3 }).map((_, i) => (
                                <div key={`skel-m-${i}`} className="p-5 rounded-[1.5rem] bg-slate-100/50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 animate-pulse h-32"></div>
                            ))
                        ) : filteredOrders.length === 0 ? (
                            <div className="text-center py-10">
                                <div className="w-16 h-16 bg-white/6 dark:bg-slate-800/60 rounded-full flex items-center justify-center mx-auto mb-3 shadow-sm border border-white">
                                    <Search className="w-5 h-5" />
                                </div>
                                <p className="text-slate-500 font-bold text-[15px]">No se encontraron pedidos</p>
                            </div>
                        ) : (
                            filteredOrders.map(order => (
                                <div key={order.id} className="bg-white/8 dark:bg-slate-800/80 backdrop-blur-md border border-white rounded-[1.25rem] shadow-sm p-3 flex flex-col gap-2.5 relative overflow-hidden flex-shrink-0 animate-fade-in transition-all active:scale-[0.98]">
                                    <div className="flex justify-between items-center gap-2 w-full">
                                        <div className="flex items-center gap-2 min-w-0 flex-1">
                                            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-50 to-purple-100 flex items-center justify-center text-indigo-600 font-extrabold text-[13px] shrink-0 border border-white shadow-sm">
                                                {order.nombre ? order.nombre.substring(0, 2).toUpperCase() : '??'}
                                            </div>
                                            <div className="flex flex-col min-w-0 truncate">
                                                <p className="font-black text-[13px] text-slate-800 tracking-tight leading-tight truncate">{order.nombre || 'Desconocido'}</p>
                                                <p className="text-[11px] text-slate-500 font-mono flex items-center gap-1 opacity-90 truncate">
                                                    <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                                                    {order.cliente ? '+' + order.cliente.split('@')[0].replace(/\D/g, '') : '—'}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex flex-col items-end gap-1 shrink-0">
                                            <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase tracking-widest border shadow-sm ${statusStyles[order.status] || statusStyles['Pendiente']}`}>
                                                {order.status || 'Pendiente'}
                                            </span>
                                            {(() => {
                                                const dt = formatDateBA(order.createdAt);
                                                if (typeof dt === 'string' && dt.includes(',')) {
                                                    const [datePart] = dt.split(',');
                                                    return <div className="flex flex-col items-end gap-1">
                                                        <span className="font-extrabold text-[10px] text-slate-400 bg-slate-50 px-2 py-0.5 rounded border border-slate-100">{datePart.trim()}</span>
                                                        {(order.instanceId || order.seller) && (
                                                            <span className="font-bold text-[9px] text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">
                                                                {order.instanceId ? labelForSeller(order.instanceId) : ''}{order.seller ? ` (+${order.seller.replace(/\D/g, '').slice(-10)})` : ''}
                                                            </span>
                                                        )}
                                                    </div>;
                                                }
                                                return <div className="flex flex-col items-end gap-1">
                                                    <span className="font-extrabold text-[10px] text-slate-400 bg-slate-50 px-2 py-0.5 rounded border border-slate-100">{dt}</span>
                                                    {(order.instanceId || order.seller) && (
                                                        <span className="font-bold text-[9px] text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">
                                                            {order.instanceId ? labelForSeller(order.instanceId) : ''}{order.seller ? ` (+${order.seller.replace(/\D/g, '').slice(-10)})` : ''}
                                                        </span>
                                                    )}
                                                </div>;
                                            })()}
                                        </div>
                                    </div>

                                    <div className="flex gap-1.5">
                                        <button onClick={() => { setViewingOrder(order); setTrackingData(null); }} className="flex-1 bg-white border border-slate-200 text-indigo-600 rounded-xl py-2 text-[10px] font-extrabold uppercase tracking-widest flex items-center justify-center gap-1 shadow-sm active:bg-indigo-50 transition-colors">
                                            <Script className="w-3 h-3" /> Detalles
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); handleGoToChat(order.cliente, order.seller); }} className="w-10 h-9 bg-emerald-50 border border-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center shadow-sm active:bg-emerald-100 transition-colors">
                                            <Chat className="w-3.5 h-3.5" />
                                        </button>
                                        <button onClick={() => openEdit(order)} className="w-10 h-9 bg-indigo-50 border border-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center shadow-sm active:bg-indigo-100 transition-colors">
                                            <Edit className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                </div>

                {/* V2 Pagination Controls */}
                <div className="px-3 sm:px-8 py-2 sm:py-4 border-t border-white/6 dark:border-slate-700/60 flex flex-row justify-between items-center bg-white/3 dark:bg-slate-800/30 backdrop-blur-md gap-2">
                    <span className="text-[10px] sm:text-sm font-bold text-slate-500 uppercase tracking-wider sm:tracking-widest whitespace-nowrap">
                        <span className="text-indigo-600">{page}</span>/{pagination.totalPages}
                        <span className="hidden sm:inline"> Página</span>
                    </span>
                    <div className="flex gap-1.5 sm:gap-2">
                        <button
                            disabled={page <= 1 || isFetching}
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                            className="px-2.5 sm:px-4 py-1.5 sm:py-2 bg-white/8 dark:bg-slate-800/80 rounded-lg sm:rounded-xl border border-white shadow-sm text-[10px] sm:text-xs font-extrabold text-slate-600 disabled:opacity-50 hover:bg-white hover:text-indigo-600 transition-all active:-translate-y-0.5"
                        >
                            Ant.
                        </button>
                        <button
                            disabled={page >= pagination.totalPages || isFetching}
                            onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                            className="px-2.5 sm:px-4 py-1.5 sm:py-2 bg-white/8 dark:bg-slate-800/80 rounded-lg sm:rounded-xl border border-white shadow-sm text-[10px] sm:text-xs font-extrabold text-slate-600 disabled:opacity-50 hover:bg-white hover:text-indigo-600 transition-all active:-translate-y-0.5"
                        >
                            Sig.
                        </button>
                    </div>
                    <span className="text-[10px] sm:text-sm font-bold text-indigo-500 bg-indigo-50 px-2 sm:px-3 py-0.5 sm:py-1 rounded-full border border-indigo-100 whitespace-nowrap">{pagination.total} <span className="hidden sm:inline">Totales en BD</span><span className="sm:hidden">total</span></span>
                </div>
            </div>

            {/* V2 GLASSMORPHISM EDIT MODAL */}
            {editingOrder && createPortal(
                <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md z-[100] flex items-center justify-center animate-fade-in p-4">
                    <div className="bg-white/95 dark:bg-slate-800/95 backdrop-blur-2xl rounded-[2rem] shadow-2xl w-full max-w-md p-8 border border-white dark:border-slate-700 relative overflow-hidden">

                        <div className="absolute top-0 right-0 w-40 h-40 bg-indigo-500/10 blur-[50px] rounded-full pointer-events-none"></div>

                        <div className="flex justify-between items-center mb-8 relative z-10">
                            <div>
                                <h3 className="text-2xl font-extrabold text-slate-800 tracking-tight">Editar Estado</h3>
                                <p className="text-xs font-bold text-indigo-600 uppercase tracking-widest mt-1">Order #{editingOrder.id?.substring(0, 6) || 'N/A'}</p>
                            </div>
                            <button onClick={() => setEditingOrder(null)} className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 hover:text-slate-800 dark:hover:text-white transition-colors flex items-center justify-center">✕</button>
                        </div>

                        <div className="space-y-6 relative z-10">
                            <div className="bg-gradient-to-br from-slate-50 to-blue-50/50 dark:from-slate-700/50 dark:to-slate-700/30 rounded-2xl p-5 border border-slate-200/60 dark:border-slate-600/50 shadow-inner">
                                <p className="text-lg font-extrabold text-slate-800 dark:text-slate-100 mb-1">{editingOrder.nombre || 'Sin nombre'}</p>
                                <p className="text-sm font-mono text-slate-500 dark:text-slate-400 mb-3">{editingOrder.cliente}</p>
                                <div className="flex items-center gap-2">
                                    <span className="px-2.5 py-1 rounded-lg bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 text-xs font-bold">{editingOrder.producto}</span>
                                    <span className="text-sm font-extrabold text-slate-800 dark:text-slate-100 ml-auto">${editingOrder.precio}</span>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-extrabold text-slate-500 uppercase tracking-widest mb-2 ml-1">Estado del Pedido</label>
                                <div className="relative">
                                    <select
                                        value={editStatus}
                                        onChange={(e) => setEditStatus(e.target.value)}
                                        className="w-full appearance-none bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl px-5 py-4 text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all shadow-sm cursor-pointer"
                                    >
                                        {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                    <div className="absolute inset-y-0 right-0 flex items-center px-5 pointer-events-none text-slate-400">
                                        <Filter className="w-5 h-5" />
                                    </div>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-extrabold text-slate-500 uppercase tracking-widest mb-2 ml-1">Código de Seguimiento</label>
                                <input
                                    type="text"
                                    value={editTracking}
                                    onChange={(e) => setEditTracking(e.target.value)}
                                    placeholder="Ej: CP123456789AR"
                                    className="w-full bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl px-5 py-4 text-sm font-mono font-bold text-slate-700 dark:text-slate-200 focus:ring-4 focus:ring-blue-500/20 focus:border-blue-400 outline-none transition-all shadow-sm placeholder:text-slate-300 dark:placeholder:text-slate-500"
                                />
                            </div>
                        </div>

                        <div className="mt-8 space-y-3 relative z-10">
                            <div className="flex gap-3">
                                <button onClick={() => setEditingOrder(null)} className="flex-1 py-4 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-xl text-sm font-bold hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors shadow-sm">
                                    Cancelar
                                </button>
                                <button onClick={handleSaveEdit} disabled={savingOrder} className="flex-1 py-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-[1.02] transition-all disabled:opacity-50 disabled:scale-100">
                                    {savingOrder ? 'Guardando...' : 'Aplicar Cambios'}
                                </button>
                            </div>

                            <button onClick={handleDeleteOrder} className="w-full py-4 bg-transparent border-2 border-rose-100 text-rose-500 rounded-xl text-xs font-extrabold uppercase tracking-widest hover:bg-rose-50 hover:border-rose-200 transition-all flex items-center justify-center gap-2 mt-4">
                                <Trash className="w-4 h-4" />
                                Eliminar Registro
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {/* V3 DATA-FIRST TICKET MODAL */}
            {viewingOrder && createPortal(
                <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md z-[100] flex items-center justify-center animate-fade-in p-0 sm:p-4" onClick={() => { setViewingOrder(null); cancelDetailEdit(); }}>
                    <div className="bg-white dark:bg-slate-900 rounded-none sm:rounded-2xl shadow-2xl w-full h-full sm:h-auto max-w-xl overflow-hidden flex flex-col sm:max-h-[90vh] border border-slate-200 dark:border-slate-700" onClick={e => e.stopPropagation()}>

                        {/* Header — compact */}
                        <div className="px-5 py-4 flex justify-between items-center border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 shrink-0">
                            <div className="flex items-center gap-3">
                                <span className={`px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider border ${statusStyles[viewingOrder.status] || statusStyles['Pendiente']}`}>
                                    {viewingOrder.status || 'Pendiente'}
                                </span>
                                <span className={`px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider border ${
                                    viewingOrder.paymentMethod === 'mercadopago' ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800/50'
                                    : viewingOrder.paymentMethod === 'transferencia' ? 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-800/50'
                                    : 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800/50'
                                }`}>
                                    {viewingOrder.paymentMethod === 'mercadopago' ? '💳 MP' : viewingOrder.paymentMethod === 'transferencia' ? '🏦 Transf.' : '💵 C/R'}
                                </span>
                                {viewingOrder.postdatado && String(viewingOrder.postdatado).trim() !== '' && String(viewingOrder.postdatado).toLowerCase() !== 'no' && String(viewingOrder.postdatado).toLowerCase() !== 'false' && (
                                    <span className="px-3 py-1.5 rounded-lg text-[11px] font-black uppercase tracking-wider border bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/50 flex items-center gap-1">
                                        <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></div>
                                        {viewingOrder.postdatado}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-1.5">
                                {!isDetailEditing ? (
                                    <button onClick={() => startDetailEdit(viewingOrder)} className="w-8 h-8 rounded-lg bg-white dark:bg-slate-700 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all flex items-center justify-center border border-slate-200 dark:border-slate-600" title="Editar">
                                        <Edit className="w-3.5 h-3.5" />
                                    </button>
                                ) : (
                                    <button onClick={cancelDetailEdit} className="w-8 h-8 rounded-lg bg-rose-50 dark:bg-rose-900/30 text-rose-500 hover:text-rose-700 transition-all flex items-center justify-center border border-rose-200 dark:border-rose-800/50" title="Cancelar edición">
                                        <XIcon className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                <button onClick={() => { setViewingOrder(null); cancelDetailEdit(); }} className="w-8 h-8 rounded-lg bg-white dark:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-all flex items-center justify-center border border-slate-200 dark:border-slate-600">
                                    <XIcon className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>

                        {/* Content — data rows */}
                        <div className="overflow-y-auto custom-scrollbar flex-1 bg-white dark:bg-slate-900">
                            {/* Data field rows — each clickable to copy */}
                            {(() => {
                                const CopyRow = ({ label, value, editField, mono }) => {
                                    const [copied, setCopied] = React.useState(false);
                                    const handleCopy = () => {
                                        if (!value || isDetailEditing) return;
                                        navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
                                    };
                                    return (
                                        <div
                                            onClick={handleCopy}
                                            className={`flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-slate-800 ${!isDetailEditing ? 'hover:bg-indigo-50/50 dark:hover:bg-indigo-900/10 cursor-pointer' : ''} transition-colors group`}
                                        >
                                            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 w-24 sm:w-28 shrink-0">{label}</span>
                                            <div className="flex-1 min-w-0 ml-3">
                                                {isDetailEditing && editField ? (
                                                    editField
                                                ) : (
                                                    <span className={`text-sm font-semibold text-slate-800 dark:text-slate-100 block truncate ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
                                                )}
                                            </div>
                                            {!isDetailEditing && (
                                                <span className="ml-2 shrink-0">
                                                    {copied
                                                        ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                                                        : <Copy className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                                                    }
                                                </span>
                                            )}
                                        </div>
                                    );
                                };
                                const editInput = (field, placeholder, extraClass = '') => (
                                    <input type="text" value={detailEditData[field] || ''} onChange={e => handleDetailField(field, e.target.value)} className={`w-full text-sm font-semibold text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-700 rounded-lg px-3 py-1.5 border border-slate-200 dark:border-slate-600 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900/50 outline-none ${extraClass}`} placeholder={placeholder} />
                                );
                                const rawPhone = viewingOrder.cliente ? viewingOrder.cliente.split('@')[0] : '';
                                const phoneDisplay = rawPhone.length > 13 ? `Oculto (${rawPhone.slice(-6)})` : rawPhone;
                                const addressDisplay = showOriginalAddress && viewingOrder.calleOriginal ? viewingOrder.calleOriginal : (viewingOrder.calle || '');
                                const locationParts = [viewingOrder.ciudad, viewingOrder.provincia].filter(Boolean).join(', ');

                                return (
                                    <>
                                        <CopyRow label="Nombre" value={viewingOrder.nombre || 'Sin nombre'} editField={editInput('nombre', 'Nombre completo')} />
                                        <CopyRow label="Teléfono" value={phoneDisplay} mono />
                                        <CopyRow label="Producto" value={viewingOrder.producto || 'Sin producto'} editField={editInput('producto', 'Producto')} />
                                        <CopyRow label="Total" value={`$${viewingOrder.precio}`} editField={editInput('precio', 'Precio')} />
                                        <CopyRow label="Dirección" value={addressDisplay || 'Sin domicilio'} editField={editInput('calle', 'Calle y número')} />
                                        <CopyRow label="Ciudad" value={viewingOrder.ciudad || '—'} editField={editInput('ciudad', 'Ciudad')} />
                                        <CopyRow label="Provincia" value={viewingOrder.provincia || '—'} editField={editInput('provincia', 'Provincia')} />
                                        <CopyRow label="C.P." value={viewingOrder.cp || '—'} editField={editInput('cp', 'Código postal')} mono />
                                        <CopyRow label="Fecha" value={formatDateBA(viewingOrder.createdAt)} />
                                        {viewingOrder.tracking && <CopyRow label="Tracking" value={viewingOrder.tracking} mono />}
                                    </>
                                );
                            })()}

                            {/* Original address toggle */}
                            {!isDetailEditing && viewingOrder.calleOriginal && viewingOrder.calleOriginal !== viewingOrder.calle && (
                                <div className="px-5 py-2 border-b border-slate-100 dark:border-slate-800">
                                    <button
                                        onClick={() => setShowOriginalAddress(!showOriginalAddress)}
                                        className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md border transition-all ${
                                            showOriginalAddress
                                                ? 'bg-amber-50 text-amber-600 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800/50'
                                                : 'bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800/50'
                                        }`}
                                    >
                                        {showOriginalAddress ? '📍 Ver Maps' : '✏️ Ver Original'}
                                    </button>
                                </div>
                            )}

                            {/* Tracking timeline — only if tracking exists and has been queried */}
                            {viewingOrder.tracking && (
                                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                                    <div className="flex justify-between items-center mb-3">
                                        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Seguimiento</span>
                                        <button onClick={() => handleTrackOrder(viewingOrder.tracking)} disabled={isTracking} className="text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-50 transition-colors">
                                            {isTracking ? 'Consultando...' : 'Rastrear'}
                                        </button>
                                    </div>
                                    {trackingData && (
                                        <div className="animate-fade-in">
                                            {trackingData.success ? (
                                                trackingData.events && trackingData.events.length > 0 ? (
                                                    <div className="space-y-3">
                                                        {trackingData.events.map((ev, i) => (
                                                            <div key={i} className="flex gap-3 items-start relative pb-3 border-l-2 border-indigo-100 dark:border-indigo-900/50 last:border-0 last:pb-0 ml-1.5">
                                                                <div className="absolute -left-[4px] top-1 w-1.5 h-1.5 rounded-full bg-indigo-400 ring-2 ring-white dark:ring-slate-900"></div>
                                                                <div className="pl-3 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 w-full">
                                                                    <div className="min-w-[100px]">
                                                                        <span className="font-bold text-slate-700 dark:text-slate-200 text-xs">{ev.fecha}</span>
                                                                        <span className="text-blue-500 font-bold uppercase text-[9px] tracking-wider ml-1">{ev.planta}</span>
                                                                    </div>
                                                                    <p className="text-slate-600 dark:text-slate-300 text-xs flex-1">{ev.historia}</p>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <p className="text-slate-400 dark:text-slate-500 text-xs">Sin movimientos recientes.</p>
                                                )
                                            ) : (
                                                <p className="text-rose-500 dark:text-rose-400 text-xs font-medium">{trackingData.error || 'Sin información.'}</p>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Status history */}
                            {viewingOrder.logs && viewingOrder.logs.length > 0 && (
                                <div className="px-5 py-4">
                                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-3 block">Historial</span>
                                    <div className="space-y-3">
                                        {[...viewingOrder.logs].reverse().map((log, idx) => (
                                            <div key={idx} className="flex gap-3 items-start relative pb-3 border-l-2 border-indigo-100 dark:border-indigo-900/50 last:border-0 last:pb-0 ml-1.5">
                                                <div className="absolute -left-[5px] top-0 w-2.5 h-2.5 rounded-full bg-white dark:bg-slate-900 border-[3px] border-indigo-500 z-10"></div>
                                                <div className="pl-4 flex-1">
                                                    <div className="flex justify-between items-center mb-0.5">
                                                        <span className="font-bold text-slate-700 dark:text-slate-200 text-xs">{log.status}</span>
                                                        <span className="text-slate-400 dark:text-slate-500 text-[10px] font-medium">{formatDateBA(log.timestamp)}</span>
                                                    </div>
                                                    <p className="text-slate-500 dark:text-slate-400 text-xs">{log.message}</p>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {viewingOrder.status === 'Cancelado' && (
                                <div className="mx-5 mb-4 bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 font-bold text-xs p-3 rounded-xl text-center border border-rose-100 dark:border-rose-800/50">
                                    Pedido cancelado
                                </div>
                            )}
                        </div>

                        {/* Footer — compact */}
                        <div className="px-5 py-3 flex justify-end gap-2 shrink-0 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                            {isDetailEditing ? (
                                <>
                                    <button onClick={cancelDetailEdit} className="flex items-center gap-1.5 px-4 py-2 bg-white dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 border border-slate-200 dark:border-slate-600 font-bold text-xs rounded-lg transition-all">
                                        Cancelar
                                    </button>
                                    <button onClick={handleSaveOrderDetails} disabled={savingDetails} className="flex items-center gap-1.5 px-5 py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50">
                                        <Save className="w-3.5 h-3.5" /> {savingDetails ? 'Guardando...' : 'Guardar'}
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button onClick={() => handleCopySaleDetails(viewingOrder)} className="flex items-center gap-1.5 px-4 py-2 bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 border border-slate-200 dark:border-slate-600 hover:border-indigo-200 dark:hover:border-indigo-800/50 font-bold text-xs rounded-lg transition-all">
                                        <Copy className="w-3.5 h-3.5" /> Copiar todo
                                    </button>
                                    <button onClick={() => { setViewingOrder(null); cancelDetailEdit(); }} className="px-5 py-2 bg-slate-800 dark:bg-slate-700 text-white rounded-lg text-xs font-bold hover:bg-black dark:hover:bg-slate-600 transition-all active:scale-95">
                                        Cerrar
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};

export default SalesView;
