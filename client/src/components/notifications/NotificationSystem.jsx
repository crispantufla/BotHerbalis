import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useSocket } from '../../context/SocketContext';
import { ShoppingBag, Clock, AlertTriangle, Wifi, WifiOff, Pause, CheckCircle, Trash2 } from 'lucide-react';

// ── Notification sound (short beep using Web Audio API) ──
function playNotificationSound(type = 'info') {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        // Different sounds for different notification types
        const sounds = {
            order: { freq: 880, dur: 0.15, repeat: 3 },  // Triple beep for orders
            alert: { freq: 660, dur: 0.2, repeat: 2 },  // Double beep for alerts
            info: { freq: 520, dur: 0.1, repeat: 1 },  // Single beep for info
            success: { freq: 1047, dur: 0.15, repeat: 1 }, // High beep for success
        };

        const s = sounds[type] || sounds.info;
        osc.type = 'sine';
        osc.frequency.value = s.freq;
        gain.gain.value = 0.3;

        osc.start();

        // Create beep pattern
        let totalDur = 0;
        for (let i = 0; i < s.repeat; i++) {
            const start = i * (s.dur + 0.08);
            const end = start + s.dur;
            gain.gain.setValueAtTime(0.3, ctx.currentTime + start);
            gain.gain.setValueAtTime(0, ctx.currentTime + end);
            totalDur = end;
        }

        osc.stop(ctx.currentTime + totalDur + 0.05);
    } catch (e) {
        // Audio not available, skip silently
    }
}

// ── Format phone for display ──
function formatPhone(phone) {
    if (!phone) return '?';
    return phone.replace('@c.us', '').replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
}

// ── Custom toast content components ──
function OrderToast({ alert, onNavigate }) {
    const { orderData, userName, userPhone } = alert;
    const product = orderData?.product || '?';
    const price = orderData?.price || '?';
    const plan = orderData?.plan || '';

    return (
        <div onClick={() => onNavigate(userPhone)} style={{ cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <ShoppingBag size={16} style={{ color: '#22c55e', flexShrink: 0 }} />
                <strong style={{ fontSize: '14px' }}>Nuevo Pedido</strong>
            </div>
            <p style={{ margin: '2px 0', fontSize: '13px', color: '#e2e8f0' }}>
                {userName || formatPhone(userPhone)} — ${price}
            </p>
            <p style={{ margin: '2px 0', fontSize: '12px', color: '#94a3b8' }}>
                {product} {plan ? `(${plan} días)` : ''}
            </p>
            <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#64748b' }}>
                Click para ir al chat →
            </p>
        </div>
    );
}

function AlertToast({ alert, onNavigate }) {
    const { reason, userName, userPhone, details } = alert;
    const isStale = reason?.includes('estancado');

    return (
        <div onClick={() => onNavigate(userPhone)} style={{ cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                {isStale
                    ? <Clock size={16} style={{ color: '#f59e0b', flexShrink: 0 }} />
                    : <AlertTriangle size={16} style={{ color: '#ef4444', flexShrink: 0 }} />
                }
                <strong style={{ fontSize: '14px' }}>{reason}</strong>
            </div>
            <p style={{ margin: '2px 0', fontSize: '13px', color: '#e2e8f0' }}>
                {userName || formatPhone(userPhone)}
            </p>
            {details && (
                <p style={{ margin: '2px 0', fontSize: '12px', color: '#94a3b8' }}>
                    {details.substring(0, 80)}
                </p>
            )}
            <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#64748b' }}>
                Click para ir al chat →
            </p>
        </div>
    );
}

// ══════════════════════════════════════════════════════════════
// MAIN COMPONENT — Listens to socket events and fires toasts
// ══════════════════════════════════════════════════════════════

export default function NotificationSystem() {
    const { socket } = useSocket();
    const prevConnected = useRef(null);

    useEffect(() => {
        if (!socket) return;

        // Helper: navigate to a chat
        const navigateToChat = (userPhone) => {
            // Dispatch a custom event that CommsViewV2 can listen to
            const phone = userPhone?.replace('@c.us', '');
            if (phone) {
                window.dispatchEvent(new CustomEvent('navigate-to-chat', { detail: { phone } }));
            }
        };

        // ── NEW ALERT (orders, stale users, etc.) ──
        const handleNewAlert = (alert) => {
            const isOrder = alert.reason?.includes('pedido') ||
                alert.reason?.includes('Pedido') ||
                alert.reason?.includes('AUTO-APROBADO') ||
                alert.orderData?.product;
            const isStale = alert.reason?.includes('estancado');

            if (isOrder) {
                playNotificationSound('order');
                toast.custom(() => (
                    <OrderToast alert={alert} onNavigate={navigateToChat} />
                ), {
                    duration: 15000,
                    style: {
                        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
                        border: '1px solid #22c55e40',
                        borderRadius: '12px',
                        padding: '14px 16px',
                        color: '#f1f5f9',
                        boxShadow: '0 8px 32px rgba(34, 197, 94, 0.15)',
                    }
                });
            } else if (isStale) {
                playNotificationSound('alert');
                toast.custom(() => (
                    <AlertToast alert={alert} onNavigate={navigateToChat} />
                ), {
                    duration: 10000,
                    style: {
                        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
                        border: '1px solid #f59e0b40',
                        borderRadius: '12px',
                        padding: '14px 16px',
                        color: '#f1f5f9',
                        boxShadow: '0 8px 32px rgba(245, 158, 11, 0.15)',
                    }
                });
            } else {
                playNotificationSound('info');
                toast.custom(() => (
                    <AlertToast alert={alert} onNavigate={navigateToChat} />
                ), {
                    duration: 8000,
                    style: {
                        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
                        border: '1px solid #3b82f640',
                        borderRadius: '12px',
                        padding: '14px 16px',
                        color: '#f1f5f9',
                        boxShadow: '0 8px 32px rgba(59, 130, 246, 0.15)',
                    }
                });
            }
        };

        // ── BOT PAUSED (existing conversation detected) ──
        const handleBotPaused = (data) => {
            playNotificationSound('info');
            toast(`Bot pausado — ${formatPhone(data.chatId)}`, {
                description: data.reason || 'Conversación existente detectada',
                icon: <Pause size={18} style={{ color: '#f59e0b' }} />,
                duration: 6000,
            });
        };

        // ── ORDER UPDATE ──
        const handleOrderUpdate = (data) => {
            if (data.action === 'created') {
                // Already handled by new_alert, skip
                return;
            }
            const action = data.action === 'updated' ? 'actualizado' : data.action === 'deleted' ? 'eliminado' : data.action;
            toast(`Pedido ${action}`, {
                description: data.order?.id ? `ID: ${data.order.id.substring(0, 8)}...` : '',
                icon: data.action === 'deleted'
                    ? <Trash2 size={18} style={{ color: '#ef4444' }} />
                    : <CheckCircle size={18} style={{ color: '#22c55e' }} />,
                duration: 4000,
            });
        };

        // ── CONNECTION STATUS ──
        const handleReady = () => {
            if (prevConnected.current === false) {
                toast.success('WhatsApp conectado', {
                    icon: <Wifi size={18} style={{ color: '#22c55e' }} />,
                    duration: 3000,
                });
            }
            prevConnected.current = true;
        };

        const handleDisconnect = () => {
            if (prevConnected.current === true) {
                playNotificationSound('alert');
                toast.error('WhatsApp desconectado', {
                    icon: <WifiOff size={18} style={{ color: '#ef4444' }} />,
                    duration: 8000,
                });
            }
            prevConnected.current = false;
        };

        // ── MEMORY RESET ──
        const handleMemoryReset = (data) => {
            toast.success(`Memoria limpiada — ${data.deletedCount || 0} usuarios`, {
                duration: 4000,
            });
        };

        // Register listeners
        socket.on('new_alert', handleNewAlert);
        socket.on('bot_paused', handleBotPaused);
        socket.on('order_update', handleOrderUpdate);
        socket.on('ready', handleReady);
        socket.on('status_change', (data) => {
            if (data.status === 'disconnected') handleDisconnect();
        });
        socket.on('memory_reset', handleMemoryReset);

        return () => {
            socket.off('new_alert', handleNewAlert);
            socket.off('bot_paused', handleBotPaused);
            socket.off('order_update', handleOrderUpdate);
            socket.off('ready', handleReady);
            socket.off('status_change');
            socket.off('memory_reset', handleMemoryReset);
        };
    }, [socket]);

    return null; // This component only listens, renders nothing
}
