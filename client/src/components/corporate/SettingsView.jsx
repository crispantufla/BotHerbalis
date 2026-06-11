import React, { useState, useEffect } from 'react';
import {
    FileText, Power, Trash2, HardDrive, RefreshCw, KeyRound, RotateCcw, Lock, Download, Laptop, History
} from 'lucide-react';
import api from '../../config/axios';
import { useSocket } from '../../context/SocketContext';
import PriceEditor from '../PriceEditor';
import {
    Button, IconButton, Card, Badge, Input, useToast, cn
} from '../ui';

// V7 es el único guion activo desde may-2026. V5/V6 (+ rotación A/B) fueron
// archivados a archive/ — se conserva el array como SCRIPTS por si en el
// futuro se reactivara otra variante, pero hoy queda con un único item.
const SCRIPTS = [
    { id: 'v7', name: 'V7 · Elena (2 tiers)', desc: 'Persona Elena. 2 tiers (hasta 10 kg → 60d, +10 kg → 120d). Tras pedir kilos manda recomendación + precios en mensajes seguidos.', tone: 'info' },
];

const SettingsView = ({ status }) => {
    const { socket } = useSocket();
    const { toast, confirm } = useToast();

    const [activeScript, setActiveScript] = useState('v7');
    const [scriptStats, setScriptStats] = useState({});
    const [switchingScript, setSwitchingScript] = useState(false);
    const [resettingStats, setResettingStats] = useState(false);

    const [memStats, setMemStats] = useState(null);
    const [loadingMem, setLoadingMem] = useState(false);
    const [resetting, setResetting] = useState(false);

    const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
    const [pwSaving, setPwSaving] = useState(false);

    const [downloadingAgent, setDownloadingAgent] = useState(false);

    const [recoverOldChats, setRecoverOldChats] = useState(false);
    const [togglingRecover, setTogglingRecover] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const scriptRes = await api.get('/api/script/active');
                if (scriptRes.data.active) setActiveScript(scriptRes.data.active);
                if (scriptRes.data.stats) setScriptStats(scriptRes.data.stats);
            } catch (e) { console.error('Error loading script info:', e); }
            try {
                const recRes = await api.get('/api/config/recover-old-chats');
                setRecoverOldChats(!!recRes.data.recoverOldChats);
            } catch (e) { console.error('Error loading recover-old-chats:', e); }
        })();
        fetchMemoryStats();
    }, []);

    const fetchMemoryStats = async () => {
        setLoadingMem(true);
        try {
            const res = await api.get('/api/memory-stats');
            setMemStats(res.data);
        } catch (e) { console.error('Error loading memory stats:', e); }
        setLoadingMem(false);
    };

    useEffect(() => {
        if (!socket) return;
        const onScriptChanged = (data) => { if (data.active) setActiveScript(data.active); };
        const onMemoryReset = () => fetchMemoryStats();
        const onStatsReset = (data) => { if (data?.stats) setScriptStats(data.stats); };
        const onRecoverChanged = (data) => { if (typeof data?.recoverOldChats === 'boolean') setRecoverOldChats(data.recoverOldChats); };
        socket.on('script_changed', onScriptChanged);
        socket.on('memory_reset', onMemoryReset);
        socket.on('script_stats_reset', onStatsReset);
        socket.on('recover_old_chats_changed', onRecoverChanged);
        return () => {
            socket.off('script_changed', onScriptChanged);
            socket.off('memory_reset', onMemoryReset);
            socket.off('script_stats_reset', onStatsReset);
            socket.off('recover_old_chats_changed', onRecoverChanged);
        };
    }, [socket]);

    const handleLogout = async () => {
        const ok = await confirm('ATENCIÓN: Esto desconectará el bot de WhatsApp.\n\nEl sistema dejará de responder mensajes automáticamente y deberás escanear el QR nuevamente.\n\n¿Estás seguro?');
        if (!ok) return;
        try {
            await api.post('/api/whatsapp-logout');
            toast.success('Sesión cerrada. Escaneá el QR para reconectar.');
        } catch { toast.error('Error al cerrar sesión'); }
    };

    // Descarga el instalador del agente (un .bat autocontenido) para este seller.
    // La descarga va con el JWT (axios interceptor), así que no sirve un <a href>:
    // pedimos el blob y lo disparamos a mano. El error del backend viene como blob.
    const handleDownloadInstaller = async () => {
        setDownloadingAgent(true);
        try {
            const res = await api.get('/api/agent/installer', { responseType: 'blob' });
            const cd = res.headers['content-disposition'] || '';
            const m = cd.match(/filename="?([^"]+)"?/);
            const filename = m ? m[1] : 'Instalar Bot Herbalis.bat';
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
            toast.success('Instalador descargado. Copialo a la PC del vendedor y hacé doble click.');
        } catch (e) {
            let msg = 'Error al generar el instalador';
            try { const t = await e.response?.data?.text?.(); if (t) msg = JSON.parse(t).error || msg; } catch { /* blob no-json */ }
            toast.error(msg);
        }
        setDownloadingAgent(false);
    };

    const handleToggleRecover = async () => {
        if (togglingRecover) return;
        const next = !recoverOldChats;
        setTogglingRecover(true);
        // Optimista: reflejamos el cambio ya; revertimos si el backend falla.
        setRecoverOldChats(next);
        try {
            await api.post('/api/config/recover-old-chats', { enabled: next });
            toast.success(next
                ? 'Recuperación de chats antiguos activada.'
                : 'Recuperación de chats antiguos desactivada.');
        } catch (e) {
            setRecoverOldChats(!next);
            toast.error(e.response?.data?.error || 'Error al cambiar el ajuste');
        }
        setTogglingRecover(false);
    };

    const handleResetMemory = async () => {
        const ok = await confirm('¿Limpiar historial de usuarios inactivos?\n\nBorra mensajes y datos extraídos por IA de quienes no compraron y no interactuaron en las últimas 48h. Los usuarios siguen en la base, las ventas no se tocan.');
        if (!ok) return;
        setResetting(true);
        try {
            const res = await api.post('/api/reset-memory');
            const msg = res.data.deletedChats > 0
                ? `${res.data.deletedChats} mensajes archivados · ${res.data.protected48h} usuarios activos protegidos`
                : `Sin nada para limpiar · ${res.data.protected48h} usuarios activos`;
            toast.success(msg);
            fetchMemoryStats();
        } catch { toast.error('Error al limpiar el historial'); }
        setResetting(false);
    };

    // handleTestReport y jsPDF eliminados con el card "Generar PDF". Si se
    // necesita reportes en el futuro hay que volver a importar jsPDF y agregar
    // el handler — está en el historial git.

    const handleResetScriptStats = async () => {
        const ok = await confirm('¿Reiniciar contadores de conversión del guion?\n\nEmpiezan de cero. Útil cuando los guiones cambiaron y los números viejos ya no son comparables. No afecta ventas ni pedidos.');
        if (!ok) return;
        setResettingStats(true);
        try {
            const res = await api.post('/api/script/stats/reset');
            setScriptStats(res.data.stats || {});
            toast.success('Contadores reiniciados.');
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error al reiniciar contadores');
        }
        setResettingStats(false);
    };

    const handleSwitchScript = async (scriptKey) => {
        if (scriptKey === activeScript || switchingScript) return;
        setSwitchingScript(true);
        try {
            await api.post('/api/script/switch', { script: scriptKey });
            setActiveScript(scriptKey);
            toast.success('Modelo cambiado correctamente.');
        } catch { toast.error('Error al cambiar el guión'); }
        setSwitchingScript(false);
    };

    const handleChangePassword = async (e) => {
        e.preventDefault();
        if (pwForm.next !== pwForm.confirm) return toast.error('Las contraseñas nuevas no coinciden');
        if (pwForm.next.length < 8)         return toast.error('La nueva contraseña debe tener al menos 8 caracteres');
        setPwSaving(true);
        try {
            await api.post('/api/change-password', { currentPassword: pwForm.current, newPassword: pwForm.next });
            toast.success('Contraseña cambiada correctamente');
            setPwForm({ current: '', next: '', confirm: '' });
        } catch (e) {
            toast.error(e.response?.data?.error || 'Error al cambiar contraseña');
        } finally {
            setPwSaving(false);
        }
    };

    // El backend devuelve dos métricas independientes: RSS del proceso y total
    // de filas en User. Mostramos las dos como barras separadas para que el
    // operador vea cuál de las dos disparó el alerta — antes una sola barra
    // basada en users quedaba en rojo después de limpiar (el botón limpia
    // ChatLogs, no users).
    const rssLevel = !memStats ? 'unknown'
        : memStats.rssMB >= memStats.thresholds.rssCritMB ? 'critical'
        : memStats.rssMB >= memStats.thresholds.rssWarnMB ? 'warning'
        : 'healthy';
    const usersLevel = !memStats ? 'unknown'
        : memStats.totalUsersDB >= memStats.thresholds.danger ? 'critical'
        : memStats.totalUsersDB >= memStats.thresholds.warn ? 'warning'
        : 'healthy';

    const levelColor = (lvl) => ({
        critical: 'bg-danger-500',
        warning:  'bg-warning-500',
        healthy:  'bg-success-500',
        unknown:  'bg-slate-400',
    }[lvl]);

    const rssPercent = !memStats?.thresholds?.rssCritMB
        ? 0 : Math.min(100, Math.round((memStats.rssMB / memStats.thresholds.rssCritMB) * 100));
    const usersPercent = !memStats
        ? 0 : Math.min(100, Math.round((memStats.totalUsersDB / memStats.thresholds.danger) * 100));

    const memoryStatus = (() => {
        if (!memStats) return { tone: 'neutral', label: 'Cargando…' };
        const reasons = memStats.reasons || [];
        if (memStats.recommendation === 'critical') {
            return {
                tone: 'danger',
                label: reasons.includes('rss') ? 'RAM del proceso alta' : 'Base de datos llena',
            };
        }
        if (memStats.recommendation === 'warning') {
            return {
                tone: 'warning',
                label: reasons.includes('rss') ? 'RAM del proceso moderada' : 'Base de datos creciendo',
            };
        }
        return { tone: 'success', label: 'Sistema saludable' };
    })();

    return (
        <div className="space-y-4 sm:space-y-6 animate-fade-in pb-12">
            {/* Header */}
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
                <div>
                    <h1 className="text-display text-slate-900 dark:text-slate-100">Configuración base</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        Parámetros del sistema, precios y modelos de IA.
                    </p>
                </div>
                <Badge tone={status === 'ready' ? 'success' : 'danger'} dot size="lg">
                    {status === 'ready' ? 'Sistema online' : 'Sistema offline'}
                </Badge>
            </header>

            {/* Layout: Editor de Precios (col izq, alto) + stack Modelos+Password
                (col der, apilados a la misma altura total). Antes col2 quedaba
                con mucho whitespace porque cada card era altura natural y el
                grid no las balanceaba. */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6">
                {/* Col 1: Precios */}
                <Card padding="md">
                    <PriceEditor />
                </Card>

                {/* Col 2: stack vertical (Modelos + Password) */}
                <div className="flex flex-col gap-4 sm:gap-6">
                <Card padding="md">
                    <div className="flex items-center justify-between gap-3 mb-4">
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded-control bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center flex-shrink-0">
                                <FileText className="w-5 h-5" aria-hidden="true" />
                            </div>
                            <div className="min-w-0">
                                <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-sm">Modelos de venta (A/B)</h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Rotación y asignación</p>
                            </div>
                        </div>
                        <Button
                            size="sm"
                            variant="ghost"
                            leftIcon={resettingStats ? RefreshCw : RotateCcw}
                            onClick={handleResetScriptStats}
                            disabled={resettingStats}
                            className={resettingStats ? '[&_svg]:animate-spin' : ''}
                        >
                            <span className="hidden sm:inline">Reiniciar conteo</span>
                        </Button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {SCRIPTS.map(script => {
                            const stats = scriptStats[script.id];
                            const isActive = activeScript === script.id;
                            return (
                                <button
                                    key={script.id}
                                    type="button"
                                    onClick={() => handleSwitchScript(script.id)}
                                    className={cn(
                                        'p-3 rounded-control border text-left transition-all',
                                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                                        isActive
                                            ? 'border-accent-500 bg-accent-50/50 dark:bg-accent-900/15 shadow-card-hover'
                                            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 hover:border-accent-300 dark:hover:border-accent-700',
                                        SCRIPTS.length === 1 && 'sm:col-span-2'
                                    )}
                                >
                                    <div className="flex items-start gap-2 mb-2">
                                        <span className={cn(
                                            'w-2 h-2 rounded-full mt-1.5 flex-shrink-0',
                                            isActive ? `${levelColor('healthy')} animate-pulse` : 'bg-slate-300 dark:bg-slate-600'
                                        )} />
                                        <div className="flex-1 min-w-0">
                                            <p className="font-semibold text-sm text-slate-900 dark:text-slate-100">{script.name}</p>
                                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">{script.desc}</p>
                                        </div>
                                        {isActive && <Badge tone="accent" size="sm">Activo</Badge>}
                                    </div>
                                    {stats && (
                                        <div className="bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-700/60 rounded-control px-2 py-1.5 flex items-center justify-between">
                                            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Conversión</span>
                                            <span className={cn(
                                                'text-xs font-mono font-semibold tabular-nums',
                                                isActive ? 'text-accent-600 dark:text-accent-400' : 'text-slate-700 dark:text-slate-300'
                                            )}>
                                                {stats.started > 0 ? Math.round((stats.completed / stats.started) * 100) : 0}%
                                                <span className="text-[10px] text-slate-400 dark:text-slate-500 font-normal ml-1">
                                                    ({stats.completed}/{stats.started})
                                                </span>
                                            </span>
                                        </div>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </Card>

                {/* Cambiar contraseña */}
                <Card padding="md">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-10 h-10 rounded-control bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 flex items-center justify-center flex-shrink-0">
                            <KeyRound className="w-5 h-5" aria-hidden="true" />
                        </div>
                        <div>
                            <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-sm">Cambiar contraseña</h3>
                            <p className="text-xs text-slate-500 dark:text-slate-400">Tu cuenta</p>
                        </div>
                    </div>
                    <form onSubmit={handleChangePassword} className="space-y-2.5">
                        <Input
                            type="password"
                            placeholder="Contraseña actual"
                            value={pwForm.current}
                            onChange={e => setPwForm(f => ({ ...f, current: e.target.value }))}
                            required
                            leftIcon={Lock}
                            aria-label="Contraseña actual"
                            autoComplete="current-password"
                        />
                        <Input
                            type="password"
                            placeholder="Nueva contraseña (mín. 8 caracteres)"
                            value={pwForm.next}
                            onChange={e => setPwForm(f => ({ ...f, next: e.target.value }))}
                            required
                            minLength={8}
                            leftIcon={KeyRound}
                            aria-label="Nueva contraseña"
                            autoComplete="new-password"
                        />
                        <Input
                            type="password"
                            placeholder="Repetir nueva contraseña"
                            value={pwForm.confirm}
                            onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                            required
                            leftIcon={KeyRound}
                            aria-label="Repetir nueva contraseña"
                            autoComplete="new-password"
                        />
                        <Button type="submit" loading={pwSaving} leftIcon={KeyRound} fullWidth>
                            Cambiar contraseña
                        </Button>
                    </form>
                </Card>

                {/* Recuperación de chats antiguos (anti-bloqueo Meta). Va dentro
                    del stack de la col 2 para rellenar el hueco bajo "Cambiar
                    contraseña" (el PriceEditor de la izquierda es más alto).
                    flex-1 + flex-col: la card crece hasta el fondo y el toggle
                    queda anclado abajo, sin dejar aire. */}
                <Card padding="md" className="flex-1 flex flex-col">
                    <div className="flex items-start gap-3 min-w-0 mb-3">
                        <div className="w-10 h-10 rounded-control bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 flex items-center justify-center flex-shrink-0">
                            <History className="w-5 h-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                            <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-sm mb-1">
                                Recuperación de chats antiguos
                            </h3>
                            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                                Cuando está activada, el panel le pide a WhatsApp <strong>todo el historial
                                de conversaciones</strong> del teléfono. En números nuevos esa lectura masiva
                                puede hacer que Meta marque la cuenta. Con esta opción <strong>apagada</strong> el
                                panel solo muestra los chats que el bot ya atendió; el bot sigue respondiendo
                                normalmente a los mensajes nuevos.
                            </p>
                        </div>
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-3 pt-3 border-t border-slate-200/70 dark:border-slate-700/70">
                        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                            {recoverOldChats ? 'Activada' : 'Desactivada'}
                            <span className="text-[11px] text-slate-400 dark:text-slate-500 font-normal ml-1.5">
                                (recomendado: apagada en números nuevos)
                            </span>
                        </span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={recoverOldChats}
                            aria-label="Recuperación de chats antiguos"
                            onClick={handleToggleRecover}
                            disabled={togglingRecover}
                            className={cn(
                                'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors',
                                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                                recoverOldChats ? 'bg-accent-500' : 'bg-slate-300 dark:bg-slate-600'
                            )}
                        >
                            <span className={cn(
                                'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform mt-0.5',
                                recoverOldChats ? 'translate-x-[22px]' : 'translate-x-0.5'
                            )} />
                        </button>
                    </div>
                </Card>
                </div>
                {/* /Col 2 stack */}

                {/* Card "Herramientas / Generar PDF" eliminado a pedido. */}

                {/* Cliente del bot — instalador para la PC del vendedor.
                    col-span-1: comparte fila con "Interrupción fuerte" (ambas
                    son cards de acción cortas; a ancho completo desperdiciaban
                    media fila cada una). */}
                <Card padding="md" className="flex flex-col">
                    <div className="flex items-stretch gap-3 flex-1">
                        <div className="w-10 h-10 rounded-control bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 flex items-center justify-center flex-shrink-0">
                            <Laptop className="w-5 h-5" aria-hidden="true" />
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col">
                            <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-sm mb-1">
                                Cliente del bot (PC del vendedor)
                            </h3>
                            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mb-4 max-w-md">
                                Descargá el instalador y copialo a la PC del vendedor. Con un doble click deja
                                todo listo: instala lo necesario, conecta con el servidor y crea el acceso
                                directo en el escritorio. Después se actualiza solo.
                            </p>
                            <div className="mt-auto">
                                <Button
                                    variant="primary"
                                    leftIcon={Download}
                                    onClick={handleDownloadInstaller}
                                    disabled={downloadingAgent}
                                    className={downloadingAgent ? '[&_svg]:animate-pulse' : ''}
                                >
                                    {downloadingAgent ? 'Generando…' : 'Descargar cliente'}
                                </Button>
                            </div>
                        </div>
                    </div>
                </Card>

                {/* Danger zone — col-span-1, comparte fila con "Cliente del bot". */}
                <Card padding="md" className="border-danger-200/70 dark:border-danger-900/40 flex flex-col">
                    <div className="flex items-stretch gap-3 flex-1">
                        <div className="w-10 h-10 rounded-control bg-danger-50 dark:bg-danger-900/30 text-danger-600 dark:text-danger-500 flex items-center justify-center flex-shrink-0">
                            <Power className="w-5 h-5" aria-hidden="true" />
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col">
                            <h3 className="font-semibold text-danger-700 dark:text-danger-500 text-sm mb-1">
                                Interrupción fuerte
                            </h3>
                            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mb-4 max-w-md">
                                Cerrar la sesión desconecta inmediatamente el dispositivo vinculado de WhatsApp.
                                Ningún mensaje será respondido luego de esta acción.
                            </p>
                            <div className="mt-auto">
                                <Button variant="danger" leftIcon={Power} onClick={handleLogout}>
                                    Forzar desconexión
                                </Button>
                            </div>
                        </div>
                    </div>
                </Card>

                {/* Memory panel (full width) */}
                <Card padding="md" className="xl:col-span-2">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-control bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400 flex items-center justify-center flex-shrink-0">
                                <HardDrive className="w-5 h-5" aria-hidden="true" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-sm">Gestión de memoria</h3>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Estados de conversación</p>
                            </div>
                        </div>
                        <IconButton
                            label="Actualizar estadísticas"
                            icon={RefreshCw}
                            variant="ghost"
                            size="sm"
                            onClick={fetchMemoryStats}
                            className={loadingMem ? '[&_svg]:animate-spin' : ''}
                        />
                    </div>

                    {memStats ? (
                        <div className="space-y-4">
                            <Badge tone={memoryStatus.tone} dot size="md">{memoryStatus.label}</Badge>

                            {/* RSS bar */}
                            <div>
                                <div className="flex justify-between text-xs mb-2">
                                    <span className="font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                                        RAM del proceso
                                        <span className={cn('w-1.5 h-1.5 rounded-full', levelColor(rssLevel))} />
                                    </span>
                                    <span className="font-mono text-slate-600 dark:text-slate-400 tabular-nums">
                                        {(memStats.rssMB / 1024).toFixed(1)} GB / 32 GB
                                    </span>
                                </div>
                                <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-2.5 overflow-hidden">
                                    <div
                                        className={cn('h-full rounded-full transition-all duration-700', levelColor(rssLevel))}
                                        style={{ width: `${Math.max(3, rssPercent)}%` }}
                                    />
                                </div>
                                <div className="flex justify-between text-[11px] text-slate-500 dark:text-slate-400 mt-1 tabular-nums">
                                    <span>0</span>
                                    <span className="text-warning-600 dark:text-warning-500">⚠ {(memStats.thresholds.rssWarnMB / 1024).toFixed(0)} GB</span>
                                    <span className="text-danger-600 dark:text-danger-500">{(memStats.thresholds.rssCritMB / 1024).toFixed(0)} GB</span>
                                </div>
                            </div>

                            {/* Users bar */}
                            <div>
                                <div className="flex justify-between text-xs mb-2">
                                    <span className="font-medium text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                                        Usuarios en base de datos
                                        <span className={cn('w-1.5 h-1.5 rounded-full', levelColor(usersLevel))} />
                                    </span>
                                    <span className="font-mono text-slate-600 dark:text-slate-400 tabular-nums">
                                        {memStats.totalUsersDB.toLocaleString()}
                                    </span>
                                </div>
                                <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-2.5 overflow-hidden">
                                    <div
                                        className={cn('h-full rounded-full transition-all duration-700', levelColor(usersLevel))}
                                        style={{ width: `${Math.max(3, usersPercent)}%` }}
                                    />
                                </div>
                                <div className="flex justify-between text-[11px] text-slate-500 dark:text-slate-400 mt-1 tabular-nums">
                                    <span>0</span>
                                    <span className="text-warning-600 dark:text-warning-500">⚠ {memStats.thresholds.warn.toLocaleString()}</span>
                                    <span className="text-danger-600 dark:text-danger-500">{memStats.thresholds.danger.toLocaleString()}</span>
                                </div>
                            </div>

                            {/* Stats grid */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                {[
                                    { value: memStats.totalUsersDB.toLocaleString(), label: 'Base de datos' },
                                    { value: memStats.ramUsers,                       label: 'En RAM' },
                                    { value: memStats.activeConversations,            label: 'Activos ahora' },
                                    { value: `${memStats.heapUsedMB} MB`,             label: 'Heap V8' },
                                ].map((stat, i) => (
                                    <div key={i} className="bg-slate-50 dark:bg-slate-900/40 rounded-control p-3 text-center border border-slate-200/70 dark:border-slate-700/70">
                                        <p className="text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">{stat.value}</p>
                                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-snug">{stat.label}</p>
                                    </div>
                                ))}
                            </div>

                            {/* Info — qué hace el botón */}
                            <div className="bg-slate-50 dark:bg-slate-900/40 border border-slate-200/70 dark:border-slate-700/70 rounded-control p-3 space-y-1.5">
                                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                                    <strong>Qué hace este botón:</strong> borra el historial de chat
                                    (<code className="text-[11px] bg-slate-200 dark:bg-slate-800 px-1 rounded">ChatLog</code>)
                                    y los datos extraídos por IA (<code className="text-[11px] bg-slate-200 dark:bg-slate-800 px-1 rounded">profileData</code>)
                                    de usuarios <strong>inactivos &gt;48h y sin pedidos</strong>.
                                </p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                                    <strong>NO borra usuarios</strong> de la tabla <code className="text-[11px] bg-slate-200 dark:bg-slate-800 px-1 rounded">User</code>:
                                    el contador "Base de datos" se mantendrá igual. Las ventas y pedidos <strong>nunca</strong> se tocan.
                                </p>
                            </div>

                            <Button
                                onClick={handleResetMemory}
                                loading={resetting}
                                leftIcon={Trash2}
                                fullWidth
                            >
                                Limpiar historial inactivo (&gt;48h)
                            </Button>
                        </div>
                    ) : (
                        <div className="flex items-center justify-center py-10 gap-2">
                            <RefreshCw className="w-4 h-4 animate-spin text-slate-400 dark:text-slate-500" aria-hidden="true" />
                            <span className="text-sm text-slate-500 dark:text-slate-400">Cargando estadísticas…</span>
                        </div>
                    )}
                </Card>
            </div>
        </div>
    );
};

export default SettingsView;
