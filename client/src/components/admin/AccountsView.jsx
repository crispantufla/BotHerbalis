import React, { useState, useEffect, useCallback } from 'react';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';
import { useSeller } from '../../context/SellerContext';
import {
    Users, Plus, Trash2, Edit2, X, Check, RefreshCw,
    Play, Square, RotateCcw, Wifi, WifiOff, AlertTriangle, Shield, User, KeyRound, Loader2
} from 'lucide-react';

const EMPTY_FORM = { name: '', password: '', role: 'seller', sellerId: '' };

const AccountsView = () => {
    const { toast } = useToast();
    const { loadSellers } = useSeller();
    const [accounts, setAccounts] = useState([]);
    const [sellers, setSellers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [actionLoading, setActionLoading] = useState({});
    const [sellerIdManuallyEdited, setSellerIdManuallyEdited] = useState(false);
    const [pwModal, setPwModal] = useState(null); // { id, name }
    const [newPw, setNewPw] = useState('');
    const [pwSaving, setPwSaving] = useState(false);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const [accRes, sellerRes] = await Promise.all([
                api.get('/api/accounts'),
                api.get('/api/sellers'),
            ]);
            setAccounts(accRes.data);
            setSellers(sellerRes.data);
        } catch (e) {
            toast.error('Error cargando datos: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    // Auto-generate sellerId from username when creating a new account with WhatsApp
    useEffect(() => {
        if (editingId || form.role === 'admin' || sellerIdManuallyEdited) return;
        if (!form.name) { setForm(f => ({ ...f, sellerId: '' })); return; }
        const base = form.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        const existingIds = new Set(accounts.map(a => a.sellerId).filter(Boolean));
        let candidate = `${base}_bot`;
        let i = 2;
        while (existingIds.has(candidate)) { candidate = `${base}_bot${i}`; i++; }
        setForm(f => ({ ...f, sellerId: candidate }));
    }, [form.name, form.role, editingId, sellerIdManuallyEdited, accounts]);

    const openCreate = () => {
        setEditingId(null);
        setSellerIdManuallyEdited(false);
        setForm(EMPTY_FORM);
        setShowForm(true);
    };
    const openEdit = (acc) => {
        setEditingId(acc.id);
        setSellerIdManuallyEdited(true); // Don't auto-overwrite on edit
        setForm({ name: acc.name, password: '', role: acc.role, sellerId: acc.sellerId || '' });
        setShowForm(true);
    };
    const closeForm = () => {
        setShowForm(false);
        setEditingId(null);
        setSellerIdManuallyEdited(false);
        setForm(EMPTY_FORM);
    };

    const handleSave = async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
            const payload = { ...form };
            if (!payload.password) delete payload.password; // Don't send empty password on edit
            if (!payload.sellerId) delete payload.sellerId;

            if (editingId) {
                await api.put(`/api/accounts/${editingId}`, payload);
                toast.success('Cuenta actualizada');
            } else {
                await api.post('/api/accounts', payload);
                toast.success('Cuenta creada');
            }
            closeForm();
            fetchData();
            loadSellers(); // Refresh seller list in SellerSelector too
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error guardando cuenta');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id, name) => {
        if (!window.confirm(`¿Desactivar la cuenta de "${name}"?`)) return;
        try {
            await api.delete(`/api/accounts/${id}`);
            toast.success('Cuenta desactivada');
            fetchData();
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error desactivando cuenta');
        }
    };

    const handleResetPassword = async (e) => {
        e.preventDefault();
        if (newPw.length < 8) return toast.error('Mínimo 8 caracteres');
        setPwSaving(true);
        try {
            await api.put(`/api/accounts/${pwModal.id}/password`, { newPassword: newPw });
            toast.success(`Contraseña de "${pwModal.name}" actualizada`);
            setPwModal(null);
            setNewPw('');
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error al cambiar contraseña');
        } finally {
            setPwSaving(false);
        }
    };

    const sellerAction = async (sellerId, action) => {
        const key = `${sellerId}_${action}`;
        setActionLoading(prev => ({ ...prev, [key]: true }));
        try {
            await api.post(`/api/sellers/${sellerId}/${action}`);
            toast.success(`Seller ${action === 'start' ? 'iniciado' : action === 'stop' ? 'detenido' : 'reiniciado'}`);
            setTimeout(() => { fetchData(); loadSellers(); }, 1500);
        } catch (e) {
            toast.error(e.response?.data?.error || `Error al ${action}`);
        } finally {
            setActionLoading(prev => ({ ...prev, [key]: false }));
        }
    };

    // Map sellerId → seller runtime info
    const sellerMap = Object.fromEntries(sellers.map(s => [s.sellerId, s]));

    const sellerAccounts = accounts.filter(a => a.role === 'seller');
    const adminAccounts = accounts.filter(a => a.role === 'admin');

    return (
        <div className="p-6 md:p-8 w-full max-w-5xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center">
                            <Users className="w-5 h-5 text-white" />
                        </div>
                        Gestión de Usuarios
                    </h2>
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Vendedores y administradores de la plataforma</p>
                </div>
                <div className="flex gap-2">
                    <button onClick={fetchData} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors" title="Recargar">
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={openCreate}
                        className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 text-white text-sm font-semibold rounded-xl shadow hover:shadow-md transition-all hover:-translate-y-0.5"
                    >
                        <Plus className="w-4 h-4" />
                        Nueva cuenta
                    </button>
                </div>
            </div>

            {/* Create/Edit Form Modal */}
            {showForm && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 dark:border-slate-700">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-700">
                            <h3 className="font-bold text-slate-800 dark:text-slate-100">
                                {editingId ? 'Editar cuenta' : 'Nueva cuenta'}
                            </h3>
                            <button onClick={closeForm} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleSave} className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Nombre de usuario</label>
                                <input
                                    type="text"
                                    value={form.name}
                                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-slate-700 dark:text-slate-200"
                                    placeholder="ej: alejandra"
                                    required
                                    autoComplete="off"
                                />
                                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Se usa para iniciar sesión</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                                    {editingId ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña'}
                                </label>
                                <input
                                    type="password"
                                    value={form.password}
                                    onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-slate-700 dark:text-slate-200"
                                    placeholder="••••••••"
                                    required={!editingId}
                                    minLength={8}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Rol</label>
                                <select
                                    value={form.role}
                                    onChange={e => {
                                        setSellerIdManuallyEdited(false);
                                        setForm(f => ({ ...f, role: e.target.value }));
                                    }}
                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-slate-700 dark:text-slate-200"
                                >
                                    <option value="seller">Vendedor</option>
                                    <option value="admin">Administrador</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                                    ID de Instancia {form.role === 'admin' && <span className="text-slate-400 font-normal">(opcional — sin ID no tendrá WhatsApp)</span>}
                                </label>
                                <input
                                    type="text"
                                    value={form.sellerId}
                                    onChange={e => {
                                        setSellerIdManuallyEdited(true);
                                        setForm(f => ({ ...f, sellerId: e.target.value }));
                                    }}
                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-slate-700 dark:text-slate-200 font-mono"
                                    placeholder={form.role === 'admin' ? 'ej: denise_bot (vacío = sin WhatsApp)' : 'ej: alejandra_bot'}
                                    required={form.role === 'seller'}
                                />
                                {form.role === 'seller' && <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Auto-generado — podés editarlo si querés</p>}
                            </div>
                            <div className="flex gap-3 pt-2">
                                <button type="button" onClick={closeForm} className="flex-1 px-4 py-2 border border-slate-200 dark:border-slate-600 rounded-xl text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
                                    Cancelar
                                </button>
                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 text-white text-sm font-semibold rounded-xl shadow hover:shadow-md transition-all disabled:opacity-50"
                                >
                                    {saving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check className="w-4 h-4" />}
                                    {editingId ? 'Guardar cambios' : 'Crear cuenta'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Reset Password Modal */}
            {pwModal && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm border border-slate-200 dark:border-slate-700">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-700">
                            <h3 className="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                                <KeyRound className="w-4 h-4 text-indigo-500" />
                                Resetear contraseña
                            </h3>
                            <button onClick={() => { setPwModal(null); setNewPw(''); }} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleResetPassword} className="p-6 space-y-4">
                            <p className="text-sm text-slate-500 dark:text-slate-400">
                                Nueva contraseña para <strong className="text-slate-700 dark:text-slate-200">{pwModal.name}</strong>
                            </p>
                            <input
                                type="password"
                                placeholder="Nueva contraseña (mín. 8 caracteres)"
                                value={newPw}
                                onChange={e => setNewPw(e.target.value)}
                                required
                                minLength={8}
                                autoFocus
                                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
                            />
                            <div className="flex gap-3">
                                <button type="button" onClick={() => { setPwModal(null); setNewPw(''); }} className="flex-1 px-4 py-2 border border-slate-200 dark:border-slate-600 rounded-xl text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
                                    Cancelar
                                </button>
                                <button type="submit" disabled={pwSaving} className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-500 to-purple-600 text-white text-sm font-semibold rounded-xl shadow hover:shadow-md transition-all disabled:opacity-50">
                                    {pwSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                    Guardar
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {loading ? (
                <div className="flex items-center justify-center py-20">
                    <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                </div>
            ) : (
                <div className="space-y-8">
                    {/* Sellers section */}
                    <section>
                        <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                            <User className="w-4 h-4" /> Vendedores ({sellerAccounts.length})
                        </h3>
                        <div className="space-y-3">
                            {sellerAccounts.map(acc => {
                                const rt = acc.sellerId ? sellerMap[acc.sellerId] : null;
                                const isRunning = rt?.running;
                                const isConnected = rt?.connected;
                                return (
                                    <div key={acc.id} className="flex items-center gap-4 p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                                        {/* Avatar */}
                                        <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-indigo-400 to-purple-500 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
                                            {acc.name.charAt(0).toUpperCase()}
                                        </div>
                                        {/* Info */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm truncate capitalize">{acc.name}</span>
                                                {!acc.isActive && <span className="text-xs bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-full">Inactivo</span>}
                                            </div>
                                            {acc.sellerId && (
                                                <div className="flex items-center gap-1.5 mt-1">
                                                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isConnected ? 'bg-emerald-500' : isRunning ? 'bg-amber-400' : 'bg-slate-300 dark:bg-slate-600'}`} />
                                                    <span className="text-xs text-slate-400 dark:text-slate-500">
                                                        {isConnected ? `Conectado${rt?.phoneNumber ? ` • +${rt.phoneNumber}` : ''}` : isRunning ? 'Iniciando...' : 'Sin sesión activa'}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                        {/* WA Controls */}
                                        {acc.sellerId && (
                                            <div className="flex items-center gap-1.5">
                                                {!isRunning ? (
                                                    <button
                                                        onClick={() => sellerAction(acc.sellerId, 'start')}
                                                        disabled={!!actionLoading[`${acc.sellerId}_start`]}
                                                        className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 transition-colors disabled:opacity-50"
                                                        title="Iniciar"
                                                    >
                                                        {actionLoading[`${acc.sellerId}_start`] ? <div className="w-3.5 h-3.5 border-2 border-emerald-600/30 border-t-emerald-600 rounded-full animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                                    </button>
                                                ) : (
                                                    <>
                                                        <button
                                                            onClick={() => sellerAction(acc.sellerId, 'restart')}
                                                            disabled={!!actionLoading[`${acc.sellerId}_restart`]}
                                                            className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-600 dark:text-amber-400 transition-colors disabled:opacity-50"
                                                            title="Reiniciar"
                                                        >
                                                            {actionLoading[`${acc.sellerId}_restart`] ? <div className="w-3.5 h-3.5 border-2 border-amber-600/30 border-t-amber-600 rounded-full animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                                                        </button>
                                                        <button
                                                            onClick={() => sellerAction(acc.sellerId, 'stop')}
                                                            disabled={!!actionLoading[`${acc.sellerId}_stop`]}
                                                            className="p-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-500 dark:text-red-400 transition-colors disabled:opacity-50"
                                                            title="Detener"
                                                        >
                                                            {actionLoading[`${acc.sellerId}_stop`] ? <div className="w-3.5 h-3.5 border-2 border-red-500/30 border-t-red-500 rounded-full animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                        {/* Account Controls */}
                                        <div className="flex items-center gap-1.5">
                                            <button onClick={() => { setPwModal({ id: acc.id, name: acc.name }); setNewPw(''); }} className="p-1.5 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-slate-400 hover:text-indigo-500 transition-colors" title="Cambiar contraseña">
                                                <KeyRound className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => openEdit(acc)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-indigo-500 transition-colors" title="Editar">
                                                <Edit2 className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => handleDelete(acc.id, acc.name)} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors" title="Desactivar">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                            {sellerAccounts.length === 0 && (
                                <div className="text-center py-8 text-slate-400 dark:text-slate-500 text-sm border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl">
                                    No hay vendedores. Crea uno con el botón "Nueva cuenta".
                                </div>
                            )}
                        </div>
                    </section>

                    {/* Admins section */}
                    <section>
                        <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                            <Shield className="w-4 h-4" /> Administradores ({adminAccounts.length})
                        </h3>
                        <div className="space-y-3">
                            {adminAccounts.map(acc => {
                                const rt = acc.sellerId ? sellerMap[acc.sellerId] : null;
                                const isRunning = rt?.running;
                                const isConnected = rt?.connected;
                                return (
                                    <div key={acc.id} className="flex items-center gap-4 p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                                        <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-amber-400 to-orange-500 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
                                            {acc.name.charAt(0).toUpperCase()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="font-semibold text-slate-800 dark:text-slate-100 text-sm truncate capitalize">{acc.name}</span>
                                                <span className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full font-medium">Admin</span>
                                                {!acc.isActive && <span className="text-xs bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-2 py-0.5 rounded-full">Inactivo</span>}
                                            </div>
                                            {acc.sellerId && (
                                                <div className="flex items-center gap-1.5 mt-1">
                                                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isConnected ? 'bg-emerald-500' : isRunning ? 'bg-amber-400' : 'bg-slate-300 dark:bg-slate-600'}`} />
                                                    <span className="text-xs text-slate-400 dark:text-slate-500">
                                                        {isConnected ? `Conectado${rt?.phoneNumber ? ` • +${rt.phoneNumber}` : ''}` : isRunning ? 'Iniciando...' : 'Sin sesión activa'}
                                                    </span>
                                                </div>
                                            )}
                                            {!acc.sellerId && (
                                                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Sin WhatsApp</p>
                                            )}
                                        </div>
                                        {/* WA Controls (only for admins with sellerId) */}
                                        {acc.sellerId && (
                                            <div className="flex items-center gap-1.5">
                                                {!isRunning ? (
                                                    <button
                                                        onClick={() => sellerAction(acc.sellerId, 'start')}
                                                        disabled={!!actionLoading[`${acc.sellerId}_start`]}
                                                        className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 transition-colors disabled:opacity-50"
                                                        title="Iniciar"
                                                    >
                                                        {actionLoading[`${acc.sellerId}_start`] ? <div className="w-3.5 h-3.5 border-2 border-emerald-600/30 border-t-emerald-600 rounded-full animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                                    </button>
                                                ) : (
                                                    <>
                                                        <button
                                                            onClick={() => sellerAction(acc.sellerId, 'restart')}
                                                            disabled={!!actionLoading[`${acc.sellerId}_restart`]}
                                                            className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-600 dark:text-amber-400 transition-colors disabled:opacity-50"
                                                            title="Reiniciar"
                                                        >
                                                            {actionLoading[`${acc.sellerId}_restart`] ? <div className="w-3.5 h-3.5 border-2 border-amber-600/30 border-t-amber-600 rounded-full animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                                                        </button>
                                                        <button
                                                            onClick={() => sellerAction(acc.sellerId, 'stop')}
                                                            disabled={!!actionLoading[`${acc.sellerId}_stop`]}
                                                            className="p-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-500 dark:text-red-400 transition-colors disabled:opacity-50"
                                                            title="Detener"
                                                        >
                                                            {actionLoading[`${acc.sellerId}_stop`] ? <div className="w-3.5 h-3.5 border-2 border-red-500/30 border-t-red-500 rounded-full animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                        {/* Account Controls */}
                                        <div className="flex items-center gap-1.5">
                                            <button onClick={() => { setPwModal({ id: acc.id, name: acc.name }); setNewPw(''); }} className="p-1.5 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-slate-400 hover:text-indigo-500 transition-colors" title="Cambiar contraseña">
                                                <KeyRound className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => openEdit(acc)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-indigo-500 transition-colors" title="Editar">
                                                <Edit2 className="w-4 h-4" />
                                            </button>
                                            <button onClick={() => handleDelete(acc.id, acc.name)} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors" title="Desactivar">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                </div>
            )}
        </div>
    );
};

export default AccountsView;
