import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import api from '../../../config/axios';
import { useSocket } from '../../../context/SocketContext';
import { API_URL } from '../../../config/api';
import { useToast } from '../../ui/Toast';

import { Search, Bot, Play, Pause, Trash2 as Trash, FileText as ScriptIcon, ChevronDown, Send, Paperclip, ShoppingCart, ArrowLeft } from 'lucide-react';

const CommsViewV2 = ({ initialChatId, onChatSelected }) => {
    const { socket } = useSocket();
    const { toast } = useToast();
    const [chats, setChats] = useState([]);
    const [selectedChat, setSelectedChat] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [loading, setLoading] = useState(false);
    const [showScriptPanel, setShowScriptPanel] = useState(false);
    const [showOrdersPanel, setShowOrdersPanel] = useState(false);
    const [scriptFlow, setScriptFlow] = useState({});
    const [summarizing, setSummarizing] = useState(false);
    const [summaryText, setSummaryText] = useState(null);
    const [attachment, setAttachment] = useState(null);
    const [sendingMedia, setSendingMedia] = useState(false);
    const [isTracking, setIsTracking] = useState(false);
    const [trackingData, setTrackingData] = useState(null);
    const [prices, setPrices] = useState(null);
    const [globalPause, setGlobalPause] = useState(false);
    const messagesEndRef = useRef(null);
    const scrollContainerRef = useRef(null);
    const fileInputRef = useRef(null);

    const filteredChats = searchTerm
        ? chats.filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()))
        : chats;

    useEffect(() => {
        if (initialChatId && chats.length > 0) {
            const chatToSelect = chats.find(c => c.id === initialChatId);
            setSelectedChat(chatToSelect || { id: initialChatId, name: initialChatId });
            if (onChatSelected) onChatSelected();
        }
    }, [initialChatId, chats, onChatSelected]);

    useEffect(() => {
        const fetchChats = async () => {
            try {
                const res = await api.get('/api/chats');
                setChats(res.data);
            } catch (e) { setChats([]); }
        };
        const fetchStatsForPause = async () => {
            try {
                const res = await api.get('/api/stats');
                setGlobalPause(!!res.data.globalPause);
            } catch (e) { console.error('Error fetching global stats', e); }
        };
        fetchChats();
        fetchStatsForPause();

        if (socket) {
            socket.on('new_log', (data) => {
                try {
                    if (!data || !data.chatId) return;
                    let timestamp = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();

                    if (selectedChat && selectedChat.id === data.chatId) {
                        const isMe = data.sender === 'bot' || data.sender === 'admin';
                        const newMsg = { id: data.messageId || `socket-${timestamp}`, fromMe: isMe, body: data.text || '', type: 'chat', timestamp };
                        setMessages((prev) => {
                            if (!Array.isArray(prev)) return [newMsg];
                            if (isMe) {
                                const pendingIndex = prev.findIndex(m => m.pending && m.body === newMsg.body && Math.abs(m.timestamp - timestamp) < 10000);
                                if (pendingIndex !== -1) {
                                    const updated = [...prev];
                                    updated[pendingIndex] = newMsg;
                                    return updated;
                                }
                            }
                            const exists = prev.some(m => (m.id && m.id === newMsg.id) || (m.timestamp === timestamp && m.body === newMsg.body));
                            if (exists) return prev;
                            return [...prev, newMsg];
                        });
                    }

                    setChats((prev) => {
                        if (!Array.isArray(prev)) return [];
                        const existingChat = prev.find((c) => c.id === data.chatId);
                        if (existingChat) {
                            return prev.map((c) => c.id === data.chatId ? {
                                ...c,
                                lastMessage: { body: data.text || '', timestamp },
                                unreadCount: selectedChat?.id === data.chatId ? 0 : (c.unreadCount || 0) + 1,
                                time: new Date(timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }),
                                assignedScript: data.assignedScript || c.assignedScript
                            } : c);
                        }
                        return prev;
                    });
                } catch (err) { }
            });

            socket.on('bot_status_change', (data) => {
                if (!data) return;
                setChats(prev => Array.isArray(prev) ? prev.map(c => c.id === data.chatId ? { ...c, isPaused: data.paused } : c) : []);
                if (selectedChat && selectedChat.id === data.chatId) {
                    setSelectedChat(prev => ({ ...prev, isPaused: data.paused }));
                }
            });

            socket.on('global_pause_changed', (data) => {
                if (data && typeof data.globalPause !== 'undefined') {
                    setGlobalPause(data.globalPause);
                }
            });
        }
        return () => { if (socket) { socket.off('new_log'); socket.off('bot_status_change'); socket.off('global_pause_changed'); } };
    }, [socket, selectedChat]);

    const [availableScripts, setAvailableScripts] = useState({ v3: {}, v4: {} });

    useEffect(() => {
        const fetchScriptAndPrices = async () => {
            try {
                const [scriptV3, scriptV4, pricesRes] = await Promise.all([
                    api.get('/api/script/v3'),
                    api.get('/api/script/v4'),
                    api.get('/api/prices')
                ]);

                const scripts = {
                    v3: scriptV3.data?.flow || {},
                    v4: scriptV4.data?.flow || {}
                };
                setAvailableScripts(scripts);
                // Fallback initial flow
                setScriptFlow(scripts.v3);

                if (pricesRes.data) setPrices(pricesRes.data);
            } catch (e) { console.error('Error fetching scripts:', e); }
        };
        fetchScriptAndPrices();
    }, []);

    useEffect(() => {
        if (!selectedChat) return;
        // Dynamically switch script flow based on user's assigned script
        const targetVersion = selectedChat.assignedScript || 'v3';
        if (availableScripts[targetVersion]) {
            setScriptFlow(availableScripts[targetVersion]);
        }
    }, [selectedChat, availableScripts]);

    useEffect(() => {
        if (!selectedChat) return;
        setMessages([]);
        setSummaryText(null);
        const fetchMessages = async () => {
            setLoading(true);
            try {
                const res = await api.get(`/api/history/${selectedChat.id}`);
                setMessages(res.data);
            } catch (e) { setMessages([]); }
            setLoading(false);
        };
        fetchMessages();
    }, [selectedChat?.id]);

    const scrollToBottom = () => {
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
    };

    useLayoutEffect(scrollToBottom, [messages]);

    const formatScriptMessage = (text, chat = null) => {
        if (!text) return text;
        let result = text;
        if (prices) {
            let p = prices;
            result = result.replace(/{{PRICE_CAPSULAS_60}}/g, p['Cápsulas']?.['60'] || '46.900')
                .replace(/{{PRICE_CAPSULAS_120}}/g, p['Cápsulas']?.['120'] || '66.900')
                .replace(/{{PRICE_SEMILLAS_60}}/g, p['Semillas']?.['60'] || '36.900')
                .replace(/{{PRICE_SEMILLAS_120}}/g, p['Semillas']?.['120'] || '49.900')
                .replace(/{{PRICE_GOTAS_60}}/g, p['Gotas']?.['60'] || '48.900')
                .replace(/{{PRICE_GOTAS_120}}/g, p['Gotas']?.['120'] || '68.900')
                .replace(/{{ADICIONAL_MAX}}/g, p.adicionalMAX || '6.000')
                .replace(/{{COSTO_LOGISTICO}}/g, p.costoLogistico || '18.000');
        }
        // Resolve order-specific placeholders from the user's sales state
        const ctx = chat || selectedChat;
        if (ctx) {
            const product = ctx.selectedProduct || ctx.cart?.[0]?.product || 'Producto';
            const plan = ctx.selectedPlan || ctx.cart?.[0]?.plan || '60';
            let total = ctx.totalPrice || '';
            if (!total && ctx.cart?.length > 0) {
                total = ctx.cart.reduce((s, i) => s + parseInt((i.price || '0').toString().replace(/\D/g, '')), 0).toLocaleString('es-AR');
            }
            result = result.replace(/{{PRODUCT}}/g, product)
                .replace(/{{PLAN}}/g, plan)
                .replace(/{{TOTAL}}/g, total ? `$${total}` : '$0');
        }
        return result;
    };

    const handleDownloadHistory = () => {
        if (!selectedChat || messages.length === 0) {
            toast.warning('No hay mensajes para descargar');
            return;
        }

        let txtContent = `Analiza esta conversacion:\n\n`;

        messages.forEach(msg => {
            let dateStr = '';
            try {
                const d = new Date(msg.timestamp);
                if (!isNaN(d.getTime())) {
                    // Formato: [10:56, 26/2/2026]
                    dateStr = `[${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })}, ${d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}] `;
                }
            } catch (e) { }

            const sender = msg.fromMe ? 'Herbalis' : (selectedChat.name || selectedChat.id).split('@')[0];
            let body = msg.body || '';

            // Clean up media placeholders if any
            if (body.startsWith('MEDIA_IMAGE:')) body = '[Imagen adjunta]';
            if (body.startsWith('MEDIA_AUDIO:')) {
                const parts = body.split('|');
                const trans = parts[1] ? parts[1].replace('TRANSCRIPTION:', '').trim() : '';
                body = trans ? `[Audio transcrito]: ${trans}` : `[Audio adjunto]`;
            }
            if (body.startsWith('🎤 Audio:')) body = `[Audio transcrito]: ${body.replace(/^🎤\s*Audio:\s*/, '').replace(/^"|"$/g, '').trim()}`;

            txtContent += `${dateStr}${sender}: ${body}\n`;
        });

        const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safePhone = selectedChat.id.split('@')[0].replace(/\D/g, '');
        a.download = `chat_${safePhone}_${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success('Historial descargado para análisis');
    };

    const handleSend = async (e) => {
        e.preventDefault();
        if (!input.trim() || !selectedChat) return;
        const text = input;

        if (text.trim().toLowerCase() === '/descargar') {
            handleDownloadHistory();
            setInput('');
            return;
        }

        setInput('');
        setMessages(prev => [...prev, { id: `temp-${Date.now()}`, fromMe: true, body: text, type: 'chat', timestamp: Date.now(), pending: true }]);
        try { await api.post('/api/send', { chatId: selectedChat.id, message: text }); }
        catch (e) { toast.error('Error al enviar mensaje'); }
    };

    const handleSendScriptStep = (stepKey) => {
        const step = scriptFlow[stepKey];
        if (step?.response) setInput(formatScriptMessage(step.response, selectedChat));
    };

    // Manual order completion — admin clicks the final step button
    const handleManualCompletion = async () => {
        if (!selectedChat) return;

        try {
            await api.post('/api/orders/manual-complete', { chatId: selectedChat.id });
            toast.success('Pedido ingresado y confirmación enviada ✅');
            setInput(''); // Clear input if it had anything
        } catch (e) {
            toast.error('Error al registrar pedido: ' + (e.response?.data?.error || e.message));
        }
    };

    // Delete Message Action
    const handleDeleteMessage = async (msgId) => {
        if (!selectedChat || !msgId) return;
        if (!window.confirm('¿Eliminar este mensaje para todos?')) return;
        try {
            setMessages(prev => prev.filter(m => m.id !== msgId));
            await api.delete('/api/messages', {
                data: { chatId: selectedChat.id, messageId: msgId }
            });
            toast.success('Mensaje eliminado');
        } catch (e) {
            toast.error('Error eliminando mensaje');
        }
    };

    const handleToggleBot = async () => {
        const newStatus = !selectedChat.isPaused;
        try {
            await api.post('/api/toggle-bot', { chatId: selectedChat.id, paused: newStatus });
            setSelectedChat(prev => ({ ...prev, isPaused: newStatus }));
            toast.success(newStatus ? 'Bot pausado' : 'Bot reactivado');
        } catch (e) { toast.error('Error cambiando estado del bot'); }
    };

    const handleClearChat = async () => {
        if (window.confirm("¿Reiniciar historial de este usuario?")) {
            try {
                await api.post('/api/reset-chat', { chatId: selectedChat.id });
                setMessages([]);
                toast.success('Chat reiniciado');
            } catch (e) {
                console.error("Error al reiniciar chat:", e);
                toast.error('Error: ' + (e.response?.data?.error || e.message));
            }
        }
    };

    const handleSummarize = async () => {
        setSummarizing(true);
        try {
            const res = await api.get(`/api/summarize/${selectedChat.id}`);
            setSummaryText(res.data.summary || res.data.message);
        } catch (e) { toast.error('Error generating resumen'); }
        setSummarizing(false);
    };

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

    const handleFileSelect = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) return toast.warning('Solo imágenes');
        const reader = new FileReader();
        reader.onload = () => {
            const base64Full = reader.result;
            setAttachment({ file, preview: base64Full, base64: base64Full.split(',')[1], mimetype: file.type });
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    const handleCopySale = (order) => {
        const rawPhone = selectedChat?.id?.split('@')[0] || '';
        const phoneDisplay = rawPhone.length > 13 ? `Oculto por Anuncio Meta (${rawPhone})` : rawPhone || 'Desconocido';

        const priceFormatted = order.precio || '0';
        const textToCopy = `Nombre: ${selectedChat?.name || order.nombre || 'Cliente'}
Dirección: ${order.calle}, ${order.ciudad} (CP: ${order.cp})
Producto: ${order.producto}
Plan: ${order.plan || '120'} Días
A pagar: $${priceFormatted}
Teléfono: ${phoneDisplay}`;

        navigator.clipboard.writeText(textToCopy)
            .then(() => toast.success('Venta copiada al portapapeles'))
            .catch(() => toast.error('Error al copiar venta'));
    };

    const handleSendMedia = async () => {
        setSendingMedia(true);
        try {
            await api.post('/api/send-media', {
                chatId: selectedChat.id, base64: attachment.base64, mimetype: attachment.mimetype, filename: attachment.file.name, caption: input.trim()
            });
            setMessages(prev => [...prev, { id: `temp-media-${Date.now()}`, fromMe: true, body: `📷 Imagen enviada: ${input.trim()}`, type: 'chat', timestamp: Date.now(), pending: true }]);
            setAttachment(null);
            setInput('');
        } catch (e) { toast.error('Error al enviar imagen'); }
        setSendingMedia(false);
    };

    const renderMessageBody = (msg) => {
        if (msg.body && msg.body.startsWith('MEDIA_IMAGE:')) {
            const url = msg.body.split('|')[0].replace('MEDIA_IMAGE:', '');
            return <img src={`${API_URL}${url}`} alt="Media" className="rounded-2xl max-w-full h-auto max-h-64 object-cover border border-white/2 dark:border-slate-700/20 shadow-sm" />;
        }
        if (msg.body && (msg.body.startsWith('MEDIA_AUDIO:') || msg.body.startsWith('🎤'))) {
            let transcription = msg.body.includes('TRANSCRIPTION:') ? msg.body.split('TRANSCRIPTION:')[1].trim() : msg.body.replace(/^🎤\s*Audio:\s*/, '').replace(/^"|"$/g, '').trim();
            return (
                <div className="space-y-3 min-w-[200px]">
                    <div className="flex items-center gap-3 bg-black/10 rounded-2xl p-3 border border-white/1 dark:border-slate-700/10">
                        <div className="w-10 h-10 rounded-full bg-emerald-500/90 text-white flex items-center justify-center shadow-lg"><Play className="w-5 h-5" /></div>
                        <div className="flex-1 h-2 bg-black/10 rounded-full overflow-hidden text-emerald-500 font-mono text-[8px] leading-none text-center">Audio Player</div>
                    </div>
                    {transcription && <div className="bg-white/4 dark:bg-slate-800/40 p-3 rounded-xl text-xs italic text-slate-800 font-medium">📝 "{transcription}"</div>}
                </div>
            );
        }
        return <p className="whitespace-pre-wrap font-medium">{msg.body}</p>;
    };

    return (
        <div className="h-full flex flex-col md:flex-row animate-fade-in relative overflow-hidden bg-slate-50/5 dark:bg-slate-800/50 rounded-[2rem] border border-white/6 dark:border-slate-700/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
            {/* Ambient Background Glow */}
            <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-400/10 blur-[100px] rounded-full pointer-events-none"></div>
            <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-indigo-400/10 blur-[100px] rounded-full pointer-events-none"></div>

            {/* SIDEBAR: Contacts */}
            <div className={`w-full md:w-72 lg:w-[300px] flex-shrink-0 border-r border-white/5 dark:border-slate-700/50 flex-col bg-white/4 dark:bg-slate-800/40 backdrop-blur-md z-10 ${selectedChat ? 'hidden md:flex' : 'flex'}`}>
                {/* Search Header */}
                <div className="p-5 border-b border-white/5 dark:border-slate-700/50 bg-white/3 dark:bg-slate-800/30 backdrop-blur-sm">
                    <div className="relative group">
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Buscar chats..."
                            className="w-full bg-white/6 dark:bg-slate-800/60 border border-white rounded-2xl pl-12 pr-4 py-3 text-sm focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-300 transition-all text-slate-700 shadow-inner font-medium placeholder:text-slate-400"
                        />
                        <span className="absolute left-4 top-3 text-slate-400 group-focus-within:text-indigo-500 transition-colors"><Search className="w-5 h-5" /></span>
                    </div>
                </div>

                {/* Contact List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
                    {filteredChats.map(chat => (
                        <div key={chat.id} onClick={() => setSelectedChat(chat)} className={`p-4 mb-2 rounded-2xl flex cursor-pointer transition-all duration-300 ${selectedChat?.id === chat.id ? 'bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 transform scale-[1.02]' : 'hover:bg-white/80 dark:bg-slate-800/80'}`}>
                            <div className="flex-1 min-w-0">
                                <div className="flex justify-between items-start mb-1 gap-2">
                                    <h3 className={`font-extrabold text-sm truncate flex flex-wrap items-center gap-1.5 ${selectedChat?.id === chat.id ? 'text-white' : 'text-slate-800'}`}>
                                        {chat.isPaused && <span className="w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)] animate-pulse" title="Bot Pausado"></span>}
                                        <span className="truncate max-w-[170px]">{chat.name}</span>
                                        {chat.hasBought && <span title="Cliente Recurrente" className="inline-flex items-center text-[9px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-md font-extrabold shadow-sm"><ShoppingCart className="w-2.5 h-2.5 mr-0.5" /> Cliente</span>}
                                    </h3>
                                    <span className={`text-[10px] font-bold font-mono ${selectedChat?.id === chat.id ? 'text-indigo-100' : 'text-slate-400'}`}>{chat.time}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <p className={`text-xs truncate font-medium flex-1 ${selectedChat?.id === chat.id ? 'text-indigo-100' : 'text-slate-500'}`}>{chat.lastMessage?.body || 'Sin mensajes'}</p>
                                    {chat.unread > 0 && selectedChat?.id !== chat.id && (
                                        <span className="w-5 h-5 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center shadow-md">
                                            {chat.unread}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* MAIN CHAT AREA */}
            <div className={`flex-1 flex-col min-w-0 bg-transparent relative z-0 ${selectedChat ? 'flex' : 'hidden md:flex'}`}>
                {selectedChat ? (
                    <>
                        {/* Header */}
                        <div className="flex-shrink-0 min-h-[5rem] border-b border-white/5 dark:border-slate-700/50 flex items-center justify-between px-3 sm:px-8 bg-white/5 dark:bg-slate-800/50 backdrop-blur-md shadow-[0_2px_10px_rgba(0,0,0,0.02)] z-20 overflow-x-auto custom-scrollbar no-scrollbar py-2">
                            <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0 w-full sm:w-auto mb-2 sm:mb-0">
                                {/* Back Button (Mobile Only) */}
                                <button
                                    onClick={() => setSelectedChat(null)}
                                    className="md:hidden p-2 -ml-2 bg-white/6 dark:bg-slate-800/60 border border-slate-200 rounded-xl text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 shadow-sm transition-all"
                                    title="Volver a Contactos"
                                >
                                    <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7" /></svg>
                                </button>

                                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white flex items-center justify-center font-bold text-base sm:text-lg shadow-md shadow-indigo-500/20 flex-shrink-0">
                                    {selectedChat.name.substring(0, 2).toUpperCase()}
                                </div>
                                <div className="min-w-0 pr-2">
                                    <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 flex-wrap">
                                        <h2 className="font-extrabold text-slate-800 text-[14px] sm:text-lg tracking-tight truncate max-w-[130px] sm:max-w-xs">{selectedChat.name}</h2>
                                        {selectedChat.assignedScript && (
                                            <span className="self-start sm:self-auto mt-0.5 sm:mt-0 px-2 sm:px-3 py-0.5 sm:py-1 rounded-full bg-indigo-100 text-[9px] sm:text-[10px] font-bold text-indigo-700 uppercase tracking-widest border border-indigo-200">
                                                Flow: {selectedChat.assignedScript}
                                            </span>
                                        )}
                                    </div>
                                    <p className={`text-[9px] sm:text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 mt-0.5 ${selectedChat.isPaused ? 'text-rose-500' : 'text-emerald-500'}`}>
                                        <span className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${selectedChat.isPaused ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'}`}></span>
                                        {selectedChat.isPaused ? 'Auto-Bot Pausado' : 'Auto-Bot Activo'}
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center justify-start sm:justify-end gap-1 sm:gap-3 overflow-x-visible w-full sm:w-auto pb-1 sm:pb-0">
                                {selectedChat.hasBought && (
                                    <button onClick={() => setShowOrdersPanel(!showOrdersPanel)} className="p-2.5 sm:p-3 flex-shrink-0 rounded-xl bg-indigo-100/80 text-indigo-700 hover:bg-indigo-200 hover:shadow-md transition-all" title="Registro de Compras">
                                        <ShoppingCart className="w-4 h-4 sm:w-5 sm:h-5" />
                                    </button>
                                )}

                                <button onClick={handleClearChat} className="p-2.5 sm:p-3 flex-shrink-0 rounded-xl bg-rose-100/80 text-rose-600 hover:bg-rose-200 hover:shadow-md transition-all" title="Reiniciar Memoria e Historial">
                                    <Trash className="w-5 h-5" />
                                </button>
                                <button onClick={handleToggleBot} className={`p-2.5 sm:p-3 flex-shrink-0 rounded-xl text-white shadow-md transition-all hover:brightness-110 hover:-translate-y-0.5 ${globalPause || selectedChat.isPaused ? 'bg-gradient-to-r from-emerald-500 to-teal-500' : 'bg-gradient-to-r from-amber-500 to-orange-500'}`} title={globalPause ? 'Bot Pausado Globalmente' : (selectedChat.isPaused ? 'Reactivar Auto-Bot' : 'Pausar Auto-Bot')}>
                                    {globalPause || selectedChat.isPaused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
                                </button>
                                <button onClick={() => setShowScriptPanel(!showScriptPanel)} className="p-2.5 sm:p-3 flex-shrink-0 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-md shadow-indigo-500/30 hover:shadow-lg hover:shadow-indigo-500/40 hover:-translate-y-0.5 transition-all active:scale-95" title="Guión">
                                    <ScriptIcon className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        {/* Orders Panel */}
                        {showOrdersPanel && selectedChat.hasBought && (
                            <div className="border-b border-white/6 dark:border-slate-700/60 bg-white/6 dark:bg-slate-800/60 backdrop-blur-xl p-4 sm:p-5 z-10 animate-fade-in shadow-sm relative overflow-hidden shrink-0">
                                <div className="absolute -top-10 -right-10 w-24 h-24 bg-indigo-400/20 blur-[40px] rounded-full pointer-events-none"></div>
                                <div className="absolute -bottom-10 -left-10 w-24 h-24 bg-purple-400/20 blur-[40px] rounded-full pointer-events-none"></div>

                                <div className="flex justify-between items-center mb-5 relative z-10">
                                    <div className="flex items-center gap-2">
                                        <div className="w-8 h-8 rounded-xl bg-indigo-100/80 text-indigo-600 flex items-center justify-center shadow-sm">
                                            <ShoppingCart className="w-4 h-4" />
                                        </div>
                                        <h3 className="font-extrabold text-slate-800 tracking-tight text-sm">Registro de Pedidos</h3>
                                        <span className="bg-slate-100 text-slate-500 text-[10px] font-bold px-2 py-0.5 rounded-full">{selectedChat.pastOrders?.length || 0}</span>
                                    </div>
                                    <button onClick={() => setShowOrdersPanel(false)} className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-rose-500 bg-white/5 dark:bg-slate-800/50 hover:bg-rose-50 rounded-xl transition-all border border-transparent shadow-sm hover:border-rose-100">✕</button>
                                </div>

                                <div className="flex flex-col gap-5 max-h-[60vh] overflow-y-auto custom-scrollbar relative z-10 pr-1 pb-4">
                                    {selectedChat.pastOrders?.map((order, i) => (
                                        <div key={i} className="bg-white border border-slate-200 p-5 rounded-2xl flex flex-col shadow-sm hover:shadow-md transition-shadow relative overflow-hidden">

                                            {/* Header de Tarjeta */}
                                            <div className="flex justify-between items-center mb-4 pb-3 border-b border-slate-100">
                                                <div className="flex items-center gap-3">
                                                    <span className="px-3 py-1 bg-indigo-50 text-indigo-700 text-[10px] font-black uppercase tracking-widest rounded-lg border border-indigo-100">{order.status || 'Completado'}</span>
                                                    <span className="text-[11px] font-bold text-slate-400 font-mono">{order.createdAt || 'Fecha desconocida'}</span>
                                                </div>
                                                <button onClick={() => handleCopySale(order)} className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white text-[10px] font-bold uppercase tracking-wider rounded-lg transition-colors shadow-md shadow-indigo-500/30">
                                                    <ScriptIcon className="w-3 h-3" /> Copiar Venta
                                                </button>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                                {/* Columna 1: Destino y Logística */}
                                                <div>
                                                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Destino de Entrega</h4>
                                                    <div className="space-y-3">
                                                        <div className="grid grid-cols-2 gap-2 text-[12px]">
                                                            <div>
                                                                <span className="text-slate-500 font-medium">Ubicación:</span>
                                                                <p className="font-bold text-slate-800">{order.ciudad}</p>
                                                            </div>
                                                            <div>
                                                                <span className="text-slate-500 font-medium">C. Postal:</span>
                                                                <p className="font-bold text-slate-800">{order.cp || '-'}</p>
                                                            </div>
                                                            <div className="col-span-2">
                                                                <span className="text-slate-500 font-medium">Domicilio:</span>
                                                                <p className="font-bold text-slate-800">{order.calle || '-'}</p>
                                                            </div>
                                                        </div>

                                                        {order.tracking && (
                                                            <div className="pt-3 mt-3 border-t border-slate-100 flex flex-col gap-2">
                                                                <div className="flex items-center justify-between">
                                                                    <div>
                                                                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-0.5">Tracking TCA</span>
                                                                        <span className="font-mono text-xs font-bold text-slate-700">{order.tracking}</span>
                                                                    </div>
                                                                    <button onClick={() => handleTrackOrder(order.tracking)} disabled={isTracking} className="bg-blue-50 hover:bg-blue-100 text-blue-600 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors border border-blue-200 flex items-center gap-1.5 disabled:opacity-50">
                                                                        {isTracking ? 'Consultando...' : '🔍 Rastrear'}
                                                                    </button>
                                                                </div>

                                                                {/* Historial Tracking */}
                                                                {trackingData && (
                                                                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-2 max-h-40 overflow-y-auto custom-scrollbar mt-2 shadow-inner">
                                                                        {trackingData.success ? (
                                                                            trackingData.events && trackingData.events.length > 0 ? (
                                                                                <div className="space-y-2">
                                                                                    {trackingData.events.map((ev, i) => (
                                                                                        <div key={i} className="bg-white p-2 rounded flex flex-col shadow-sm text-[10px] border border-slate-100">
                                                                                            <span className="font-bold text-slate-700">{ev.fecha} - <span className="text-blue-500">{ev.planta}</span></span>
                                                                                            <span className="text-slate-500 line-clamp-2">{ev.historia}</span>
                                                                                        </div>
                                                                                    ))}
                                                                                </div>
                                                                            ) : <p className="text-xs text-slate-500 italic">Aún no hay movimientos</p>
                                                                        ) : <p className="text-xs text-rose-500 font-bold">Tracking Inválido</p>}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* Columna 2: Mercadería */}
                                                <div className="md:border-l md:border-slate-100 md:pl-6">
                                                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Mercadería Adquirida</h4>
                                                    <div className="space-y-3">
                                                        <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                                                            <p className="text-slate-800 font-extrabold text-sm mb-1">{order.producto}</p>
                                                            <p className="text-indigo-600 font-bold text-[11px]">Tratamiento de {order.plan} días</p>
                                                        </div>

                                                        <div className="flex justify-between items-end pt-2">
                                                            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">A Pagar</span>
                                                            <span className="text-emerald-600 font-black text-xl">${order.precio || '0'}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                        </div>
                                    ))}
                                    {(!selectedChat.pastOrders || selectedChat.pastOrders.length === 0) && (
                                        <div className="text-center p-8 bg-slate-50 rounded-2xl border border-slate-100 border-dashed">
                                            <p className="text-slate-400 font-medium text-sm">No hay registros de compras anteriores.</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Messages Area */}
                        <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 pt-8 pb-2 space-y-6 custom-scrollbar">
                            {loading ? (
                                <div className="w-full h-full flex items-center justify-center">
                                    <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                                </div>
                            ) : messages.map((msg, idx) => (
                                <div key={idx} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[75%] p-4 text-sm leading-relaxed shadow-sm relative group ${msg.fromMe ? 'bg-gradient-to-br from-indigo-600 to-purple-600 text-white rounded-3xl rounded-tr-sm shadow-indigo-500/20' : 'bg-white text-slate-800 rounded-3xl rounded-tl-sm border border-white/60 dark:border-slate-700/60'}`}>
                                        {renderMessageBody(msg)}
                                        <span className={`text-[10px] block text-right mt-2 font-mono font-bold ${msg.fromMe ? 'text-indigo-200' : 'text-slate-400'}`}>
                                            {new Date(msg.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })}
                                        </span>

                                        {/* Delete Button (Only for own messages) */}
                                        {msg.fromMe && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleDeleteMessage(msg.id); }}
                                                className="absolute -left-9 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-full transition-all"
                                                title="Eliminar mensaje para todos"
                                            >
                                                <Trash className="w-5 h-5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Input Area */}
                        <div className="flex-shrink-0 p-3 sm:px-6 sm:py-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:pb-4 bg-white/5 dark:bg-slate-800/50 backdrop-blur-md border-t border-white/6 dark:border-slate-700/60 z-20">
                            {attachment && (
                                <div className="mb-2 p-3 sm:p-4 bg-white/8 dark:bg-slate-800/80 rounded-2xl border border-indigo-100 shadow-sm flex items-center gap-4">
                                    <img src={attachment.preview} alt="Preview" className="w-12 h-12 sm:w-16 sm:h-16 object-cover rounded-xl" />
                                    <div className="flex-1 min-w-0">
                                        <p className="font-bold text-slate-800 text-sm truncate">{attachment.file.name}</p>
                                        <p className="text-xs text-slate-500">{(attachment.file.size / 1024).toFixed(0)} KB</p>
                                    </div>
                                    <button type="button" onClick={() => setAttachment(null)} className="p-2 sm:p-2 bg-slate-100 hover:bg-rose-100 hover:text-rose-600 rounded-xl transition-colors shrink-0">✕</button>
                                </div>
                            )}
                            <form onSubmit={attachment ? (e) => { e.preventDefault(); handleSendMedia(); } : handleSend} className="flex gap-1.5 sm:gap-4 items-center w-full">
                                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />
                                <button type="button" onClick={() => fileInputRef.current?.click()} className="w-11 h-11 sm:w-14 sm:h-14 flex items-center justify-center shrink-0 rounded-xl sm:rounded-2xl bg-white border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all shadow-sm">
                                    <Paperclip className="w-6 h-6" />
                                </button>
                                <input
                                    type="text"
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    placeholder="Mensaje..."
                                    className="w-full min-w-0 flex-1 bg-white border border-slate-200 rounded-xl sm:rounded-2xl px-3 sm:px-6 py-2.5 sm:py-4 text-slate-800 font-medium focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all shadow-inner placeholder:text-slate-400 text-[15px] sm:text-base"
                                />
                                <button type="submit" disabled={(!input.trim() && !attachment) || sendingMedia} className="w-11 h-11 sm:w-14 sm:h-14 flex items-center justify-center shrink-0 rounded-xl sm:rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-105 active:scale-95 transition-all disabled:opacity-50 disabled:scale-100">
                                    {sendingMedia ? <div className="w-5 h-5 sm:w-6 sm:h-6 border-2 border-white/5 dark:border-slate-700/50 border-t-white rounded-full animate-spin"></div> : <Send className="w-5 h-5" />}
                                </button>
                            </form>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center p-12">
                        <div className="text-center">
                            <div className="w-24 h-24 bg-white/6 dark:bg-slate-800/60 backdrop-blur-xl rounded-full flex items-center justify-center mx-auto mb-6 shadow-sm border border-white">
                                <span className="text-4xl">👋</span>
                            </div>
                            <h2 className="text-2xl font-extrabold text-slate-800 mb-2">Inbox de Mensajes V2</h2>
                            <p className="text-slate-500 font-medium">Seleccioná un chat del sidebar para iniciar a responder</p>
                        </div>
                    </div>
                )}
            </div>

            {/* RIGHT PANEL - AI & Scripts Context Drawer (V3 Ported to V2) */}
            {selectedChat && showScriptPanel && (
                <div className="w-full md:w-[350px] shrink-0 border-l border-white/5 dark:border-slate-700/50 bg-slate-50/4 dark:bg-slate-800/40 backdrop-blur-xl flex flex-col z-30 md:relative absolute right-0 top-0 bottom-0 overflow-y-auto animate-fade-in shadow-[-10px_0_30px_rgba(0,0,0,0.05)] h-full">

                    <div className="p-5 border-b border-white/5 dark:border-slate-700/50 flex justify-between items-center bg-white/5 dark:bg-slate-800/50 shadow-sm z-10 sticky top-0 backdrop-blur-md">
                        <h3 className="font-extrabold text-slate-800 text-[15px] flex items-center gap-2">
                            <Bot className="w-5 h-5" /> Asistente IA
                        </h3>
                        <button onClick={() => setShowScriptPanel(false)} className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-white/6 dark:bg-slate-800/60 rounded-xl transition-all">
                            ✕
                        </button>
                    </div>

                    <div className="p-5 flex-1 flex flex-col gap-6 custom-scrollbar overflow-y-auto">

                        {/* Summary Block */}
                        <div className="bg-white/6 dark:bg-slate-800/60 rounded-2xl p-4 shadow-sm border border-white/6 dark:border-slate-700/60 relative group">
                            <div className="flex justify-between items-center mb-3">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Contexto IA</h4>
                                <button onClick={handleSummarize} disabled={summarizing || messages.length === 0} className="text-[10px] font-bold text-indigo-700 bg-indigo-100/80 px-2.5 py-1 rounded-lg hover:bg-indigo-200 transition-colors disabled:opacity-50">
                                    {summarizing ? 'Generando...' : 'Resumir Chat'}
                                </button>
                            </div>
                            <div className="min-h-[80px]">
                                {summaryText ? (
                                    <div className="text-xs font-medium text-slate-700 whitespace-pre-wrap leading-relaxed">
                                        {summaryText}
                                        <button onClick={() => setSummaryText(null)} className="absolute top-2 right-2 text-slate-400 hover:text-rose-500 bg-white/8 dark:bg-slate-800/80 rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"><Trash className="w-5 h-5" /></button>
                                    </div>
                                ) : (
                                    <span className="text-slate-400 italic text-xs flex items-center h-full justify-center text-center">Analiza la intención de compra y sentimientos del cliente.</span>
                                )}
                            </div>
                        </div>

                        {/* Script Injection Area */}
                        <div className="flex-1 pb-6">
                            <div className="flex items-center justify-between mb-3 px-1">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Guión Sugerido</h4>
                                <span className="bg-white/8 dark:bg-slate-800/80 shadow-sm border border-white text-indigo-600 text-[9px] px-2 py-0.5 rounded-md font-bold uppercase tracking-wider">{selectedChat.assignedScript || 'V3'}</span>
                            </div>

                            {Object.keys(scriptFlow).length > 0 ? (
                                <div className="space-y-2.5">
                                    {Object.keys(scriptFlow).map((stepKey) => {
                                        const step = scriptFlow[stepKey];
                                        if (!step?.response) return null;
                                        return (
                                            <button
                                                key={stepKey}
                                                onClick={() => {
                                                    // Magic: Auto pause Bot if human takes over
                                                    if (!selectedChat.isPaused) handleToggleBot();
                                                    setInput(formatScriptMessage(step.response, selectedChat));
                                                }}
                                                className="w-full text-left p-3.5 rounded-2xl border border-white/6 dark:border-slate-700/60 bg-white/4 dark:bg-slate-800/40 hover:bg-white hover:border-indigo-300 transition-all shadow-sm hover:shadow-md group cursor-pointer relative overflow-hidden"
                                            >
                                                <div className="absolute top-0 right-0 w-12 h-12 bg-indigo-50 rounded-bl-full -mr-6 -mt-6 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                                                <div className="flex items-center justify-between mb-2 text-[10px] font-black text-slate-400 uppercase tracking-widest group-hover:text-indigo-600 relative z-10 transition-colors">
                                                    <span>{stepKey.replace(/_/g, ' ')}</span>
                                                    <span className="opacity-0 group-hover:opacity-100 transform translate-x-2 group-hover:translate-x-0 transition-all duration-300">Insertar +</span>
                                                </div>
                                                <p className="text-[11.5px] text-slate-700 font-medium line-clamp-3 leading-relaxed relative z-10">
                                                    {formatScriptMessage(step.response, selectedChat)}
                                                </p>
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : (
                                <p className="text-xs text-slate-400 italic text-center mt-6 bg-white/4 dark:bg-slate-800/40 p-4 rounded-xl border border-white/5 dark:border-slate-700/50">No hay módulos de guión en este flow.</p>
                            )}
                        </div>

                        {/* Manual Completion Button */}
                        <div className="px-1 pb-6">
                            <button
                                onClick={() => {
                                    if (!selectedChat.isPaused) handleToggleBot();
                                    handleManualCompletion();
                                }}
                                className="w-full text-left p-4 rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/60 hover:bg-emerald-100 hover:border-emerald-400 transition-all shadow-sm hover:shadow-md group cursor-pointer relative overflow-hidden"
                            >
                                <div className="flex items-center justify-between mb-2 text-[10px] font-black text-emerald-600 uppercase tracking-widest relative z-10">
                                    <span>🚀 Pedido Ingresado</span>
                                    <span className="opacity-0 group-hover:opacity-100 transform translate-x-2 group-hover:translate-x-0 transition-all duration-300">Confirmar Venta</span>
                                </div>
                                <p className="text-[11.5px] text-emerald-700 font-medium leading-relaxed relative z-10 line-clamp-2">
                                    Envía la confirmación final y registra el pedido en Ventas automáticamente.
                                </p>
                            </button>
                        </div>

                    </div>
                </div>
            )}
        </div>
    );
};

export default CommsViewV2;
