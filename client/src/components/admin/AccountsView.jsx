import React, { useState, useEffect, useCallback } from 'react';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';
import { useSeller } from '../../context/SellerContext';
import {
    Users, Plus, Trash2, Edit2, X, Check, RefreshCw, Clock,
    Play, Square, RotateCcw, Wifi, WifiOff, AlertTriangle, Shield, User, KeyRound, Loader2,
    Key, Copy
} from 'lucide-react';

const EMPTY_FORM = { name: '', password: '', role: 'seller', sellerId: '' };

// Formats seconds → compact duration like "3h 14m", "2d 5h", "12m" or "45s".
function formatDuration(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return '0s';
    const s = Math.floor(totalSeconds);
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${secs}s`;
}

// Ticks every second while any account is currently online — cheap, keeps the
// "sesión actual" label accurate without hitting the API.
function useLiveClock(activeMs) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!activeMs) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [activeMs]);
    return now;
}

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

    // Refresh accounts every 30s so the accumulated "tiempo online" stays
    // current without manual reloads. Current-session ms ticks locally via
    // useLiveClock — no API call needed for that.
    useEffect(() => {
        const t = setInterval(() => { fetchData(); }, 30_000);
        return () => clearInterval(t);
    }, [fetchData]);

    // Any account currently online? If so, keep the live ticker alive.
    const anyOnlineSince = accounts.find(a => a.onlineSinceMs)?.onlineSinceMs || null;
    const nowMs = useLiveClock(anyOnlineSince);

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
                                            <OnlineTimeLine
                                                totalSeconds={acc.totalOnlineSeconds}
                                                onlineSinceMs={acc.onlineSinceMs}
                                                nowMs={nowMs}
                                            />
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
                                            <OnlineTimeLine
                                                totalSeconds={acc.totalOnlineSeconds}
                                                onlineSinceMs={acc.onlineSinceMs}
                                                nowMs={nowMs}
                                            />
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

                    <ApiTokensSection />
                </div>
            )}
        </div>
    );
};

// Small row shown under each account with total accumulated dashboard time
// and (when the user is online right now) a live ticker for the current session.
const OnlineTimeLine = ({ totalSeconds, onlineSinceMs, nowMs }) => {
    const currentSessionSec = onlineSinceMs ? Math.max(0, Math.floor((nowMs - onlineSinceMs) / 1000)) : 0;
    const displayTotal = (totalSeconds || 0) + currentSessionSec;
    return (
        <div className="flex items-center gap-1.5 mt-1 text-xs text-slate-400 dark:text-slate-500">
            <Clock className="w-3 h-3 flex-shrink-0" />
            <span title="Tiempo acumulado con el panel abierto">
                {formatDuration(displayTotal)} total
            </span>
            {onlineSinceMs && (
                <>
                    <span className="text-slate-300 dark:text-slate-600">•</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium" title="Sesión actual">
                        sesión: {formatDuration(currentSessionSec)}
                    </span>
                </>
            )}
        </div>
    );
};

// API Tokens section: managed below the accounts table. Tokens grant scope
// "analytics:read" only — used by external Claude Code instances etc.
// Plaintext is shown ONCE on creation, then only the prefix is visible.
const ApiTokensSection = () => {
    const { toast } = useToast();
    const [tokens, setTokens] = useState([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [newName, setNewName] = useState('');
    const [justCreated, setJustCreated] = useState(null); // { token, name, prefix }
    const [copied, setCopied] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get('/api/admin/api-tokens');
            setTokens(res.data || []);
        } catch (e) {
            toast.error('No se pudieron cargar los tokens');
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => { load(); }, [load]);

    const handleCreate = async (e) => {
        e?.preventDefault?.();
        if (!newName.trim() || newName.trim().length < 3) {
            toast.warning('El nombre debe tener al menos 3 caracteres');
            return;
        }
        setCreating(true);
        try {
            const res = await api.post('/api/admin/api-tokens', {
                name: newName.trim(),
                scopes: ['analytics:read'],
            });
            setJustCreated({ token: res.data.token, name: res.data.name, prefix: res.data.prefix });
            setNewName('');
            setShowCreateForm(false);
            load();
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error creando el token');
        } finally {
            setCreating(false);
        }
    };

    const handleRevoke = async (id, name) => {
        if (!confirm(`¿Revocar el token "${name}"? Cualquier app que lo use dejará de funcionar al instante.`)) return;
        try {
            await api.delete(`/api/admin/api-tokens/${id}`);
            toast.success('Token revocado');
            load();
        } catch (e) {
            toast.error('No se pudo revocar');
        }
    };

    const copyToClipboard = async (text) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (e) {
            toast.error('No se pudo copiar');
        }
    };

    const fmtDate = (d) => d ? new Date(d).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

    return (
        <section className="mt-8 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-5 sm:p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <Key className="w-5 h-5 text-indigo-500" />
                    <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">API Tokens</h2>
                </div>
                <button
                    onClick={() => setShowCreateForm(v => !v)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition-colors"
                >
                    <Plus className="w-4 h-4" /> Nuevo token
                </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                Tokens para acceso programático a <code>/api/analytics/*</code> (scope <code>analytics:read</code>).
                Útil para que un Claude Code externo o herramienta de marketing lea métricas sin necesidad de cuenta.
            </p>

            {showCreateForm && (
                <form onSubmit={handleCreate} className="mb-4 p-4 bg-slate-50 dark:bg-slate-900/40 rounded-xl border border-slate-200 dark:border-slate-700">
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Nombre descriptivo</label>
                    <input
                        type="text"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        placeholder='Ej: "Hermano - meta ads"'
                        className="w-full px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                        autoFocus
                    />
                    <div className="flex gap-2 mt-3">
                        <button type="submit" disabled={creating} className="px-4 py-1.5 text-sm font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50">
                            {creating ? 'Creando...' : 'Crear'}
                        </button>
                        <button type="button" onClick={() => { setShowCreateForm(false); setNewName(''); }} className="px-4 py-1.5 text-sm font-semibold rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200">
                            Cancelar
                        </button>
                    </div>
                </form>
            )}

            {justCreated && (
                <div className="mb-4 p-4 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-300 dark:border-emerald-800 rounded-xl">
                    <div className="flex items-start gap-2 mb-2">
                        <Check className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
                                Token creado: <span className="font-mono">{justCreated.name}</span>
                            </p>
                            <p className="text-xs text-emerald-800 dark:text-emerald-300 mt-1">
                                Copialo ahora — no vas a poder verlo de nuevo. Si lo perdés, hay que generar uno nuevo.
                            </p>
                        </div>
                        <button onClick={() => setJustCreated(null)} className="text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-800/30 p-1 rounded-md">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="flex items-center gap-2 mt-2 p-3 bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 rounded-lg">
                        <code className="flex-1 text-xs sm:text-sm font-mono text-slate-800 dark:text-slate-200 break-all">{justCreated.token}</code>
                        <button
                            onClick={() => copyToClipboard(justCreated.token)}
                            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                            <Copy className="w-3.5 h-3.5" /> {copied ? 'Copiado' : 'Copiar'}
                        </button>
                    </div>
                </div>
            )}

            {loading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 py-4">
                    <Loader2 className="w-4 h-4 animate-spin" /> Cargando tokens...
                </div>
            ) : tokens.length === 0 ? (
                <div className="text-sm text-slate-500 dark:text-slate-400 py-6 text-center bg-slate-50 dark:bg-slate-900/40 rounded-xl">
                    Sin tokens creados todavía.
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                                <th className="py-2 pr-3 font-semibold">Nombre</th>
                                <th className="py-2 pr-3 font-semibold">Token</th>
                                <th className="py-2 pr-3 font-semibold">Scopes</th>
                                <th className="py-2 pr-3 font-semibold">Creado</th>
                                <th className="py-2 pr-3 font-semibold">Último uso</th>
                                <th className="py-2 pr-3 font-semibold">Estado</th>
                                <th className="py-2"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {tokens.map(t => {
                                const revoked = !!t.revokedAt;
                                return (
                                    <tr key={t.id} className={`border-b border-slate-100 dark:border-slate-800 ${revoked ? 'opacity-50' : ''}`}>
                                        <td className="py-3 pr-3 font-medium text-slate-700 dark:text-slate-200">{t.name}</td>
                                        <td className="py-3 pr-3"><code className="text-xs font-mono text-slate-500 dark:text-slate-400">{t.prefix}…</code></td>
                                        <td className="py-3 pr-3 text-xs text-slate-500 dark:text-slate-400">{(t.scopes || []).join(', ')}</td>
                                        <td className="py-3 pr-3 text-xs text-slate-500 dark:text-slate-400">{fmtDate(t.createdAt)}</td>
                                        <td className="py-3 pr-3 text-xs text-slate-500 dark:text-slate-400">{fmtDate(t.lastUsedAt)}</td>
                                        <td className="py-3 pr-3">
                                            {revoked ? (
                                                <span className="text-xs px-2 py-0.5 rounded bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400">Revocado</span>
                                            ) : (
                                                <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">Activo</span>
                                            )}
                                        </td>
                                        <td className="py-3 text-right">
                                            {!revoked && (
                                                <button
                                                    onClick={() => handleRevoke(t.id, t.name)}
                                                    className="p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-md"
                                                    title="Revocar"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
};

export default AccountsView;
