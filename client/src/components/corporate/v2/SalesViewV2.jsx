import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { useToast } from '../../ui/Toast';

const IconsV2 = {
    Refresh: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>,
    Download: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>,
    Search: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
    Filter: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>,
    Chat: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>,
    Edit: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
    Trash: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
};

const SalesViewV2 = ({ onGoToChat }) => {
    const { toast, confirm } = useToast();
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);

    // Advanced Filters V2
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('Todos');

    // Viewing / Details State
    const [viewingOrder, setViewingOrder] = useState(null);

    // Editing State
    const [editingOrder, setEditingOrder] = useState(null);
    const [editStatus, setEditStatus] = useState('');
    const [editTracking, setEditTracking] = useState('');
    const [savingOrder, setSavingOrder] = useState(false);

    const fetchOrders = async () => {
        setLoading(true);
        try {
            const res = await api.get('/api/orders');
            setOrders(res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
        } catch (e) {
            toast.error("Error cargando pedidos");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchOrders(); }, []);

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
            await api.post(`/api/orders/${editingOrder.id}/status`, { status: editStatus, tracking: editTracking });
            setOrders(prev => prev.map(o => o.id === editingOrder.id ? { ...o, status: editStatus, tracking: editTracking } : o));
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
            await api.delete(`/api/orders/${editingOrder.id}`);
            setOrders(prev => prev.filter(o => o.id !== editingOrder.id));
            setEditingOrder(null);
            toast.success('Pedido eliminado');
        } catch (e) { toast.error('Error eliminando pedido'); }
    };

    const handleGoToChat = async (clienteStr) => {
        if (!clienteStr) {
            toast.warning('El pedido no tiene un teléfono asociado.');
            return;
        }

        const toastId = toast.info('Buscando chat...');
        try {
            const res = await api.get('/api/chats');
            const chats = res.data;
            const cleaned = clienteStr.replace(/\D/g, ''); // phone numbers only mode

            const chatExists = chats.find(c =>
                c.id === clienteStr ||
                c.id === `${clienteStr}@c.us` ||
                c.id.includes(cleaned) ||
                (c.name && c.name.includes(clienteStr))
            );

            if (chatExists) {
                if (onGoToChat) onGoToChat(chatExists.id);
                toast.dismiss(toastId);
            } else {
                toast.dismiss(toastId);
                toast.warning('No se ha encontrado un chat activo en WhatsApp para este cliente. Asegurate de que el bot esté conectado y el cliente haya escrito.');
            }
        } catch (e) {
            toast.dismiss(toastId);
            toast.error('Error de conexión al verificar chats activos.');
        }
    };

    // Styling Maps
    const statusOptions = ['Pendiente', 'Confirmado', 'Enviado', 'Entregado', 'Cancelado'];
    const statusStyles = {
        'Pendiente': 'bg-amber-100/80 text-amber-700 border-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.2)]',
        'Confirmado': 'bg-blue-100/80 text-blue-700 border-blue-300 shadow-[0_0_10px_rgba(59,130,246,0.2)]',
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
            <div className="bg-white/40 backdrop-blur-xl rounded-[2rem] border border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] p-8">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8">
                    <div>
                        <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600 tracking-tight">
                            Logística y Pedidos
                        </h1>
                        <p className="text-slate-500 mt-2 font-medium">Gestión inteligente de estados y envíos en tiempo real.</p>
                    </div>

                    <div className="flex gap-4">
                        <button onClick={fetchOrders} className="p-3 bg-white border border-slate-200 rounded-xl text-slate-600 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all shadow-sm active:scale-95 group">
                            <span className="group-hover:rotate-180 transition-transform duration-500 block"><IconsV2.Refresh /></span>
                        </button>
                        <button onClick={handleExportCSV} disabled={orders.length === 0} className="px-6 py-3 bg-gradient-to-r from-slate-800 to-slate-700 text-white rounded-xl text-sm font-bold shadow-lg shadow-slate-800/20 hover:shadow-slate-800/40 hover:scale-105 transition-all flex items-center gap-2 disabled:opacity-50 disabled:scale-100">
                            <IconsV2.Download />
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
                            className="w-full bg-white/80 border border-white rounded-xl pl-12 pr-4 py-3.5 text-sm font-medium focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all text-slate-700 shadow-inner placeholder:text-slate-400"
                        />
                        <span className="absolute left-4 top-3.5 text-slate-400 group-focus-within:text-indigo-500 transition-colors"><IconsV2.Search /></span>
                    </div>

                    <div className="flex items-center gap-2 bg-white/60 p-2 rounded-xl border border-white/80 shadow-inner overflow-x-auto custom-scrollbar">
                        <div className="pl-3 pr-2 text-slate-400"><IconsV2.Filter /></div>
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
            <div className="flex-1 bg-white/60 backdrop-blur-xl rounded-[2rem] border border-white/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden flex flex-col relative text-sm">

                {/* Background Glow */}
                <div className="absolute -bottom-32 -left-32 w-96 h-96 bg-purple-400/10 blur-[100px] rounded-full pointer-events-none"></div>

                <div className="overflow-x-auto custom-scrollbar flex-1 relative z-10">
                    <table className="w-full text-left border-collapse whitespace-nowrap">
                        <thead className="bg-white/40 border-b border-white/60 sticky top-0 z-20 backdrop-blur-md">
                            <tr className="text-xs uppercase tracking-widest text-slate-500 font-extrabold">
                                <th className="px-4 sm:px-8 py-5 hidden md:table-cell">Fecha</th>
                                <th className="px-4 sm:px-8 py-5">Cliente</th>
                                <th className="px-4 sm:px-8 py-5">Prod / Plan</th>
                                <th className="px-4 sm:px-8 py-5 text-right hidden sm:table-cell">Monto</th>
                                <th className="px-4 sm:px-8 py-5 text-center hidden xl:table-cell">Postdatado</th>
                                <th className="px-4 sm:px-8 py-5 text-center">Estado</th>
                                <th className="px-4 sm:px-8 py-5 hidden md:table-cell">Tracking</th>
                                <th className="px-4 sm:px-8 py-5 text-right w-10">Acciones</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200/50">
                            {loading ? (
                                <tr><td colSpan="8" className="text-center py-20">
                                    <div className="flex flex-col items-center justify-center gap-4 text-indigo-500">
                                        <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin shadow-lg"></div>
                                        <span className="font-bold tracking-widest text-xs uppercase text-slate-400">Sincronizando Base de Datos</span>
                                    </div>
                                </td></tr>
                            ) : filteredOrders.length === 0 ? (
                                <tr><td colSpan="8" className="text-center py-20">
                                    <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4 border-2 border-dashed border-slate-300">
                                        <IconsV2.Search />
                                    </div>
                                    <p className="text-slate-500 font-bold text-lg">No se encontraron pedidos</p>
                                    <p className="text-slate-400 text-sm mt-1">Intentá ajustar los filtros de búsqueda.</p>
                                </td></tr>
                            ) : (
                                filteredOrders.map(order => (
                                    <tr key={order.id} className="hover:bg-white/50 transition-colors group">
                                        <td className="px-4 sm:px-8 py-5 font-mono text-xs font-bold text-slate-500 hidden md:table-cell">
                                            {formatDateBA(order.createdAt)}
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 max-w-[120px] sm:max-w-xs truncate">
                                            <button onClick={() => setViewingOrder(order)} className="text-left group/click focus:outline-none">
                                                <p className="font-extrabold text-slate-800 group-hover/click:text-indigo-600 transition-colors border-b border-dashed border-transparent group-hover/click:border-indigo-400 truncate">
                                                    {order.nombre || 'Desconocido'}
                                                </p>
                                                <p className="text-xs text-slate-400 font-mono mt-0.5 truncate">
                                                    {order.cliente ? order.cliente.split('@')[0] : '—'}
                                                </p>
                                            </button>
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 max-w-[100px] sm:max-w-xs truncate">
                                            <p className="font-bold text-indigo-700 truncate">{order.producto}</p>
                                            {order.plan && <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 bg-indigo-50 px-2 py-0.5 rounded-md mt-1 inline-block">Plan {order.plan} d.</span>}
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 text-right font-mono font-extrabold text-slate-800 text-base hidden sm:table-cell">
                                            ${order.precio}
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 text-center hidden xl:table-cell">
                                            {order.postdatado ? (
                                                <span className="px-3 py-1 bg-amber-100/50 text-amber-700 text-[10px] font-extrabold tracking-widest uppercase rounded-full border border-amber-200 shadow-sm">
                                                    {order.postdatado}
                                                </span>
                                            ) : <span className="text-slate-300">—</span>}
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 text-center">
                                            <span className={`px-3 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-widest border ${statusStyles[order.status] || statusStyles['Pendiente']}`}>
                                                {order.status || 'Pendiente'}
                                            </span>
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 hidden md:table-cell">
                                            {order.tracking ? (
                                                <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50/80 px-3 py-1.5 rounded-lg border border-blue-200/50 shadow-sm cursor-copy hover:bg-blue-100 transition-colors" title="Copiar tracking" onClick={() => { navigator.clipboard.writeText(order.tracking); toast.success('Tracking copiado'); }}>
                                                    {order.tracking}
                                                </span>
                                            ) : <span className="text-xs text-slate-300">—</span>}
                                        </td>
                                        <td className="px-4 sm:px-8 py-5 text-right">
                                            <div className="flex justify-end gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button onClick={(e) => { e.stopPropagation(); handleGoToChat(order.cliente); }} className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 hover:bg-emerald-500 hover:text-white transition-all flex items-center justify-center shadow-sm" title="Ir al Chat">
                                                    <IconsV2.Chat />
                                                </button>
                                                <button onClick={() => openEdit(order)} className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 hover:bg-blue-500 hover:text-white transition-all flex items-center justify-center shadow-sm" title="Editar Pedido">
                                                    <IconsV2.Edit />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Footer */}
                <div className="px-8 py-5 border-t border-white/60 flex justify-between items-center bg-white/30 backdrop-blur-md">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Mostrando {filteredOrders.length} registros</span>
                    <span className="text-xs font-bold text-indigo-500 bg-indigo-50 px-3 py-1 rounded-full border border-indigo-100">{orders.length} Totales en BD</span>
                </div>
            </div>

            {/* V2 GLASSMORPHISM EDIT MODAL */}
            {editingOrder && (
                <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md z-50 flex items-center justify-center animate-fade-in p-4">
                    <div className="bg-white/90 backdrop-blur-2xl rounded-[2rem] shadow-2xl w-full max-w-md p-8 border border-white relative overflow-hidden">

                        <div className="absolute top-0 right-0 w-40 h-40 bg-indigo-500/10 blur-[50px] rounded-full pointer-events-none"></div>

                        <div className="flex justify-between items-center mb-8 relative z-10">
                            <div>
                                <h3 className="text-2xl font-extrabold text-slate-800 tracking-tight">Editar Estado</h3>
                                <p className="text-xs font-bold text-indigo-600 uppercase tracking-widest mt-1">Order #{editingOrder.id?.substring(0, 6) || 'N/A'}</p>
                            </div>
                            <button onClick={() => setEditingOrder(null)} className="w-10 h-10 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors flex items-center justify-center">✕</button>
                        </div>

                        <div className="space-y-6 relative z-10">
                            <div className="bg-gradient-to-br from-slate-50 to-blue-50/50 rounded-2xl p-5 border border-slate-200/60 shadow-inner">
                                <p className="text-lg font-extrabold text-slate-800 mb-1">{editingOrder.nombre || 'Sin nombre'}</p>
                                <p className="text-sm font-mono text-slate-500 mb-3">{editingOrder.cliente}</p>
                                <div className="flex items-center gap-2">
                                    <span className="px-2.5 py-1 rounded-lg bg-indigo-100 text-indigo-700 text-xs font-bold">{editingOrder.producto}</span>
                                    <span className="text-sm font-extrabold text-slate-800 ml-auto">${editingOrder.precio}</span>
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-extrabold text-slate-500 uppercase tracking-widest mb-2 ml-1">Estado del Pedido</label>
                                <div className="relative">
                                    <select
                                        value={editStatus}
                                        onChange={(e) => setEditStatus(e.target.value)}
                                        className="w-full appearance-none bg-white border border-slate-200 rounded-xl px-5 py-4 text-sm font-bold text-slate-700 focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all shadow-sm cursor-pointer"
                                    >
                                        {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                    <div className="absolute inset-y-0 right-0 flex items-center px-5 pointer-events-none text-slate-400">
                                        <IconsV2.Filter />
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
                                    className="w-full bg-white border border-slate-200 rounded-xl px-5 py-4 text-sm font-mono font-bold text-slate-700 focus:ring-4 focus:ring-blue-500/20 focus:border-blue-400 outline-none transition-all shadow-sm placeholder:text-slate-300 placeholder:font-sans placeholder:font-normal"
                                />
                            </div>
                        </div>

                        <div className="mt-8 space-y-3 relative z-10">
                            <div className="flex gap-3">
                                <button onClick={() => setEditingOrder(null)} className="flex-1 py-4 bg-slate-100 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-200 transition-colors shadow-sm">
                                    Cancelar
                                </button>
                                <button onClick={handleSaveEdit} disabled={savingOrder} className="flex-1 py-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-[1.02] transition-all disabled:opacity-50 disabled:scale-100">
                                    {savingOrder ? 'Guardando...' : 'Aplicar Cambios'}
                                </button>
                            </div>

                            <button onClick={handleDeleteOrder} className="w-full py-4 bg-transparent border-2 border-rose-100 text-rose-500 rounded-xl text-xs font-extrabold uppercase tracking-widest hover:bg-rose-50 hover:border-rose-200 transition-all flex items-center justify-center gap-2 mt-4">
                                <IconsV2.Trash />
                                Eliminar Registro
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* V2 DETAILS MODAL */}
            {viewingOrder && (
                <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-md z-50 flex items-center justify-center animate-fade-in p-4" onClick={() => setViewingOrder(null)}>
                    <div className="bg-white/90 backdrop-blur-2xl rounded-[2rem] shadow-2xl w-full max-w-lg p-8 border border-white relative overflow-hidden" onClick={e => e.stopPropagation()}>

                        <div className="absolute top-0 -left-10 w-40 h-40 bg-purple-500/10 blur-[50px] rounded-full pointer-events-none"></div>

                        <div className="flex justify-between items-start mb-6 relative z-10">
                            <div>
                                <h3 className="text-2xl font-extrabold text-slate-800 tracking-tight mb-1">{viewingOrder.nombre || 'Sin nombre'}</h3>
                                <p className="text-sm font-bold text-indigo-500 font-mono tracking-widest">{viewingOrder.cliente ? viewingOrder.cliente.split('@')[0] : '—'}</p>
                            </div>
                            <button onClick={() => setViewingOrder(null)} className="w-10 h-10 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors flex items-center justify-center -mr-2">✕</button>
                        </div>

                        <div className="space-y-4 relative z-10 text-sm">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="bg-white rounded-xl p-4 border border-slate-200/60 shadow-sm">
                                    <span className="block text-[10px] uppercase font-bold text-slate-400 tracking-widest mb-1">Fecha / Hora (-3 BA)</span>
                                    <p className="font-mono font-bold text-slate-700">{formatDateBA(viewingOrder.createdAt)}</p>
                                </div>
                                <div className="bg-white rounded-xl p-4 border border-slate-200/60 shadow-sm">
                                    <span className="block text-[10px] uppercase font-bold text-slate-400 tracking-widest mb-1">Estado de Envío</span>
                                    <span className={`inline-block px-2.5 py-1 rounded-md text-[10px] font-extrabold uppercase tracking-widest border ${statusStyles[viewingOrder.status] || statusStyles['Pendiente']}`}>
                                        {viewingOrder.status || 'Pendiente'}
                                    </span>
                                </div>
                            </div>

                            <div className="bg-gradient-to-br from-indigo-50/50 to-purple-50/50 rounded-xl p-4 border border-indigo-100/50 shadow-sm">
                                <span className="block text-[10px] uppercase font-bold text-indigo-400 tracking-widest mb-3">Resumen de Compra</span>
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center bg-white/60 p-2.5 rounded-lg border border-white">
                                        <span className="font-bold text-slate-600 text-xs">{viewingOrder.producto}</span>
                                        <span className="font-mono font-extrabold text-slate-800">${viewingOrder.precio}</span>
                                    </div>
                                    <div className="flex justify-between text-xs px-2 text-slate-500">
                                        <span>Plan elegido:</span>
                                        <span className="font-bold">{viewingOrder.plan || '—'}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="bg-white rounded-xl p-4 border border-slate-200/60 shadow-sm space-y-3">
                                <span className="block text-[10px] uppercase font-bold text-slate-400 tracking-widest mb-2 border-b border-slate-100 pb-2">Datos de Destino</span>
                                <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-xs">
                                    <div>
                                        <span className="block text-slate-400 mb-0.5">Domicilio</span>
                                        <p className="font-bold text-slate-700">{viewingOrder.calle || '—'}</p>
                                    </div>
                                    <div>
                                        <span className="block text-slate-400 mb-0.5">Ciudad</span>
                                        <p className="font-bold text-slate-700">{viewingOrder.ciudad || '—'}</p>
                                    </div>
                                    <div>
                                        <span className="block text-slate-400 mb-0.5">Código Postal</span>
                                        <p className="font-bold text-slate-700 font-mono">{viewingOrder.cp || '—'}</p>
                                    </div>
                                    <div>
                                        <span className="block text-slate-400 mb-0.5">Tracking</span>
                                        {viewingOrder.tracking ? (
                                            <p className="font-bold font-mono text-blue-600 bg-blue-50 px-2 py-0.5 rounded inline-block">{viewingOrder.tracking}</p>
                                        ) : <p className="font-bold text-slate-700">—</p>}
                                    </div>
                                </div>
                                {viewingOrder.postdatado && (
                                    <div className="mt-2 pt-2 border-t border-slate-100">
                                        <span className="block text-amber-500 font-bold text-xs uppercase tracking-widest mb-1">Envío Postdatado</span>
                                        <p className="text-xs font-bold text-slate-700">{viewingOrder.postdatado}</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="mt-6">
                            <button onClick={() => setViewingOrder(null)} className="w-full py-4 bg-slate-800 text-white rounded-xl text-sm font-bold hover:bg-slate-700 transition-colors shadow-lg shadow-slate-800/20">
                                Cerrar Detalles
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SalesViewV2;
