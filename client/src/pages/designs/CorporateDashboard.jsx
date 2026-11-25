import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import api from '../../config/axios';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';
import { useSeller } from '../../context/SellerContext';
import { useToast } from '../../components/ui/Toast';
import { useTheme } from '../../context/ThemeContext';

import DashboardView from '../../components/corporate/DashboardView';
import CommsView from '../../components/corporate/CommsView';
import ManualOrderEntryModal from '../../components/corporate/components/ManualOrderEntryModal';
import LazyBoundary from '../../components/ui/LazyBoundary';

import { Gift, Wifi, MessageCircle, ShoppingCart, Settings, ImageIcon, LogOut, Menu, X, Moon, Sun, BarChart2, Activity, Bell, AlertTriangle, BookOpen, MoreHorizontal, CreditCard, Users, LifeBuoy, MessagesSquare, FlaskConical, Package } from 'lucide-react';

// Con el panel bajan solo Inicio y el chat (lo que se abre siempre). El resto de
// las vistas se descarga al abrir su pestaña; Estadísticas además trae recharts
// (~400 KB).
const AdvancedAnalyticsView = lazy(() => import('../../components/corporate/AdvancedAnalyticsView'));
const SalesView = lazy(() => import('../../components/corporate/SalesView'));
const SettingsView = lazy(() => import('../../components/corporate/SettingsView'));
const GalleryView = lazy(() => import('../../components/corporate/GalleryView'));
const ManualsView = lazy(() => import('../../components/corporate/ManualsView'));
const PaymentsView = lazy(() => import('../../components/corporate/PaymentsView'));
const WebOrdersView = lazy(() => import('../../components/corporate/WebOrdersView'));
const AiReportsView = lazy(() => import('../../components/corporate/AiReportsView'));
const GuionView = lazy(() => import('../../components/corporate/GuionView'));
const PlaygroundView = lazy(() => import('../../components/corporate/PlaygroundView'));
const PromoView = lazy(() => import('../../components/corporate/PromoView'));
const AccountsView = lazy(() => import('../../components/admin/AccountsView'));
const AccountStatsView = lazy(() => import('../../components/admin/AccountStatsView'));
const FunnelAnalyticsView = lazy(() => import('../../components/admin/FunnelAnalyticsView'));
const RescueQueueView = lazy(() => import('../../components/admin/RescueQueueView'));

// Nombre de cada pestaña para el aviso de "no se pudo cargar".
const TAB_NAMES = {
    statistics: 'Estadísticas',
    logistics: 'Ventas',
    gallery: 'Galería',
    manuals: 'Manuales',
    settings: 'Configuración',
    payments: 'Pagos MP',
    'web-orders': 'Pedidos web',
    'ai-reports': 'Errores de IA',
    guion: 'Guiones',
    playground: 'Probar bot',
    promos: 'Promos',
    accounts: 'Usuarios',
    'account-stats': 'Horas Vendedores',
    'funnel-analytics': 'Analítica Embudo',
    'rescue-queue': 'Cola de rescate',
};

// Vistas que manejan su propio alto y scroll (el contenedor no scrollea).
const FIXED_HEIGHT_TABS = ['comms', 'logistics', 'statistics'];

const ViewSpinner = () => (
    <div className="p-6 flex justify-center items-center min-h-[60vh]" role="status" aria-label="Cargando">
        <div className="w-8 h-8 border-[3px] border-accent-200 dark:border-accent-900 border-t-accent-600 dark:border-t-accent-500 rounded-full animate-spin" />
    </div>
);

const NavItem = ({ tab, icon: Icon, label, isActive, collapsed, onSelect }) => (
    <button
        type="button"
        onClick={() => onSelect(tab)}
        aria-current={isActive ? 'page' : undefined}
        aria-label={collapsed ? label : undefined}
        className={`w-full flex items-center ${collapsed ? 'justify-center px-0' : 'px-4'} py-3 mb-2 rounded-xl transition-colors duration-300 group
        ${isActive
                ? 'bg-accent-600 text-white shadow-md shadow-accent-500/30 border border-transparent'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-accent-600 dark:hover:text-white hover:shadow-sm border border-transparent'}`}
        title={collapsed ? label : ''}
    >
        <div className={`${collapsed ? '' : 'mr-4'} transition-transform duration-300 group-hover:scale-110`}>
            <Icon className={`w-5 h-5 2xl:w-6 2xl:h-6 ${isActive ? 'text-white' : 'text-slate-400 dark:text-slate-500 dark:group-hover:text-white transition-colors duration-300'}`} strokeWidth={isActive ? 2.5 : 2} />
        </div>
        {!collapsed && <span className={`font-medium text-sm 2xl:text-base ${isActive ? 'text-white font-bold tracking-wide' : 'dark:group-hover:text-white transition-colors duration-300'}`}>{label}</span>}
    </button>
);

const CorporateDashboard = () => {
    const { socket } = useSocket();
    const { logout, user, isAdmin } = useAuth();
    const { selectedSellerId } = useSeller();
    const { toast } = useToast();
    const { isDark, toggleTheme } = useTheme();
    // The seller whose status this dashboard shows:
    //   - Any admin (with or without their own sellerId) uses selectedSellerId,
    //     falling back to their home sellerId until they pick one.
    //   - Pure seller accounts are locked to their own sellerId.
    const viewedSellerId = isAdmin
        ? (selectedSellerId || user?.sellerId || null)
        : user?.sellerId;
    const [status, setStatus] = useState('initializing');
    const [alerts, setAlerts] = useState([]);
    // Lee la URL al montar — si es /guion, abre la tab de guiones directamente.
    // Permite que mainherbalisbot-production.up.railway.app/guion linkee directo
    // a esta sección sin tener que pasar por el dashboard primero.
    const initialTab = (() => {
        if (typeof window === 'undefined') return 'dashboard';
        const path = window.location.pathname.replace(/\/+$/, '').toLowerCase();
        if (path === '/guion' || path === '/guiones') return 'guion';
        return 'dashboard';
    })();
    const [activeTab, setActiveTab] = useState(initialTab);
    const [qrData, setQrData] = useState(null);
    const [config, setConfig] = useState({ alertNumbers: [] });
    const [connectedPhone, setConnectedPhone] = useState(null);
    const [targetChatId, setTargetChatId] = useState(null);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const [isPhone, setIsPhone] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [showNotifications, setShowNotifications] = useState(false);
    const notifRef = useRef(null);
    const bellRef = useRef(null);

    // El desplegable de avisos cierra con clic afuera y con Escape (y devuelve el
    // foco a la campana).
    useEffect(() => {
        if (!showNotifications) return;
        const handleClickOutside = (event) => {
            if (notifRef.current && !notifRef.current.contains(event.target)) {
                setShowNotifications(false);
            }
        };
        const handleKey = (event) => {
            if (event.key !== 'Escape') return;
            setShowNotifications(false);
            bellRef.current?.focus();
        };
        document.addEventListener('pointerdown', handleClickOutside);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('pointerdown', handleClickOutside);
            document.removeEventListener('keydown', handleKey);
        };
    }, [showNotifications]);

    // El menú del teléfono también cierra con Escape.
    useEffect(() => {
        if (!mobileMenuOpen) return;
        const handleKey = (event) => { if (event.key === 'Escape') setMobileMenuOpen(false); };
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [mobileMenuOpen]);

    const handleNavSelect = useCallback((tab) => {
        setActiveTab(tab);
        setMobileMenuOpen(false);
    }, []);

    // Detección de Mobile
    useEffect(() => {
        const checkMobile = () => {
            const w = window.innerWidth;
            setIsMobile(w < 1024);
            setIsPhone(w < 640);
            if (w < 1024) setSidebarCollapsed(true);
        };
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    const fetchConfig = useCallback(async () => {
        try {
            const res = await api.get('/api/status');
            if (res.data.config) setConfig(res.data.config);
            // Preferir phoneNumber (DB, refrescado en cada `ready`) sobre
            // info.wid.user (objeto wwebjs en memoria que puede quedar zombie
            // si un re-pair se interrumpe). Limpiar siempre si ambos son null.
            const phone = res.data.phoneNumber || res.data.info?.wid?.user || null;
            setConnectedPhone(phone);
        } catch { /* si falla, queda lo último que se mostró */ }
    }, []);

    useEffect(() => {
        if (socket) {
            const handleQr = (data) => {
                const evtSeller = typeof data === 'string' ? null : data?.sellerId;
                if (evtSeller && viewedSellerId && evtSeller !== viewedSellerId) return;
                setStatus('scan_qr');
                setQrData(typeof data === 'string' ? data : data?.qr || null);
            };
            const handleReady = (data) => {
                if (data?.sellerId && viewedSellerId && data.sellerId !== viewedSellerId) return;
                setStatus('ready');
                setQrData(null);
                // El backend ya manda phoneNumber en el payload — usarlo
                // directamente para que el header se actualice sin esperar
                // al fetchConfig (y sin riesgo de leer DB con upsert pendiente).
                if (data?.phoneNumber) setConnectedPhone(data.phoneNumber);
                else if (data?.info?.wid?.user) setConnectedPhone(data.info.wid.user);
                fetchConfig();
            };
            const handleStatusChange = ({ status: newStatus, sellerId: evtSeller }) => {
                if (evtSeller && viewedSellerId && evtSeller !== viewedSellerId) return;
                // Estados de WhatsApp en minúscula (state.toLowerCase() del backend).
                if (newStatus === 'connected' || newStatus === 'ready') {
                    // (Re)conectado → ONLINE. En modo remoto un re-emparejado emite
                    // 'connected' pero NO re-emite 'ready'; sin mapear esto, el
                    // indicador quedaba pegado en OFFLINE hasta recargar la web.
                    setStatus('ready');
                    fetchConfig(); // refresca teléfono/config tras el (re)emparejado
                } else if (
                    newStatus === 'disconnected' || newStatus === 'unpaired' ||
                    newStatus === 'auth_failure' || newStatus === 'qr_timeout' ||
                    newStatus === 'reconnecting'
                ) {
                    setStatus('scan_qr');
                    setQrData(null);
                    // Limpiar el teléfono mostrado — al reconectar con cuenta
                    // nueva, handleReady/fetchConfig traerá el nuevo desde DB.
                    setConnectedPhone(null);
                }
                // 'opening' / 'pairing' / 'timeout': transitorios durante un
                // re-emparejado — NO tocar status para no marcar OFFLINE falso
                // (se recupera con el 'connected' que llega a continuación).
            };
            // Mantener config.globalPause sincronizado en vivo — sin esto, el
            // indicador "PAUSADO" en el header no se actualizaba cuando se
            // togglea desde otro panel o vía Pausar TODOS.
            const handleGlobalPauseChanged = (data) => {
                const evtSeller = data?.sellerId;
                if (evtSeller && viewedSellerId && evtSeller !== viewedSellerId) return;
                setConfig(prev => ({ ...prev, globalPause: !!data?.globalPause }));
            };
            socket.on('qr', handleQr);
            socket.on('ready', handleReady);
            socket.on('status_change', handleStatusChange);
            socket.on('global_pause_changed', handleGlobalPauseChanged);
            // Solo mantenemos la alerta más reciente por userPhone. Si entra una
            // nueva para un cliente que ya tenía alerta, la reemplazamos en lugar
            // de acumular (el backend ya hace la misma dedup sobre sessionAlerts).
            const handleNewAlert = (newAlert) => setAlerts(prev => [
                newAlert,
                ...prev.filter(a => a.userPhone !== newAlert.userPhone),
            ]);
            const handleAlertsUpdated = (updated) => setAlerts(updated);
            socket.on('new_alert', handleNewAlert);
            socket.on('alerts_updated', handleAlertsUpdated);
            return () => {
                socket.off('qr', handleQr);
                socket.off('ready', handleReady);
                socket.off('status_change', handleStatusChange);
                socket.off('global_pause_changed', handleGlobalPauseChanged);
                socket.off('new_alert', handleNewAlert);
                socket.off('alerts_updated', handleAlertsUpdated);
            };
        }
    }, [socket, fetchConfig, viewedSellerId]);

    // Reload status when admin switches seller
    useEffect(() => {
        const loadData = async () => {
            try {
                const [alertRes, statusRes] = await Promise.all([
                    api.get('/api/alerts'),
                    api.get('/api/status')
                ]);
                setAlerts(alertRes.data);
                setStatus(statusRes.data.status || 'initializing');
                setQrData(statusRes.data.qr || null);
                if (statusRes.data.config) setConfig(statusRes.data.config);
                const phone = statusRes.data.phoneNumber || statusRes.data.info?.wid?.user || null;
                setConnectedPhone(phone);
            } catch { /* si falla, queda lo último que se mostró */ }
        };
        loadData();

        const handleConfigUpdate = () => fetchConfig();
        window.addEventListener('config-updated', handleConfigUpdate);
        return () => window.removeEventListener('config-updated', handleConfigUpdate);
    }, [fetchConfig, viewedSellerId]);

    const [processingAction, setProcessingAction] = useState(null); // Prevent double-click

    const handleQuickAction = async (chatId, action, sellerPhone) => {
        if (action === 'chat') {
            const toastId = toast.info('Buscando chat...');
            try {
                const statusRes = await api.get('/api/status');
                const connectedPhoneInfo = statusRes.data?.info?.wid?.user;
                const connectedPhone = connectedPhoneInfo || config.alertNumber; // Fallback

                if (sellerPhone && connectedPhone) {
                    const cleanedSeller = sellerPhone.replace(/\D/g, '');
                    const cleanedConnected = connectedPhone.replace(/\D/g, '');
                    // Only block if we have both values perfectly and they differ
                    if (!cleanedSeller.endsWith(cleanedConnected) && !cleanedConnected.endsWith(cleanedSeller)) {
                        toast.dismiss(toastId);
                        toast.warning('Esta venta se hizo desde otro n\u00famero.');
                        return; // Prevent redirecting
                    }
                }
            } catch {
                // non-fatal, proceed
            }

            toast.dismiss(toastId);
            setTargetChatId(chatId);
            setActiveTab('comms');
            return;
        }

        if (action === 'descartar') {
            setAlerts(prev => prev.filter(a => a.userPhone !== chatId && a.userPhone !== `${chatId}@c.us`));
            try { await api.delete(`/api/alerts/${chatId}`); } catch { /* silent */ }
            return;
        }

        // Prevent double-click
        const actionKey = `${chatId}_${action}`;
        if (processingAction === actionKey) return;
        setProcessingAction(actionKey);

        try {
            if (action === 'confirmar') {
                // SIEMPRE preview → modal de verificación (mismo patrón que
                // CommsView.handleManualCompletion). El post directo sin preview
                // creaba la orden + mandaba WhatsApp salteando el modal, y una
                // transferencia aprobada por alerta quedaba "Sin verificar".
                // El prefill del backend trae prices/total/productDetected para
                // que el modal muestre el total real. La orden se crea (y la
                // alerta se descarta) recién al confirmar el modal.
                const res = await api.post('/api/orders/manual-complete', { chatId, preview: true });
                setManualEntry({ chatId, prefill: res.data?.prefill || {} });
            } else {
                await api.post('/api/admin-command', { chatId, command: action });
                setAlerts(prev => prev.filter(a => a.userPhone !== chatId));
                toast.success(`Acción ejecutada: ${action}`);
            }
        } catch (e) {
            toast.error('Error ejecutando acción: ' + (e.response?.data?.error || e.message));
        } finally {
            setProcessingAction(null);
        }
    };

    const [manualEntry, setManualEntry] = useState(null);
    const [submittingManual, setSubmittingManual] = useState(false);
    // OJO: el modal manda un payload { manualAddr, shippingType, paymentMethod, ... },
    // NO el manualAddr pelado. Antes se posteaba el payload entero como manualAddr
    // → el backend no encontraba nombre/calle y descartaba lo tipeado.
    const handleManualEntrySubmit = async ({ manualAddr, shippingType, paymentMethod, discount, productType, plan, paymentVerified }) => {
        if (!manualEntry) return;
        setSubmittingManual(true);
        try {
            await api.post('/api/orders/manual-complete', {
                chatId: manualEntry.chatId,
                manualAddr, shippingType, paymentMethod, discount, productType, plan, paymentVerified,
            });
            setAlerts(prev => prev.filter(a => a.userPhone !== manualEntry.chatId));
            toast.success('Pedido registrado con datos manuales ✅');
            setManualEntry(null);
        } catch (e) {
            toast.error('Error: ' + (e.response?.data?.error || e.message));
        } finally {
            setSubmittingManual(false);
        }
    };

    const renderContent = () => {
        switch (activeTab) {
            case 'dashboard': return <DashboardView alerts={alerts} config={config} handleQuickAction={handleQuickAction} status={status} qrData={qrData} />;
            case 'statistics': return <AdvancedAnalyticsView />;
            case 'comms': return <CommsView initialChatId={targetChatId} onChatSelected={() => setTargetChatId(null)} onChatOpened={() => { if (!isMobile) setSidebarCollapsed(true); }} alerts={alerts} onAlertAction={handleQuickAction} />;
            case 'logistics': return <SalesView onGoToChat={(chatId) => handleQuickAction(chatId, 'chat')} />;
            case 'gallery': return <GalleryView />;
            case 'manuals': return <ManualsView />;
            case 'settings': return <SettingsView status={status} />;
            case 'payments': return (
                <div className="p-6 md:p-8 w-full">
                    <PaymentsView onGoToChat={(chatId) => handleQuickAction(chatId, 'chat')} />
                </div>
            );
            case 'web-orders': return (
                <div className="p-6 md:p-8 w-full">
                    <WebOrdersView />
                </div>
            );
            case 'ai-reports': return (
                <div className="p-6 md:p-8 w-full">
                    <AiReportsView />
                </div>
            );
            case 'guion': return <GuionView />;
            case 'playground': return <PlaygroundView />;
            case 'promos': return <PromoView onGoToChat={(chatId) => handleQuickAction(chatId, 'chat')} />;
            case 'accounts': return <AccountsView />;
            case 'account-stats': return <AccountStatsView />;
            case 'funnel-analytics': return <FunnelAnalyticsView />;
            case 'rescue-queue': return <RescueQueueView onGoToChat={(chatId) => handleQuickAction(chatId, 'chat')} />;
            default: return <DashboardView alerts={alerts} config={config} handleQuickAction={handleQuickAction} status={status} qrData={qrData} />;
        }
    };

    // En escritorio el menú se puede contraer a solo iconos; en el teléfono es un
    // cajón que siempre muestra los nombres.
    const collapsed = sidebarCollapsed && !isMobile;
    const navProps = (tab) => ({ tab, isActive: activeTab === tab, collapsed, onSelect: handleNavSelect });
    const isFixedHeightTab = FIXED_HEIGHT_TABS.includes(activeTab);

    return (
        <div className="flex flex-col lg:flex-row h-app overflow-hidden bg-slate-50 dark:bg-slate-900 font-sans text-slate-800 dark:text-slate-100 selection:bg-accent-100 dark:selection:bg-accent-900/50 selection:text-accent-900 dark:selection:text-accent-100 relative transition-colors duration-300">

            {/* Overlay para fondo oscurecido en Mobile al abrir el menú */}
            {isMobile && mobileMenuOpen && (
                <div
                    className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-30 transition-opacity"
                    onClick={() => setMobileMenuOpen(false)}
                />
            )}

            {/* 1. MENÚ LATERAL. En escritorio va al lado del contenido (sin blur: no
                tiene nada detrás); en el teléfono es un cajón que flota encima.
                Con la barra inferior visible (isPhone) deja libre su alto para que
                "Cerrar sesión" no quede tapado. */}
            <aside
                id="menu-principal"
                aria-label="Menú principal"
                inert={isMobile && !mobileMenuOpen}
                className={`
                fixed lg:sticky top-0 z-40 lg:z-20 flex flex-col h-app pt-[env(safe-area-inset-top)] bg-white/95 dark:bg-slate-900/95 lg:bg-white/70 dark:lg:bg-slate-900/70 backdrop-blur-3xl lg:backdrop-blur-none border-r border-slate-200/60 dark:border-slate-700/60 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)] dark:shadow-[4px_0_24px_-12px_rgba(0,0,0,0.5)]
                transition-transform duration-300 ease-in-out lg:translate-x-0
                ${isMobile ? 'w-72 left-0 top-0 bottom-0' : (sidebarCollapsed ? 'w-20' : 'w-72 xl:w-80 2xl:w-[22rem]')}
                ${isMobile && !mobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}
                ${isPhone ? 'pb-[calc(4rem+env(safe-area-inset-bottom))]' : ''}
            `}>

                {/* Logo & Toggle */}
                <div className="h-14 flex-shrink-0 flex items-center justify-between px-6 border-b border-slate-200/50 dark:border-slate-700/50">
                    {!collapsed && (
                        <div className="flex items-center gap-3 animate-fade-in w-full justify-between lg:justify-start">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-accent-600 shadow-lg shadow-accent-500/30 flex items-center justify-center" aria-hidden="true">
                                    <span className="text-white font-bold text-lg">H</span>
                                </div>
                                <div>
                                    <p className="font-bold text-slate-800 dark:text-slate-100 leading-tight">Herbalis</p>
                                    <p className="text-[10px] font-semibold tracking-widest text-accent-600 dark:text-accent-400 uppercase">Panel</p>
                                </div>
                            </div>
                            {isMobile && (
                                <button
                                    type="button"
                                    onClick={() => setMobileMenuOpen(false)}
                                    aria-label="Cerrar menú"
                                    className="w-11 h-11 -mr-3 flex items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            )}
                        </div>
                    )}
                    {collapsed && (
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-accent-600 shadow-lg shadow-accent-500/30 flex items-center justify-center mx-auto animate-fade-in" aria-hidden="true">
                            <span className="text-white font-bold text-lg">H</span>
                        </div>
                    )}
                    {!isMobile && !sidebarCollapsed && (
                        <button
                            type="button"
                            onClick={() => setSidebarCollapsed(true)}
                            aria-label="Contraer menú"
                            aria-expanded="true"
                            aria-controls="menu-principal"
                            className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-accent-600 dark:hover:text-accent-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        >
                            <Menu className="w-5 h-5" />
                        </button>
                    )}
                </div>

                <nav aria-label="Secciones" className="flex-1 min-h-0 py-6 px-4 space-y-1 overflow-y-auto hide-scrollbar">
                    <NavItem {...navProps('dashboard')} icon={Wifi} label="Inicio" />
                    <NavItem {...navProps('comms')} icon={MessageCircle} label="Chat & Atención" />
                    <NavItem {...navProps('rescue-queue')} icon={LifeBuoy} label="Cola de rescate" />
                    <NavItem {...navProps('logistics')} icon={ShoppingCart} label="Ventas & Logística" />
                    <NavItem {...navProps('statistics')} icon={BarChart2} label="Estadísticas" />
                    <NavItem {...navProps('payments')} icon={CreditCard} label="Pagos MP" />
                    <NavItem {...navProps('web-orders')} icon={Package} label="Pedidos web" />
                    <NavItem {...navProps('guion')} icon={MessagesSquare} label="Guiones (notas)" />
                    <NavItem {...navProps('playground')} icon={FlaskConical} label="Probar bot" />
                    <NavItem {...navProps('promos')} icon={Gift} label="Promos" />
                    <NavItem {...navProps('gallery')} icon={ImageIcon} label="Galería de Medios" />
                    <NavItem {...navProps('manuals')} icon={BookOpen} label="Manuales" />
                    {isAdmin && <NavItem {...navProps('ai-reports')} icon={AlertTriangle} label="Errores de IA" />}

                    <div className="pt-6 mt-6 border-t border-slate-200/50 dark:border-slate-700/50">
                        {!collapsed && <p className="text-xs 2xl:text-sm font-semibold text-slate-500 dark:text-slate-300 uppercase tracking-wider mb-4 px-4">Administración</p>}
                        <NavItem {...navProps('settings')} icon={Settings} label="Configuración" />
                        {isAdmin && <NavItem {...navProps('accounts')} icon={Users} label="Usuarios" />}
                        {isAdmin && <NavItem {...navProps('account-stats')} icon={BarChart2} label="Horas Vendedores" />}
                        {isAdmin && <NavItem {...navProps('funnel-analytics')} icon={Activity} label="Analítica Embudo" />}
                    </div>
                </nav>

                {/* User Profile & Logout (Bottom) */}
                <div className="flex-shrink-0 p-4 border-t border-slate-200/50 dark:border-slate-700/50 bg-white/40 dark:bg-slate-800/40">
                    {/* Theme Toggle */}
                    <button
                        type="button"
                        onClick={toggleTheme}
                        aria-label={collapsed ? (isDark ? 'Modo Claro' : 'Modo Oscuro') : undefined}
                        className={`w-full flex items-center ${collapsed ? 'justify-center p-2' : 'px-4 py-3'} mb-2 rounded-xl transition-colors duration-300 border border-transparent hover:border-accent-200 dark:hover:border-accent-800/50 group
                            ${isDark
                                ? 'bg-accent-500/10 text-warning-400 hover:bg-accent-500/20'
                                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-accent-600 dark:hover:text-accent-400'
                            }`}
                        title={collapsed ? (isDark ? 'Modo Claro' : 'Modo Oscuro') : ''}
                    >
                        <div className={`${collapsed ? '' : 'mr-3'} group-hover:scale-110 transition-transform duration-300`}>
                            {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                        </div>
                        {!collapsed && <span className="font-medium text-sm">{isDark ? 'Modo Claro' : 'Modo Oscuro'}</span>}
                    </button>
                    <button
                        type="button"
                        onClick={() => { logout(); if (isMobile) setMobileMenuOpen(false); }}
                        aria-label={collapsed ? 'Cerrar sesión' : undefined}
                        className={`w-full flex items-center ${collapsed ? 'justify-center p-2' : 'px-4 py-3'} rounded-xl hover:bg-danger-50 dark:hover:bg-danger-900/20 text-danger-600 dark:text-danger-400 transition-colors duration-300 border border-transparent hover:border-danger-200 dark:hover:border-danger-800/50 group`}
                        title={collapsed ? 'Cerrar sesión' : ''}
                    >
                        <div className={`${collapsed ? '' : 'mr-3'} group-hover:scale-110 transition-transform`}>
                            <LogOut className="w-5 h-5" />
                        </div>
                        {!collapsed && <span className="font-medium text-sm">Cerrar sesión</span>}
                    </button>
                </div>
            </aside>

            {/* 2. MAIN CONTENT AREA V2 */}
            <div className="flex-1 flex flex-col overflow-hidden bg-gradient-to-br from-slate-50 dark:from-slate-900 to-blue-50/30 dark:to-accent-900/10 w-full relative">
                {/* Cabecera. Sin blur: nada scrollea por detrás. */}
                <header className="flex-shrink-0 h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] bg-white/60 dark:bg-slate-900/60 border-b border-slate-200/60 dark:border-slate-800 flex justify-between items-center px-3 sm:px-4 lg:px-8 z-10 shadow-sm shadow-slate-200/20 dark:shadow-black/20">
                    <div className="flex items-center gap-3 w-full lg:w-auto">
                        <button
                            type="button"
                            onClick={() => setMobileMenuOpen(true)}
                            aria-label="Abrir menú"
                            aria-expanded={mobileMenuOpen}
                            aria-controls="menu-principal"
                            className="w-11 h-11 flex items-center justify-center lg:hidden rounded-lg text-slate-500 dark:text-slate-400 hover:text-accent-600 dark:hover:text-accent-400 hover:bg-white dark:hover:bg-slate-800 shadow-sm transition-colors border border-slate-200/50 dark:border-slate-700/50"
                        >
                            <Menu className="w-5 h-5" />
                        </button>
                        {collapsed && (
                            <button
                                type="button"
                                onClick={() => setSidebarCollapsed(false)}
                                aria-label="Expandir menú"
                                aria-expanded="false"
                                aria-controls="menu-principal"
                                className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-accent-600 dark:hover:text-accent-400 hover:bg-white dark:hover:bg-slate-800 shadow-sm transition-colors border border-slate-200/50 dark:border-slate-700/50 block"
                            >
                                <Menu className="w-5 h-5" />
                            </button>
                        )}

                        {/* Indicador de estado: ONLINE / PAUSADO / OFFLINE.
                            - ONLINE  → conectado y NO pausado
                            - PAUSADO → conectado pero globalPause activo (no atiende)
                            - OFFLINE → desconectado de WhatsApp
                            El estado PAUSADO tiene precedencia visual sobre ONLINE
                            cuando ambos aplican. */}
                        {(() => {
                            const isReady = status === 'ready';
                            const isPaused = isReady && !!config?.globalPause;
                            const tone = isPaused
                                ? { bg: 'bg-warning-50 dark:bg-warning-900/20 border-warning-300 dark:border-warning-700/60 shadow-sm shadow-warning-500/10', dot: 'bg-warning-500 shadow-[0_0_10px_rgba(245,158,11,0.55)] animate-pulse', text: 'text-warning-700 dark:text-warning-400', label: 'PAUSADO' }
                                : isReady
                                ? { bg: 'bg-success-50 dark:bg-success-900/20 border-success-200 dark:border-success-800/50', dot: 'bg-success-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]', text: 'text-success-700 dark:text-success-400', label: 'ONLINE' }
                                : { bg: 'bg-danger-50 dark:bg-danger-900/30 border-danger-300 dark:border-danger-700 shadow-md shadow-danger-500/20', dot: 'bg-danger-500 shadow-[0_0_10px_rgba(239,68,68,0.6)] animate-pulse', text: 'text-danger-700 dark:text-danger-300', label: 'OFFLINE' };
                            return (
                                <div role="status" className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl border transition-colors ${tone.bg}`}>
                                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${tone.dot}`} aria-hidden="true"></div>
                                    <span className={`text-[10px] sm:text-xs lg:text-sm font-bold tracking-wide whitespace-nowrap ${tone.text}`}>
                                        {tone.label}
                                    </span>
                                    {isReady && connectedPhone && (
                                        <span className="hidden sm:inline text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-wider bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 ml-1">
                                            +{connectedPhone}
                                        </span>
                                    )}
                                </div>
                            );
                        })()}
                    </div>

                    <div className="flex items-center gap-2 lg:gap-4 ml-auto">
                        {/* Notifications Bell */}
                        <div className="relative" ref={notifRef}>
                            <button
                                ref={bellRef}
                                type="button"
                                onClick={() => setShowNotifications(!showNotifications)}
                                aria-label={alerts.length > 0 ? `Notificaciones: ${alerts.length} ${alerts.length === 1 ? 'aviso pendiente' : 'avisos pendientes'}` : 'Notificaciones: sin avisos'}
                                aria-expanded={showNotifications}
                                aria-controls="panel-notificaciones"
                                className="relative w-11 h-11 lg:w-auto lg:h-auto lg:p-2 flex items-center justify-center rounded-xl text-slate-500 hover:text-accent-600 dark:text-slate-400 dark:hover:text-accent-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shadow-sm cursor-pointer"
                            >
                                <Bell className="w-5 h-5 lg:w-6 lg:h-6" />
                                {alerts.length > 0 && (
                                    <span aria-hidden="true" className="absolute top-0 right-0 lg:-mt-1 lg:-mr-1 flex items-center justify-center w-5 h-5 text-[10px] font-bold text-white bg-danger-600 border-2 border-white dark:border-slate-900 rounded-full leading-none shadow-sm">
                                        {alerts.length > 9 ? '9+' : alerts.length}
                                    </span>
                                )}
                            </button>

                            {/* Dropdown */}
                            {showNotifications && (
                                <div id="panel-notificaciones" className="absolute right-0 mt-3 w-[18rem] sm:w-96 bg-white dark:bg-slate-800 rounded-2xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_40px_-10px_rgba(0,0,0,0.5)] border border-slate-200 dark:border-slate-700 z-50 overflow-hidden animate-fade-in flex flex-col">
                                    <div className="p-4 border-b border-slate-100 dark:border-slate-700/50 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/50">
                                        <h2 className="font-extrabold text-slate-800 dark:text-slate-100 text-sm">Notificaciones</h2>
                                        {alerts.length > 0 && (
                                            <span className="text-[10px] font-bold text-accent-600 dark:text-accent-400 bg-accent-50 dark:bg-accent-900/40 px-2 py-1 rounded-lg uppercase tracking-wider">{alerts.length} {alerts.length === 1 ? 'novedad' : 'novedades'}</span>
                                        )}
                                    </div>
                                    <div className="max-h-[60vh] overflow-y-auto custom-scrollbar">
                                        {alerts.length === 0 ? (
                                            <div className="p-10 text-center text-slate-500 dark:text-slate-400">
                                                <div className="w-16 h-16 rounded-full bg-slate-100 dark:bg-slate-700/50 flex items-center justify-center mx-auto mb-4 border border-slate-200 dark:border-slate-700/50">
                                                    <Bell className="w-6 h-6 text-slate-400 dark:text-slate-500" />
                                                </div>
                                                <p className="text-sm font-bold text-slate-700 dark:text-slate-300">Todo al día</p>
                                                <p className="text-xs mt-1 font-medium">No hay alertas pendientes en este momento.</p>
                                            </div>
                                        ) : (
                                            <ul className="flex flex-col">
                                                {alerts.map(alert => (
                                                    <li key={alert.id}>
                                                        <button
                                                            type="button"
                                                            className="w-full text-left p-4 border-b border-slate-50 dark:border-slate-700/50 hover:bg-danger-50/60 dark:hover:bg-danger-900/10 focus-visible:bg-danger-50/60 dark:focus-visible:bg-danger-900/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 transition-colors cursor-pointer flex gap-3 group"
                                                            onClick={() => {
                                                                setShowNotifications(false);
                                                                handleQuickAction(alert.userPhone, 'chat');
                                                            }}
                                                        >
                                                            <span className="w-10 h-10 rounded-full bg-danger-100 dark:bg-danger-900/30 text-danger-600 dark:text-danger-400 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-sm" aria-hidden="true">
                                                                <AlertTriangle className="w-5 h-5" />
                                                            </span>
                                                            <span className="block min-w-0 pr-2">
                                                                <span className="block text-sm font-bold text-slate-800 dark:text-slate-200 group-hover:text-accent-600 dark:group-hover:text-accent-400 transition-colors line-clamp-2 leading-tight mb-1">{alert.reason}</span>
                                                                <span className="block text-xs text-slate-500 dark:text-slate-400 font-medium font-mono">{alert.userPhone ? alert.userPhone.split('@')[0] : 'Desconocido'}</span>
                                                                {alert.details && (
                                                                    <span className="block text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 truncate italic border-l-2 border-slate-200 dark:border-slate-600 pl-2">"{alert.details}"</span>
                                                                )}
                                                            </span>
                                                        </button>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="flex items-center gap-3 pl-4 lg:pl-6 border-l border-slate-200 dark:border-slate-700/60 ml-2">
                            <div className="text-right hidden md:block">
                                <p className="text-sm font-bold text-slate-800 dark:text-slate-100 capitalize">{user?.name || 'Usuario'}</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 font-medium capitalize">{user?.role || 'seller'}</p>
                            </div>
                            {/* Admin: ámbar oscuro (700/800), que es donde el blanco llega a contraste. */}
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-md border border-white/20 ${isAdmin ? 'bg-warning-700 shadow-warning-500/30' : 'bg-accent-600 shadow-accent-500/30'}`}>
                                <span className="text-white font-bold text-sm">
                                    {(user?.name || 'U').charAt(0).toUpperCase()}
                                </span>
                            </div>
                        </div>
                    </div>
                </header>

                {/* Área de Contenido Principal */}
                <main className="flex-1 relative flex flex-col min-h-0 overflow-hidden" onClick={() => { if (isMobile && mobileMenuOpen) setMobileMenuOpen(false); }}>
                    {/* Antes había 2 blur-orbs decorativos absolute aquí (purple/indigo)
                        que pintaban en cada vista. Los sacamos: aportaban ruido
                        visual y costaban GPU en mobile sin agregar jerarquía. */}

                    <div className={`flex-1 relative z-0 w-full flex flex-col min-h-0 overflow-hidden ${isFixedHeightTab ? '' : 'overflow-y-auto custom-scrollbar'} p-3 sm:p-4 lg:p-5 ${isPhone ? 'pb-[calc(5rem+env(safe-area-inset-bottom))]' : ''}`}>
                        {/* En monitores muy anchos el contenido no se estira más de
                            1600px; el chat usa todo el ancho. Las vistas de alto fijo
                            necesitan min-h-0 para scrollear por dentro; el resto crece
                            y scrollea el contenedor de arriba. */}
                        <div className={`flex-1 flex flex-col w-full ${isFixedHeightTab ? 'min-h-0' : ''} ${activeTab === 'comms' ? '' : 'max-w-[1600px] mx-auto'}`}>
                            {/* key: un fallo al bajar una vista no deja el aviso pegado en las demás. */}
                            <LazyBoundary
                                key={activeTab}
                                fallback={<p className="p-6 text-sm text-slate-500 dark:text-slate-400">No se pudo cargar {TAB_NAMES[activeTab] || 'esta sección'}. Recargá la página.</p>}
                            >
                                <Suspense fallback={<ViewSpinner />}>
                                    {renderContent()}
                                </Suspense>
                            </LazyBoundary>
                        </div>
                    </div>
                </main>
            </div>

            {/* ── BOTTOM NAV (phone only) ── */}
            {isPhone && (
                <nav aria-label="Navegación rápida" className="fixed bottom-0 inset-x-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border-t border-slate-200/60 dark:border-slate-700/60 shadow-[0_-4px_24px_-8px_rgba(0,0,0,0.12)] flex items-stretch h-[calc(4rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)]">
                    {[
                        { tab: 'dashboard',  icon: Wifi,           label: 'Inicio'  },
                        { tab: 'comms',      icon: MessageCircle,  label: 'Chat'    },
                        { tab: 'logistics',  icon: ShoppingCart,   label: 'Ventas'  },
                        { tab: 'statistics', icon: BarChart2,      label: 'Stats'   },
                        { tab: '__more__',   icon: MoreHorizontal, label: 'Más'     },
                    ].map(({ tab, icon: Icon, label }) => {
                        const isActive = tab === '__more__' ? mobileMenuOpen : activeTab === tab;
                        return (
                            <button
                                key={tab}
                                type="button"
                                aria-current={isActive && tab !== '__more__' ? 'page' : undefined}
                                aria-expanded={tab === '__more__' ? mobileMenuOpen : undefined}
                                aria-controls={tab === '__more__' ? 'menu-principal' : undefined}
                                onClick={() => {
                                    if (tab === '__more__') {
                                        setMobileMenuOpen(prev => !prev);
                                    } else {
                                        setActiveTab(tab);
                                        setMobileMenuOpen(false);
                                    }
                                }}
                                className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition-colors duration-200 ${isActive ? 'text-accent-600 dark:text-accent-400' : 'text-slate-500 dark:text-slate-400'}`}
                            >
                                <Icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
                                <span className="text-[10px] font-medium tracking-wide">{label}</span>
                                {isActive && tab !== '__more__' && (
                                    <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-accent-500" />
                                )}
                                {tab !== '__more__' && alerts.length > 0 && tab === 'dashboard' && (
                                    <span className="absolute top-1 right-1/4 flex items-center justify-center w-4 h-4 text-[9px] font-bold text-white bg-danger-500 rounded-full tabular-nums">{alerts.length > 9 ? '9+' : alerts.length}</span>
                                )}
                            </button>
                        );
                    })}
                </nav>
            )}

            {/* Manual Order Entry Modal — abre cuando 422 al confirmar alert */}
            <ManualOrderEntryModal
                open={!!manualEntry}
                chatId={manualEntry?.chatId}
                prefill={manualEntry?.prefill}
                onClose={() => !submittingManual && setManualEntry(null)}
                onSubmit={handleManualEntrySubmit}
                submitting={submittingManual}
            />
        </div>
    );
};

export default CorporateDashboard;
