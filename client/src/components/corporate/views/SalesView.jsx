import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { API_URL } from '../../../config/api';

const SalesView = () => {
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editingOrder, setEditingOrder] = useState(null);
    const [editStatus, setEditStatus] = useState('');
    const [editTracking, setEditTracking] = useState('');
    const [savingOrder, setSavingOrder] = useState(false);

    const fetchOrders = async () => {
        try {
            const res = await axios.get(`${API_URL}/api/orders`);
            setOrders(res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
        } catch (e) {
            console.error("Failed to load orders", e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchOrders(); }, []);

    // Export CSV
    const handleExportCSV = () => {
        if (orders.length === 0) return;

        const headers = ['Fecha', 'Cliente', 'Nombre', 'Producto', 'Plan', 'Precio', 'Estado', 'Tracking', 'Ciudad', 'Calle', 'CP'];
        const rows = orders.map(o => [
            o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '',
            o.cliente || '',
            o.nombre || '',
            o.producto || '',
            o.plan || '',
            o.precio || '',
            o.status || '',
            o.tracking || '',
            o.ciudad || '',
            o.calle || '',
            o.cp || ''
        ]);

        const csvContent = [
            headers.join(','),
            ...rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pedidos_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // Open Edit Modal
    const openEdit = (order) => {
        setEditingOrder(order);
        setEditStatus(order.status || 'Pendiente');
        setEditTracking(order.tracking || '');
    };

    // Save Edit
    const handleSaveEdit = async () => {
        if (!editingOrder) return;
        setSavingOrder(true);
        try {
            await axios.post(`${API_URL}/api/orders/${editingOrder.id}/status`, {
                status: editStatus,
                tracking: editTracking
            });
            // Update local state
            setOrders(prev => prev.map(o =>
                o.id === editingOrder.id ? { ...o, status: editStatus, tracking: editTracking } : o
            ));
            setEditingOrder(null);
        } catch (e) {
            console.error('Error saving order:', e);
        }
        setSavingOrder(false);
    };

    const statusOptions = ['Pendiente', 'Confirmado', 'Enviado', 'Entregado', 'Cancelado'];

    const statusStyles = {
        'Pendiente': 'bg-amber-50 text-amber-600 border-amber-200',
        'Confirmado': 'bg-blue-50 text-blue-600 border-blue-200',
        'Enviado': 'bg-indigo-50 text-indigo-600 border-indigo-200',
        'Entregado': 'bg-emerald-50 text-emerald-600 border-emerald-200',
        'Cancelado': 'bg-rose-50 text-rose-600 border-rose-200'
    };

    return (
        <div className="h-full flex flex-col animate-fade-in">
            {/* Header */}
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Logística y Pedidos</h2>
                    <p className="text-sm text-slate-500">Seguimiento en tiempo real de ventas y envíos.</p>
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={fetchOrders}
                        className="px-4 py-2 bg-white border border-slate-300 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50 transition shadow-sm flex items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                        Actualizar Datos
                    </button>
                    <button
                        onClick={handleExportCSV}
                        disabled={orders.length === 0}
                        className="px-4 py-2 bg-slate-900 text-white rounded-md text-sm font-medium shadow-sm hover:bg-slate-800 transition flex items-center gap-2 disabled:opacity-50"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        Exportar CSV
                    </button>
                </div>
            </div>

            {/* Table Container */}
            <div className="flex-1 bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                <div className="overflow-x-auto custom-scrollbar flex-1">
                    <table className="w-full text-left border-collapse">
                        <thead className="bg-slate-50 border-b border-slate-200">
                            <tr className="text-xs uppercase tracking-wider text-slate-500 font-bold">
                                <th className="px-6 py-4">Fecha</th>
                                <th className="px-6 py-4">Cliente</th>
                                <th className="px-6 py-4">Producto / Plan</th>
                                <th className="px-6 py-4 text-right">Monto</th>
                                <th className="px-6 py-4 text-center">Estado</th>
                                <th className="px-6 py-4 text-center">Tracking</th>
                                <th className="px-6 py-4 text-right">Acciones</th>
                            </tr>
                        </thead>
                        <tbody className="text-sm text-slate-600 divide-y divide-slate-100">
                            {loading ? (
                                <tr><td colSpan="7" className="text-center py-10">
                                    <div className="flex items-center justify-center gap-3 text-slate-400">
                                        <div className="w-5 h-5 border-2 border-slate-300 border-t-transparent rounded-full animate-spin"></div>
                                        Cargando pedidos...
                                    </div>
                                </td></tr>
                            ) : orders.length === 0 ? (
                                <tr><td colSpan="7" className="text-center py-10 opacity-50">No se encontró base de datos de pedidos.</td></tr>
                            ) : (
                                orders.map(order => (
                                    <tr key={order.id} className="hover:bg-slate-50 transition-colors group">
                                        <td className="px-6 py-4 font-mono text-xs opacity-70">
                                            {new Date(order.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="px-6 py-4 font-medium text-slate-800">
                                            {order.nombre || 'Desconocido'}
                                            <div className="text-xs text-slate-400 font-normal">{order.cliente}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="px-2 py-1 rounded bg-slate-100 text-slate-600 text-xs font-semibold border border-slate-200">
                                                {order.producto}
                                            </span>
                                            {order.plan && (
                                                <span className="ml-2 text-xs text-slate-400">{order.plan}</span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 text-right font-mono text-slate-800 font-bold">
                                            ${order.precio}
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide border ${statusStyles[order.status] || statusStyles['Pendiente']}`}>
                                                {order.status || 'Pendiente'}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            {order.tracking ? (
                                                <span className="font-mono text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded border border-blue-200">
                                                    {order.tracking}
                                                </span>
                                            ) : (
                                                <span className="text-xs text-slate-300">—</span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <button
                                                onClick={() => openEdit(order)}
                                                className="text-blue-600 hover:text-blue-800 transition font-medium text-xs bg-blue-50 hover:bg-blue-100 px-3 py-1 rounded border border-blue-200"
                                            >
                                                Editar
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-slate-200 flex justify-between items-center text-xs text-slate-500 bg-slate-50/50">
                    <span>Mostrando {orders.length} registros</span>
                </div>
            </div>

            {/* EDIT ORDER MODAL */}
            {editingOrder && (
                <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center animate-fade-in">
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 border border-slate-200">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-lg font-bold text-slate-800">Editar Pedido</h3>
                            <button onClick={() => setEditingOrder(null)} className="text-slate-400 hover:text-slate-600 transition text-xl">✕</button>
                        </div>

                        <div className="space-y-4">
                            {/* Order Info */}
                            <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                                <p className="text-sm font-bold text-slate-700">{editingOrder.nombre || 'Sin nombre'}</p>
                                <p className="text-xs text-slate-500">{editingOrder.cliente}</p>
                                <p className="text-xs text-slate-400 mt-1">{editingOrder.producto} — ${editingOrder.precio}</p>
                            </div>

                            {/* Status */}
                            <div>
                                <label className="block text-xs font-bold text-slate-600 uppercase tracking-wide mb-1.5">Estado</label>
                                <select
                                    value={editStatus}
                                    onChange={(e) => setEditStatus(e.target.value)}
                                    className="w-full border border-slate-200 rounded-lg p-2.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 outline-none transition"
                                >
                                    {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                            </div>

                            {/* Tracking */}
                            <div>
                                <label className="block text-xs font-bold text-slate-600 uppercase tracking-wide mb-1.5">Código de Seguimiento</label>
                                <input
                                    type="text"
                                    value={editTracking}
                                    onChange={(e) => setEditTracking(e.target.value)}
                                    placeholder="Ej: CP123456789AR"
                                    className="w-full border border-slate-200 rounded-lg p-2.5 text-sm font-mono focus:ring-2 focus:ring-blue-500 outline-none transition"
                                />
                            </div>
                        </div>

                        <div className="flex gap-3 mt-6">
                            <button
                                onClick={() => setEditingOrder(null)}
                                className="flex-1 py-2.5 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={handleSaveEdit}
                                disabled={savingOrder}
                                className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition disabled:opacity-50"
                            >
                                {savingOrder ? 'Guardando...' : 'Guardar Cambios'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SalesView;
