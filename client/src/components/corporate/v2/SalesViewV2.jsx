import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import api from '../../../config/axios';
import { useToast } from '../../ui/Toast';
import { useOrders } from '../../../hooks/useOrders';

import { RefreshCw as Refresh, Download, Search, Filter, MessageCircle as Chat, Edit2 as Edit, Trash2 as Trash, FileText as Script, Save, X as XIcon } from 'lucide-react';

const SalesViewV2 = ({ onGoToChat }) => {
    const { toast, confirm } = useToast();
    const [page, setPage] = useState(1);

    // Custom Hook Data
    const { orders, pagination, isLoading, isFetching, updateDetails, updateStatus, deleteOrder, refetch } = useOrders(page, 50);

    // Advanced Filters V2
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('Todos');

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

        const textToCopy = `Nombre: ${order.nombre || 'Cliente'}
Dirección: ${order.calle}, ${order.ciudad} (CP: ${order.cp})
Producto: ${order.producto}
Plan: ${order.plan} Días
A pagar: ${order.precio}
Teléfono: ${phoneDisplay}`;

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
    const filteredOrders = orders.filter(order => {
        const matchesSearch = searchTerm === '' ||
            (order.nombre || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
            (order.cliente || '').includes(searchTerm) ||
            (order.tracking || '').toLowerCase().includes(searchTerm.toLowerCase());

        const matchesStatus = statusFilter === 'Todos' || (order.status || 'Pendiente') === statusFilter;

        return matchesSearch && matchesStatus;
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
        <div className="h-full flex flex-col animate-fade-in relative z-10 w-full space-y-6">

            {/* V2 Header & Advanced Filters */}
            <div className="bg-white/4 dark:bg-slate-800/40 backdrop-blur-xl rounded-[2rem] border border-white/6 dark:border-slate-700/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] p-5 lg:p-6">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-5">
                    <div>
                        <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600 tracking-tight">
                            Logística y Pedidos
                        </h1>
                        <p className="text-slate-500 mt-2 font-medium">Gestión inteligente de estados y envíos en tiempo real.</p>
                    </div>

                    <div className="flex gap-4">
                        <button onClick={() => refetch()} className="p-3 bg-white border border-slate-200 rounded-xl text-slate-600 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all shadow-sm active:scale-95 group">
                            <span className={`group-hover:rotate-180 transition-transform duration-500 block ${isFetching ? 'animate-spin text-indigo-500' : ''}`}><Refresh className="w-5 h-5" /></span>
                        </button>
                        <button onClick={handleExportCSV} disabled={orders.length === 0} className="px-6 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-105 transition-all flex items-center gap-2 disabled:opacity-50 disabled:scale-100">
                            <Download className="w-5 h-5" />
                            <span>Exportar CSV</span>
                        </button>
                    </div>
                </div>

                {/* Filters Bar V2 */}
                <div className="flex flex-col lg:flex-row gap-4">
                    <div className="flex-1 relative group">
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Buscar por cliente, teléfono o tracking..."
                            className="w-full bg-white/8 dark:bg-slate-800/80 border border-white rounded-xl pl-12 pr-4 py-3.5 text-sm font-medium focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all text-slate-700 shadow-inner placeholder:text-slate-400"
                        />
                        <span className="absolute left-4 top-3.5 text-slate-400 group-focus-within:text-indigo-500 transition-colors"><Search className="w-5 h-5" /></span>
                    </div>

                    <div className="flex items-center gap-2 bg-white/6 dark:bg-slate-800/60 p-2 rounded-xl border border-white/8 dark:border-slate-700/80 shadow-inner overflow-x-auto custom-scrollbar">
                        <div className="pl-3 pr-2 text-slate-400"><Filter className="w-5 h-5" /></div>
                        {['Todos', ...statusOptions].map(status => (
                            <button
                                key={status}
                                onClick={() => setStatusFilter(status)}
                                className={`px-4 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${statusFilter === status ? 'bg-indigo-600 text-white shadow-md' : 'bg-transparent text-slate-600 hover:bg-white'}`}
                            >
                                {status}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* V2 Glassmorphism Table */}
            <div className="flex-1 bg-white/6 dark:bg-slate-800/60 backdrop-blur-xl rounded-[2rem] border border-white/8 dark:border-slate-700/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden flex flex-col relative text-sm">

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
                                                            <span className="font-mono text-[10px] font-bold text-indigo-400 tracking-wider mt-0.5">{timePart.trim()}</span>
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
                                            {order.seller ? (
                                                <span className="px-2 py-1 bg-blue-50 text-blue-600 rounded-md text-[10px] font-bold border border-blue-100 shadow-sm">
                                                    +{order.seller.replace(/\D/g, '')}
                                                </span>
                                            ) : (
                                                <span className="text-[10px] text-slate-400 font-medium">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 text-center">
                                            <span className={`px-3 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-widest border ${statusStyles[order.status] || statusStyles['Pendiente']}`}>
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
                    <div className="md:hidden flex flex-col gap-4 p-4">
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
                                <div key={order.id} className="bg-white/8 dark:bg-slate-800/80 backdrop-blur-md border border-white rounded-[1.5rem] shadow-sm p-5 flex flex-col gap-4 relative overflow-hidden flex-shrink-0 animate-fade-in transition-all active:scale-[0.98]">
                                    <div className="flex justify-between items-start gap-3 w-full">
                                        <div className="flex items-center gap-3 min-w-0 flex-1">
                                            <div className="w-11 h-11 rounded-full bg-gradient-to-br from-indigo-50 to-purple-100 flex items-center justify-center text-indigo-600 font-extrabold text-[15px] shrink-0 border border-white shadow-sm shadow-indigo-100/50">
                                                {order.nombre ? order.nombre.substring(0, 2).toUpperCase() : '??'}
                                            </div>
                                            <div className="flex flex-col min-w-0 truncate pr-2">
                                                <p className="font-black text-[15px] text-slate-800 tracking-tight leading-tight truncate">{order.nombre || 'Desconocido'}</p>
                                                <p className="text-[12px] text-slate-500 font-mono mt-0.5 flex items-center gap-1.5 opacity-90 truncate">
                                                    <svg className="w-3.5 h-3.5 text-emerald-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                                                    {order.cliente ? '+' + order.cliente.split('@')[0].replace(/\D/g, '') : '—'}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex flex-col items-end gap-1.5 shrink-0">
                                            <span className={`px-2.5 py-1 rounded-md text-[9px] font-black uppercase tracking-widest border shadow-sm ${statusStyles[order.status] || statusStyles['Pendiente']}`}>
                                                {order.status || 'Pendiente'}
                                            </span>
                                            {(() => {
                                                const dt = formatDateBA(order.createdAt);
                                                if (typeof dt === 'string' && dt.includes(',')) {
                                                    const [datePart] = dt.split(',');
                                                    return <div className="flex flex-col items-end gap-1">
                                                        <span className="font-extrabold text-[10px] text-slate-400 bg-slate-50 px-2 py-0.5 rounded border border-slate-100">{datePart.trim()}</span>
                                                        {order.seller && <span className="font-bold text-[9px] text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">+{order.seller.replace(/\D/g, '')}</span>}
                                                    </div>;
                                                }
                                                return <div className="flex flex-col items-end gap-1">
                                                    <span className="font-extrabold text-[10px] text-slate-400 bg-slate-50 px-2 py-0.5 rounded border border-slate-100">{dt}</span>
                                                    {order.seller && <span className="font-bold text-[9px] text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">+{order.seller.replace(/\D/g, '')}</span>}
                                                </div>;
                                            })()}
                                        </div>
                                    </div>

                                    <div className="flex gap-2">
                                        <button onClick={() => { setViewingOrder(order); setTrackingData(null); }} className="flex-1 bg-white border border-slate-200 text-indigo-600 rounded-xl py-2.5 text-[11px] font-extrabold uppercase tracking-widest flex items-center justify-center gap-1.5 shadow-sm active:bg-indigo-50 transition-colors">
                                            <Script className="w-3.5 h-3.5" /> Detalles
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); handleGoToChat(order.cliente, order.seller); }} className="w-12 bg-emerald-50 border border-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center shadow-sm active:bg-emerald-100 transition-colors">
                                            <Chat className="w-4 h-4" />
                                        </button>
                                        <button onClick={() => openEdit(order)} className="w-12 bg-indigo-50 border border-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center shadow-sm active:bg-indigo-100 transition-colors">
                                            <Edit className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                </div>

                {/* V2 Pagination Controls */}
                <div className="px-8 py-5 border-t border-white/6 dark:border-slate-700/60 flex flex-col sm:flex-row justify-between items-center bg-white/3 dark:bg-slate-800/30 backdrop-blur-md gap-4">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                        Página <span className="text-indigo-600">{page}</span> de {pagination.totalPages}
                    </span>
                    <div className="flex gap-2">
                        <button
                            disabled={page <= 1 || isFetching}
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                            className="px-4 py-2 bg-white/8 dark:bg-slate-800/80 rounded-xl border border-white shadow-sm text-xs font-extrabold text-slate-600 disabled:opacity-50 hover:bg-white hover:text-indigo-600 transition-all active:-translate-y-0.5"
                        >
                            Anterior
                        </button>
                        <button
                            disabled={page >= pagination.totalPages || isFetching}
                            onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                            className="px-4 py-2 bg-white/8 dark:bg-slate-800/80 rounded-xl border border-white shadow-sm text-xs font-extrabold text-slate-600 disabled:opacity-50 hover:bg-white hover:text-indigo-600 transition-all active:-translate-y-0.5"
                        >
                            Siguiente
                        </button>
                    </div>
                    <span className="text-xs font-bold text-indigo-500 bg-indigo-50 px-3 py-1 rounded-full border border-indigo-100">{pagination.total} Totales en BD</span>
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
                                <label className="block text-xs font-extrabold text-slate-500 uppercase tracking-widest mb-2 ml-1">Código de Seguimiento (Andreani)</label>
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

            {/* V2 PREMIUM TICKET MODAL */}
            {viewingOrder && createPortal(
                <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md z-[100] flex items-center justify-center animate-fade-in p-0 sm:p-4 sm:p-6" onClick={() => { setViewingOrder(null); cancelDetailEdit(); }}>
                    <div className="bg-white dark:bg-slate-900 rounded-none sm:rounded-[2rem] shadow-2xl w-full h-full sm:h-auto max-w-3xl overflow-hidden flex flex-col sm:max-h-[90vh] relative border border-slate-100 dark:border-slate-700" onClick={e => e.stopPropagation()}>

                        {/* Header */}
                        <div className="bg-gradient-to-r from-slate-50 to-white dark:from-slate-800 dark:to-slate-900 p-6 sm:p-8 flex justify-between items-center relative border-b border-slate-100 dark:border-slate-700 shrink-0">
                            <div className="flex items-center gap-4 relative z-10">
                                <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center shadow-inner border border-indigo-100/50">
                                    <Script className="w-4 h-4" />
                                </div>
                                <div>
                                    <h3 className="text-2xl font-black text-slate-800 dark:text-slate-100 tracking-tight">Detalles de Venta</h3>
                                    <p className="text-slate-500 font-bold text-xs uppercase tracking-widest mt-1">
                                        Ref: {viewingOrder.id ? viewingOrder.id.substring(0, 8) : 'N/A'}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                {!isDetailEditing ? (
                                    <button onClick={() => startDetailEdit(viewingOrder)} className="w-10 h-10 rounded-full bg-indigo-50 text-indigo-500 hover:text-indigo-700 hover:bg-indigo-100 transition-all flex items-center justify-center border border-indigo-200" title="Editar">
                                        <Edit className="w-4 h-4" />
                                    </button>
                                ) : (
                                    <button onClick={cancelDetailEdit} className="w-10 h-10 rounded-full bg-rose-50 text-rose-500 hover:text-rose-700 hover:bg-rose-100 transition-all flex items-center justify-center border border-rose-200" title="Cancelar edición">
                                        <XIcon className="w-4 h-4" />
                                    </button>
                                )}
                                <button onClick={() => { setViewingOrder(null); cancelDetailEdit(); }} className="w-10 h-10 rounded-full bg-slate-50 dark:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-all flex items-center justify-center border border-slate-200 dark:border-slate-700">✕</button>
                            </div>
                        </div>

                        {/* Content */}
                        <div className="p-6 sm:p-8 overflow-y-auto custom-scrollbar flex-1 bg-white dark:bg-slate-900 relative">
                            {/* Top info grid */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                                {/* Client Info */}
                                <div>
                                    <span className="text-[10px] font-black uppercase text-indigo-500 tracking-widest mb-3 flex items-center gap-2">
                                        <div className="w-4 h-[2px] bg-indigo-500 rounded-full"></div> Cliente
                                    </span>
                                    <div className={`bg-slate-50 dark:bg-slate-800 rounded-2xl p-5 border ${isDetailEditing ? 'border-indigo-200 dark:border-indigo-500/50' : 'border-slate-100 dark:border-slate-700'}`}>
                                        {isDetailEditing ? (
                                            <input type="text" value={detailEditData.nombre || ''} onChange={e => handleDetailField('nombre', e.target.value)} className="w-full font-black text-slate-800 dark:text-slate-100 text-lg leading-tight mb-1 bg-white dark:bg-slate-700 rounded-lg px-3 py-2 border border-slate-200 dark:border-slate-600 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900/50 outline-none" placeholder="Nombre completo" />
                                        ) : (
                                            <p className="font-black text-slate-800 dark:text-slate-100 text-lg leading-tight mb-1">{viewingOrder.nombre || 'Sin nombre'}</p>
                                        )}
                                        <p className="font-mono text-slate-500 dark:text-slate-400 text-sm font-medium">{viewingOrder.cliente ? viewingOrder.cliente.split('@')[0] : '—'}</p>
                                        <div className="mt-4 pt-4 border-t border-slate-200/60 dark:border-slate-700/60 flex justify-between items-center">
                                            <span className="text-slate-400 dark:text-slate-500 font-bold text-xs">Fecha:</span>
                                            <span className="text-slate-700 dark:text-slate-300 font-bold text-sm">{formatDateBA(viewingOrder.createdAt)}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Delivery Info */}
                                <div>
                                    <div className="flex justify-between items-center mb-3">
                                        <span className="text-[10px] font-black uppercase text-indigo-500 tracking-widest flex items-center gap-2">
                                            <div className="w-4 h-[2px] bg-indigo-500 rounded-full"></div> Envío
                                        </span>
                                        {/* Premium Postdatado Badge */}
                                        {viewingOrder.postdatado && String(viewingOrder.postdatado).trim() !== '' && String(viewingOrder.postdatado).toLowerCase() !== 'no' && String(viewingOrder.postdatado).toLowerCase() !== 'false' ? (
                                            <span className="text-[10px] font-black bg-amber-100 text-amber-600 px-3 py-1 rounded-full border border-amber-200 uppercase tracking-widest flex items-center gap-1.5 shadow-sm">
                                                <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse"></div>
                                                POSTDATADO: {viewingOrder.postdatado}
                                            </span>
                                        ) : (
                                            <span className="text-[10px] font-bold bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-300 px-3 py-1 rounded-full border border-slate-200 dark:border-slate-600 uppercase tracking-widest">
                                                Inmediato
                                            </span>
                                        )}
                                    </div>
                                    <div className={`bg-slate-50 dark:bg-slate-800 rounded-2xl p-5 border ${isDetailEditing ? 'border-indigo-200 dark:border-indigo-500/50' : 'border-slate-100 dark:border-slate-700'} h-[calc(100%-28px)] flex flex-col justify-center`}>
                                        {isDetailEditing ? (
                                            <>
                                                <input type="text" value={detailEditData.calle || ''} onChange={e => handleDetailField('calle', e.target.value)} className="w-full font-bold text-slate-700 dark:text-slate-200 text-base bg-white dark:bg-slate-700 rounded-lg px-3 py-2 border border-slate-200 dark:border-slate-600 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none mb-2" placeholder="Calle y número" />
                                                <div className="flex gap-2">
                                                    <input type="text" value={detailEditData.ciudad || ''} onChange={e => handleDetailField('ciudad', e.target.value)} className="flex-1 font-medium text-slate-600 dark:text-slate-300 text-sm bg-white dark:bg-slate-700 rounded-lg px-3 py-2 border border-slate-200 dark:border-slate-600 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none" placeholder="Ciudad" />
                                                    <input type="text" value={detailEditData.cp || ''} onChange={e => handleDetailField('cp', e.target.value)} className="w-24 font-medium text-slate-600 dark:text-slate-300 text-sm bg-white dark:bg-slate-700 rounded-lg px-3 py-2 border border-slate-200 dark:border-slate-600 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none" placeholder="CP" />
                                                </div>
                                                <input type="text" value={detailEditData.provincia || ''} onChange={e => handleDetailField('provincia', e.target.value)} className="w-full font-medium text-slate-600 dark:text-slate-300 text-sm bg-white dark:bg-slate-700 rounded-lg px-3 py-2 border border-slate-200 dark:border-slate-600 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none mt-2" placeholder="Provincia" />
                                            </>
                                        ) : (
                                            <>
                                                <p className="font-bold text-slate-700 dark:text-slate-200 text-base leading-relaxed">{viewingOrder.calle || 'Sin domicilio'}</p>
                                                <p className="font-medium text-slate-600 dark:text-slate-400 text-sm mt-1">{viewingOrder.ciudad || 'Sin ciudad'} <span className="text-slate-400 dark:text-slate-500 ml-1">(CP: {viewingOrder.cp || '—'})</span></p>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Order Summary Ribbon */}
                            <div className="bg-slate-50 dark:bg-slate-800 rounded-3xl p-6 border border-slate-100 dark:border-slate-700 mb-8">
                                <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                                    <div className="text-center md:text-left flex-1">
                                        {isDetailEditing ? (
                                            <input type="text" value={detailEditData.producto || ''} onChange={e => handleDetailField('producto', e.target.value)} className="font-black text-slate-800 dark:text-slate-100 text-xl bg-white dark:bg-slate-700 rounded-xl px-3 py-2 border border-slate-200 dark:border-slate-600 w-full focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900/50 outline-none" placeholder="Producto" />
                                        ) : (
                                            <p className="font-black text-slate-800 dark:text-slate-100 text-xl">{viewingOrder.producto || 'Sin producto'}</p>
                                        )}
                                        <span className="inline-block mt-2 px-3 py-1 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-xs font-bold rounded-lg shadow-sm">
                                            ID: {viewingOrder.id ? viewingOrder.id.substring(8, 16) : 'N/A'}
                                        </span>
                                    </div>

                                    <div className="w-full md:w-px h-px md:h-16 bg-slate-200 dark:bg-slate-700"></div>

                                    <div className="flex-1 w-full flex flex-col items-start md:items-center">
                                        <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest mb-2 block">Estado Actual</span>
                                        <span className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest border shadow-sm ${statusStyles[viewingOrder.status] || statusStyles['Pendiente']}`}>
                                            {viewingOrder.status || 'Pendiente'}
                                        </span>
                                    </div>

                                    <div className="w-full md:w-px h-px md:h-16 bg-slate-200 dark:bg-slate-700"></div>

                                    <div className="text-center md:text-right">
                                        <p className="text-slate-400 dark:text-slate-500 font-bold text-xs tracking-widest uppercase mb-1">Total a Cobrar</p>
                                        <div className="flex items-start justify-center md:justify-end">
                                            <span className="text-emerald-500 font-bold mt-1 mr-1 text-lg">$</span>
                                            {isDetailEditing ? (
                                                <input type="text" value={detailEditData.precio || ''} onChange={e => handleDetailField('precio', e.target.value)} className="font-black text-emerald-500 dark:text-emerald-400 text-4xl w-32 md:w-48 text-center md:text-right bg-white dark:bg-slate-700 rounded-xl px-3 py-2 border border-slate-200 dark:border-slate-600 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 dark:focus:ring-emerald-900/50 outline-none" placeholder="0" />
                                            ) : (
                                                <h4 className="font-black text-emerald-500 dark:text-emerald-400 text-4xl tabular-nums tracking-tighter">{viewingOrder.precio}</h4>
                                            )}
                                        </div>
                                        <p className="text-slate-400 dark:text-slate-500 font-bold text-xs">Pago en efectivo al repartidor</p>
                                    </div>
                                </div>
                            </div>

                            {/* Tracking Section */}
                            <div>
                                <div className="flex justify-between items-center mb-4">
                                    <span className="text-[10px] font-black uppercase text-indigo-500 tracking-widest flex items-center gap-2">
                                        <div className="w-4 h-[2px] bg-indigo-500 rounded-full"></div> Logística
                                    </span>
                                    {viewingOrder.tracking && (
                                        <button onClick={() => handleTrackOrder(viewingOrder.tracking)} disabled={isTracking} className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white font-bold text-xs rounded-xl transition-all shadow-sm border border-blue-100 disabled:opacity-50">
                                            {isTracking ? 'Consultando...' : '🔍 Rastrear Envío'}
                                        </button>
                                    )}
                                </div>

                                <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-5 shadow-sm">
                                    {!viewingOrder.tracking ? (
                                        <div className="text-center py-6">
                                            <p className="text-slate-400 dark:text-slate-500 font-medium text-sm">Aún no hay número de seguimiento asignado.</p>
                                        </div>
                                    ) : (
                                        <div>
                                            <div className="flex items-center justify-between mb-6 pb-6 border-b border-slate-100 dark:border-slate-700">
                                                <div>
                                                    <span className="text-xs font-bold text-slate-500 block mb-1">Código de Tracking</span>
                                                    <span className="font-mono text-slate-800 dark:text-slate-200 font-bold text-lg bg-slate-50 dark:bg-slate-700 px-3 py-1 rounded-lg border border-slate-200 dark:border-slate-600 tracking-wider">
                                                        {viewingOrder.tracking}
                                                    </span>
                                                </div>
                                                <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center text-blue-500">
                                                    <Refresh className="w-5 h-5" />
                                                </div>
                                            </div>

                                            {/* Tracking Data */}
                                            {trackingData && (
                                                <div className="animate-fade-in">
                                                    {trackingData.success ? (
                                                        trackingData.events && trackingData.events.length > 0 ? (
                                                            <div className="space-y-4">
                                                                {trackingData.events.map((ev, i) => (
                                                                    <div key={i} className="flex gap-4 items-start relative pb-6 border-l-2 border-indigo-100 dark:border-indigo-900/50 last:border-0 last:pb-0 ml-2">
                                                                        <div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-indigo-400 ring-4 ring-white dark:ring-slate-800"></div>
                                                                        <div className="pl-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 w-full">
                                                                            <div className="min-w-[120px]">
                                                                                <span className="font-bold text-slate-800 dark:text-slate-200 text-xs block">{ev.fecha}</span>
                                                                                <span className="text-blue-500 font-black uppercase text-[9px] tracking-widest mt-0.5 block">{ev.planta}</span>
                                                                            </div>
                                                                            <p className="text-slate-600 dark:text-slate-300 font-medium text-sm flex-1">{ev.historia}</p>
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        ) : (
                                                            <p className="text-slate-500 dark:text-slate-400 text-sm text-center py-4">El operador no reporta movimientos recientes.</p>
                                                        )
                                                    ) : (
                                                        <div className="bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 font-bold text-sm p-4 rounded-xl text-center border border-rose-100 dark:border-rose-800/50">
                                                            {trackingData.error || "Tracking sin información disponible."}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                            {viewingOrder.logs && viewingOrder.logs.length > 0 && (
                                                <div className="mt-8 pt-8 border-t border-slate-100 dark:border-slate-700">
                                                    <span className="text-[10px] font-black uppercase text-indigo-500 tracking-widest mb-4 flex items-center gap-2">
                                                        <div className="w-4 h-[2px] bg-indigo-500 rounded-full"></div> Historial de Estados
                                                    </span>
                                                    <div className="space-y-4">
                                                        {[...viewingOrder.logs].reverse().map((log, idx) => (
                                                            <div key={idx} className="flex gap-4 items-start relative pb-6 border-l-2 border-indigo-100 dark:border-indigo-900/50 last:border-0 last:pb-0 ml-2">
                                                                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-white dark:bg-slate-800 border-4 border-indigo-500 z-10"></div>
                                                                <div className="pl-6 flex-1 pt-[-2px]">
                                                                    <div className="flex justify-between items-center mb-1">
                                                                        <span className="font-bold text-slate-800 dark:text-slate-200 text-xs block">{log.status}</span>
                                                                        <span className="text-slate-400 dark:text-slate-500 text-[10px] font-bold">{formatDateBA(log.timestamp)}</span>
                                                                    </div>
                                                                    <p className="text-slate-600 dark:text-slate-300 font-medium text-sm flex-1">{log.message}</p>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            {viewingOrder.status === 'Cancelado' && (
                                                <div className="bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 font-bold text-sm p-4 rounded-xl text-center border border-rose-100 dark:border-rose-800/50 mt-6">
                                                    Este pedido fue marcado como Cancelado.
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Footer Options */}
                        <div className="bg-slate-50 p-6 flex justify-end gap-3 shrink-0 border-t border-slate-200">
                            {isDetailEditing ? (
                                <>
                                    <button onClick={cancelDetailEdit} className="flex items-center gap-2 px-6 py-3 bg-white text-slate-500 hover:text-slate-700 hover:bg-slate-100 border border-slate-200 shadow-sm font-extrabold text-xs uppercase tracking-widest rounded-xl transition-all">
                                        <XIcon className="w-4 h-4" /> Cancelar
                                    </button>
                                    <button onClick={handleSaveOrderDetails} disabled={savingDetails} className="flex items-center gap-2 px-8 py-3 bg-indigo-600 text-white rounded-xl text-xs uppercase tracking-widest font-extrabold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-600/20 active:scale-95 disabled:opacity-50">
                                        <Save className="w-4 h-4" /> {savingDetails ? 'Guardando...' : 'Guardar'}
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button onClick={() => handleCopySaleDetails(viewingOrder)} className="flex items-center gap-2 px-6 py-3 bg-white text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 shadow-sm font-extrabold text-xs uppercase tracking-widest rounded-xl transition-all">
                                        <Script className="w-4 h-4" /> Copiar Info
                                    </button>
                                    <button onClick={() => { setViewingOrder(null); cancelDetailEdit(); }} className="px-8 py-3 bg-slate-800 text-white rounded-xl text-xs uppercase tracking-widest font-extrabold hover:bg-black transition-all shadow-lg shadow-slate-800/20 active:scale-95">
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

export default SalesViewV2;
