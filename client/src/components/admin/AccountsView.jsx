import React, { useState, useEffect, useCallback } from 'react';
import {
    Users, Plus, Trash2, Edit2, Check, RefreshCw, Clock,
    Play, Square, RotateCcw, Shield, User, KeyRound, Loader2,
    Key, Copy
} from 'lucide-react';
import api from '../../config/axios';
import { useSeller } from '../../context/SellerContext';
import {
    Card, Button, IconButton, Badge, Input, Select, Modal, EmptyState, useToast, cn
} from '../ui';

const EMPTY_FORM = { name: '', password: '', role: 'seller', sellerId: '' };

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

// Tick cada segundo mientras haya cuentas online — barato, mantiene la
// "sesión actual" precisa sin hits a la API.
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
    const [pwModal, setPwModal] = useState(null);
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

    // Auto-refresh cada 30s para que el "tiempo online" acumulado se mantenga
    // actualizado sin recargas manuales. La sesión actual ticks vía useLiveClock.
    useEffect(() => {
        const t = setInterval(() => { fetchData(); }, 30_000);
        return () => clearInterval(t);
    }, [fetchData]);

    const anyOnlineSince = accounts.find(a => a.onlineSinceMs)?.onlineSinceMs || null;
    const nowMs = useLiveClock(anyOnlineSince);

    // Auto-generar sellerId desde el username cuando se crea una cuenta nueva.
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
        setSellerIdManuallyEdited(true);
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
            if (!payload.password) delete payload.password;
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
            loadSellers();
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

    const sellerMap = Object.fromEntries(sellers.map(s => [s.sellerId, s]));
    const sellerAccounts = accounts.filter(a => a.role === 'seller');
    const adminAccounts = accounts.filter(a => a.role === 'admin');

    return (
        <div className="w-full max-w-5xl mx-auto space-y-5">
            <header className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 rounded-card bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 flex items-center justify-center flex-shrink-0">
                        <Users className="w-5 h-5" aria-hidden="true" />
                    </div>
                    <div>
                        <h1 className="text-h2 text-slate-900 dark:text-slate-100">Gestión de usuarios</h1>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                            Vendedores y administradores de la plataforma.
                        </p>
                    </div>
                </div>
                <div className="flex gap-2">
                    <IconButton
                        label="Recargar"
                        icon={RefreshCw}
                        variant="ghost"
                        onClick={fetchData}
                        className={loading ? '[&_svg]:animate-spin' : ''}
                    />
                    <Button leftIcon={Plus} onClick={openCreate}>
                        Nueva cuenta
                    </Button>
                </div>
            </header>

            {loading ? (
                <Card padding="lg" className="flex items-center justify-center min-h-[200px]">
                    <div className="w-8 h-8 border-[3px] border-accent-200 dark:border-accent-900 border-t-accent-600 dark:border-t-accent-500 rounded-full animate-spin" />
                </Card>
            ) : (
                <div className="space-y-6">
                    {/* Vendedores */}
                    <section>
                        <h2 className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-1.5">
                            <User className="w-3.5 h-3.5" aria-hidden="true" />
                            Vendedores ({sellerAccounts.length})
                        </h2>
                        <div className="space-y-2">
                            {sellerAccounts.map(acc => (
                                <AccountRow
                                    key={acc.id}
                                    acc={acc}
                                    rt={acc.sellerId ? sellerMap[acc.sellerId] : null}
                                    onEdit={openEdit}
                                    onDelete={() => handleDelete(acc.id, acc.name)}
                                    onResetPw={() => { setPwModal({ id: acc.id, name: acc.name }); setNewPw(''); }}
                                    onSellerAction={sellerAction}
                                    actionLoading={actionLoading}
                                    nowMs={nowMs}
                                />
                            ))}
                            {sellerAccounts.length === 0 && (
                                <Card padding="md" className="border-dashed">
                                    <p className="text-center text-sm text-slate-500 dark:text-slate-400">
                                        No hay vendedores. Creá uno con "Nueva cuenta".
                                    </p>
                                </Card>
                            )}
                        </div>
                    </section>

                    {/* Administradores */}
                    <section>
                        <h2 className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-1.5">
                            <Shield className="w-3.5 h-3.5" aria-hidden="true" />
                            Administradores ({adminAccounts.length})
                        </h2>
                        <div className="space-y-2">
                            {adminAccounts.map(acc => (
                                <AccountRow
                                    key={acc.id}
                                    acc={acc}
                                    rt={acc.sellerId ? sellerMap[acc.sellerId] : null}
                                    isAdmin
                                    onEdit={openEdit}
                                    onDelete={() => handleDelete(acc.id, acc.name)}
                                    onResetPw={() => { setPwModal({ id: acc.id, name: acc.name }); setNewPw(''); }}
                                    onSellerAction={sellerAction}
                                    actionLoading={actionLoading}
                                    nowMs={nowMs}
                                />
                            ))}
                        </div>
                    </section>

                    <ApiTokensSection />
                </div>
            )}

            {/* Modal: crear/editar cuenta */}
            <Modal
                open={showForm}
                onClose={closeForm}
                title={editingId ? 'Editar cuenta' : 'Nueva cuenta'}
                size="md"
            >
                <form onSubmit={handleSave}>
                    <Modal.Body>
                        <div className="space-y-3">
                            <Input
                                label="Nombre de usuario"
                                type="text"
                                value={form.name}
                                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                                placeholder="ej: alejandra"
                                required
                                autoComplete="off"
                                helperText="Se usa para iniciar sesión."
                            />
                            <Input
                                label={editingId ? 'Nueva contraseña (vacío = no cambiar)' : 'Contraseña'}
                                type="password"
                                value={form.password}
                                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                                placeholder="••••••••"
                                required={!editingId}
                                minLength={8}
                            />
                            <Select
                                label="Rol"
                                value={form.role}
                                onChange={e => {
                                    setSellerIdManuallyEdited(false);
                                    setForm(f => ({ ...f, role: e.target.value }));
                                }}
                            >
                                <option value="seller">Vendedor</option>
                                <option value="admin">Administrador</option>
                            </Select>
                            <Input
                                label={`ID de instancia${form.role === 'admin' ? ' (opcional)' : ''}`}
                                type="text"
                                value={form.sellerId}
                                onChange={e => {
                                    setSellerIdManuallyEdited(true);
                                    setForm(f => ({ ...f, sellerId: e.target.value }));
                                }}
                                placeholder={form.role === 'admin' ? 'ej: denise_bot (vacío = sin WhatsApp)' : 'ej: alejandra_bot'}
                                required={form.role === 'seller'}
                                className="font-mono"
                                helperText={form.role === 'seller' ? 'Auto-generado — podés editarlo.' : 'Sin ID el admin no tendrá WhatsApp.'}
                            />
                        </div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button variant="secondary" type="button" onClick={closeForm}>
                            Cancelar
                        </Button>
                        <Button type="submit" loading={saving} leftIcon={Check}>
                            {editingId ? 'Guardar cambios' : 'Crear cuenta'}
                        </Button>
                    </Modal.Footer>
                </form>
            </Modal>

            {/* Modal: reset password */}
            <Modal
                open={!!pwModal}
                onClose={() => { setPwModal(null); setNewPw(''); }}
                title="Resetear contraseña"
                size="sm"
            >
                <form onSubmit={handleResetPassword}>
                    <Modal.Body>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                            Nueva contraseña para <strong className="text-slate-700 dark:text-slate-200 capitalize">{pwModal?.name}</strong>
                        </p>
                        <Input
                            type="password"
                            placeholder="Nueva contraseña (mín. 8 caracteres)"
                            value={newPw}
                            onChange={e => setNewPw(e.target.value)}
                            required
                            minLength={8}
                            autoFocus
                            leftIcon={KeyRound}
                            aria-label="Nueva contraseña"
                        />
                    </Modal.Body>
                    <Modal.Footer>
                        <Button variant="secondary" type="button" onClick={() => { setPwModal(null); setNewPw(''); }}>
                            Cancelar
                        </Button>
                        <Button type="submit" loading={pwSaving} leftIcon={Check}>
                            Guardar
                        </Button>
                    </Modal.Footer>
                </form>
            </Modal>
        </div>
    );
};

// ─── Sub-componentes ───────────────────────────────────────────

function AccountRow({ acc, rt, isAdmin, onEdit, onDelete, onResetPw, onSellerAction, actionLoading, nowMs }) {
    const isRunning = rt?.running;
    const isConnected = rt?.connected;

    return (
        <Card padding="md" className="flex items-center gap-3">
            {/* Avatar */}
            <div className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-base flex-shrink-0',
                isAdmin ? 'bg-warning-500' : 'bg-accent-600'
            )}>
                {acc.name.charAt(0).toUpperCase()}
            </div>

            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-semibold text-slate-900 dark:text-slate-100 text-sm capitalize truncate">{acc.name}</span>
                    {isAdmin && <Badge tone="warning" size="sm">Admin</Badge>}
                    {!acc.isActive && <Badge tone="danger" size="sm">Inactivo</Badge>}
                </div>
                {acc.sellerId && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-1.5">
                        <span className={cn(
                            'w-1.5 h-1.5 rounded-full flex-shrink-0',
                            isConnected ? 'bg-success-500' : isRunning ? 'bg-warning-500 animate-pulse' : 'bg-slate-300 dark:bg-slate-600'
                        )} />
                        {isConnected ? `Conectado${rt?.phoneNumber ? ` · +${rt.phoneNumber}` : ''}` : isRunning ? 'Iniciando…' : 'Sin sesión activa'}
                    </p>
                )}
                {!acc.sellerId && isAdmin && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Sin WhatsApp</p>
                )}
                <OnlineTimeLine
                    totalSeconds={acc.totalOnlineSeconds}
                    onlineSinceMs={acc.onlineSinceMs}
                    nowMs={nowMs}
                />
            </div>

            {/* Controles WA */}
            {acc.sellerId && (
                <div className="flex items-center gap-1">
                    {!isRunning ? (
                        <IconButton
                            label="Iniciar seller"
                            icon={Play}
                            variant="subtle"
                            size="sm"
                            onClick={() => onSellerAction(acc.sellerId, 'start')}
                            disabled={!!actionLoading[`${acc.sellerId}_start`]}
                            className={cn(
                                '!bg-success-50 dark:!bg-success-900/30 !text-success-600 dark:!text-success-500 hover:!bg-success-100',
                                actionLoading[`${acc.sellerId}_start`] && '[&_svg]:animate-spin'
                            )}
                        />
                    ) : (
                        <>
                            <IconButton
                                label="Reiniciar seller"
                                icon={RotateCcw}
                                variant="subtle"
                                size="sm"
                                onClick={() => onSellerAction(acc.sellerId, 'restart')}
                                disabled={!!actionLoading[`${acc.sellerId}_restart`]}
                                className={cn(
                                    '!bg-warning-50 dark:!bg-warning-900/30 !text-warning-600 dark:!text-warning-500 hover:!bg-warning-100',
                                    actionLoading[`${acc.sellerId}_restart`] && '[&_svg]:animate-spin'
                                )}
                            />
                            <IconButton
                                label="Detener seller"
                                icon={Square}
                                variant="subtle"
                                size="sm"
                                onClick={() => onSellerAction(acc.sellerId, 'stop')}
                                disabled={!!actionLoading[`${acc.sellerId}_stop`]}
                                className={cn(
                                    '!bg-danger-50 dark:!bg-danger-900/30 !text-danger-600 dark:!text-danger-500 hover:!bg-danger-100',
                                    actionLoading[`${acc.sellerId}_stop`] && '[&_svg]:animate-spin'
                                )}
                            />
                        </>
                    )}
                </div>
            )}

            {/* Controles cuenta */}
            <div className="flex items-center gap-1">
                <IconButton label="Cambiar contraseña" icon={KeyRound} variant="ghost" size="sm" onClick={onResetPw} />
                <IconButton label="Editar cuenta" icon={Edit2} variant="ghost" size="sm" onClick={() => onEdit(acc)} />
                <IconButton label="Desactivar cuenta" icon={Trash2} variant="danger" size="sm" onClick={onDelete} />
            </div>
        </Card>
    );
}

function OnlineTimeLine({ totalSeconds, onlineSinceMs, nowMs }) {
    const currentSessionSec = onlineSinceMs ? Math.max(0, Math.floor((nowMs - onlineSinceMs) / 1000)) : 0;
    const displayTotal = (totalSeconds || 0) + currentSessionSec;
    return (
        <div className="flex items-center gap-1.5 mt-1 text-xs text-slate-500 dark:text-slate-400">
            <Clock className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
            <span title="Tiempo acumulado con el panel abierto" className="tabular-nums">
                {formatDuration(displayTotal)} total
            </span>
            {onlineSinceMs && (
                <>
                    <span className="text-slate-300 dark:text-slate-600">·</span>
                    <span className="text-success-600 dark:text-success-500 font-medium tabular-nums" title="Sesión actual">
                        sesión: {formatDuration(currentSessionSec)}
                    </span>
                </>
            )}
        </div>
    );
}

// ─── API Tokens ────────────────────────────────────────────────

function ApiTokensSection() {
    const { toast } = useToast();
    const [tokens, setTokens] = useState([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [newName, setNewName] = useState('');
    const [justCreated, setJustCreated] = useState(null);
    const [copied, setCopied] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await api.get('/api/admin/api-tokens');
            setTokens(res.data || []);
        } catch {
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
        } catch { toast.error('No se pudo revocar'); }
    };

    const copyToClipboard = async (text) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { toast.error('No se pudo copiar'); }
    };

    const fmtDate = (d) => d
        ? new Date(d).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
        : '—';

    return (
        <Card padding="md" as="section">
            <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <Key className="w-4 h-4 text-accent-600 dark:text-accent-400" aria-hidden="true" />
                    API Tokens
                </h2>
                <Button size="sm" leftIcon={Plus} onClick={() => setShowCreateForm(v => !v)}>
                    Nuevo token
                </Button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                Tokens para acceso programático a <code className="text-[11px] bg-slate-100 dark:bg-slate-800 px-1 rounded">/api/analytics/*</code> (scope <code className="text-[11px] bg-slate-100 dark:bg-slate-800 px-1 rounded">analytics:read</code>).
                Útil para que herramientas externas lean métricas sin necesidad de cuenta.
            </p>

            {showCreateForm && (
                <form onSubmit={handleCreate} className="mb-4 p-3 bg-slate-50 dark:bg-slate-900/40 rounded-control border border-slate-200/70 dark:border-slate-700/70">
                    <Input
                        label="Nombre descriptivo"
                        type="text"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        placeholder='Ej: "Hermano · meta ads"'
                        autoFocus
                    />
                    <div className="flex gap-2 mt-3">
                        <Button size="sm" type="submit" loading={creating}>
                            Crear
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            type="button"
                            onClick={() => { setShowCreateForm(false); setNewName(''); }}
                        >
                            Cancelar
                        </Button>
                    </div>
                </form>
            )}

            {justCreated && (
                <div className="mb-4 p-3 rounded-control bg-success-50 dark:bg-success-900/20 border border-success-200 dark:border-success-900/40">
                    <div className="flex items-start gap-2 mb-2">
                        <Check className="w-4 h-4 text-success-600 dark:text-success-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-success-700 dark:text-success-500">
                                Token creado: <span className="font-mono">{justCreated.name}</span>
                            </p>
                            <p className="text-xs text-success-700/80 dark:text-success-500/80 mt-1">
                                Copialo ahora — no vas a poder verlo de nuevo. Si lo perdés, hay que generar uno nuevo.
                            </p>
                        </div>
                        <IconButton
                            label="Cerrar aviso"
                            variant="ghost"
                            size="sm"
                            onClick={() => setJustCreated(null)}
                        >
                            <span aria-hidden="true">✕</span>
                        </IconButton>
                    </div>
                    <div className="flex items-center gap-2 mt-2 p-2.5 bg-white dark:bg-slate-900 border border-success-200 dark:border-success-900/40 rounded-control">
                        <code className="flex-1 text-xs sm:text-sm font-mono text-slate-700 dark:text-slate-200 break-all">
                            {justCreated.token}
                        </code>
                        <Button
                            size="sm"
                            leftIcon={Copy}
                            onClick={() => copyToClipboard(justCreated.token)}
                            className="!bg-success-600 hover:!bg-success-700 flex-shrink-0"
                        >
                            {copied ? 'Copiado' : 'Copiar'}
                        </Button>
                    </div>
                </div>
            )}

            {loading ? (
                <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 py-4">
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    Cargando tokens…
                </div>
            ) : tokens.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400 py-6 text-center bg-slate-50 dark:bg-slate-900/40 rounded-control">
                    Sin tokens creados todavía.
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700 font-medium">
                                <th className="py-2 pr-3">Nombre</th>
                                <th className="py-2 pr-3">Token</th>
                                <th className="py-2 pr-3">Scopes</th>
                                <th className="py-2 pr-3">Creado</th>
                                <th className="py-2 pr-3">Último uso</th>
                                <th className="py-2 pr-3">Estado</th>
                                <th className="py-2 text-right" aria-label="Acciones" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {tokens.map(t => {
                                const revoked = !!t.revokedAt;
                                return (
                                    <tr key={t.id} className={cn(revoked && 'opacity-50')}>
                                        <td className="py-2.5 pr-3 font-medium text-sm text-slate-700 dark:text-slate-200">{t.name}</td>
                                        <td className="py-2.5 pr-3">
                                            <code className="text-xs font-mono text-slate-500 dark:text-slate-400">{t.prefix}…</code>
                                        </td>
                                        <td className="py-2.5 pr-3 text-xs text-slate-500 dark:text-slate-400">{(t.scopes || []).join(', ')}</td>
                                        <td className="py-2.5 pr-3 text-xs text-slate-500 dark:text-slate-400 tabular-nums">{fmtDate(t.createdAt)}</td>
                                        <td className="py-2.5 pr-3 text-xs text-slate-500 dark:text-slate-400 tabular-nums">{fmtDate(t.lastUsedAt)}</td>
                                        <td className="py-2.5 pr-3">
                                            <Badge tone={revoked ? 'danger' : 'success'} size="sm">
                                                {revoked ? 'Revocado' : 'Activo'}
                                            </Badge>
                                        </td>
                                        <td className="py-2.5 text-right">
                                            {!revoked && (
                                                <IconButton
                                                    label="Revocar token"
                                                    icon={Trash2}
                                                    variant="danger"
                                                    size="sm"
                                                    onClick={() => handleRevoke(t.id, t.name)}
                                                />
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </Card>
    );
}

export default AccountsView;
