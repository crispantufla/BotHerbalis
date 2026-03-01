import React, { useState, useEffect, useRef } from 'react';
import api from '../../../config/axios';
import { useSocket } from '../../../context/SocketContext';
import { API_URL } from '../../../config/api';
import { useToast } from '../../ui/Toast';

const Icons = {
    Search: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
    AI: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>,
    Play: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Pause: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Trash: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
    Script: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
    ChevronDown: () => <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>,
    Send: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>,
    Clip: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
};

const CommsView = ({ initialChatId, onChatSelected }) => {
    const { socket } = useSocket();
    const { toast } = useToast();
    const [chats, setChats] = useState([]);
    const [selectedChat, setSelectedChat] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [loading, setLoading] = useState(false);
    const [showScriptPanel, setShowScriptPanel] = useState(false);
    const [scriptFlow, setScriptFlow] = useState({});
    const [availableScripts, setAvailableScripts] = useState({ v3: {}, v4: {} });
    const [summarizing, setSummarizing] = useState(false);
    const [summaryText, setSummaryText] = useState(null);
    const [attachment, setAttachment] = useState(null); // { file, preview, base64, mimetype }
    const [sendingMedia, setSendingMedia] = useState(false);
    const [prices, setPrices] = useState(null);
    const [activeOrder, setActiveOrder] = useState(null);
    const [loadingOrder, setLoadingOrder] = useState(false);
    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);

    // Filter chats
    const filteredChats = searchTerm
        ? chats.filter(c => {
            const term = searchTerm.toLowerCase();
            const nameMatch = c.name?.toLowerCase().includes(term);
            const phoneMatch = c.id?.replace(/\D/g, '').includes(term);
            const messageMatch = typeof c.lastMessage?.body === 'string' && c.lastMessage.body.toLowerCase().includes(term);
            return nameMatch || phoneMatch || messageMatch;
        })
        : chats;

    // Handle initial chat selection from parent navigation
    useEffect(() => {
        if (initialChatId && chats.length > 0) {
            const chatToSelect = chats.find(c => c.id === initialChatId);
            if (chatToSelect) {
                setSelectedChat(chatToSelect);
            } else {
                // If not in the current list, we create a temporary object so it can fetch history
                setSelectedChat({ id: initialChatId, name: initialChatId });
            }
            if (onChatSelected) onChatSelected();
        }
    }, [initialChatId, chats, onChatSelected]);

    // Load Chats
    useEffect(() => {
        const fetchChats = async () => {
            try {
                const res = await api.get('/api/chats');
                setChats(res.data);
            } catch (e) {
                console.error("Error fetching chats:", e);
                setChats([]);
            }
        };

        fetchChats();

        if (socket) {
            // Listen for new messages (logAndEmit from backend)
            socket.on('new_log', (data) => {
                try {
                    if (!data || !data.chatId) return;
                    console.log("[SOCKET] Received new_log:", data);

                    let timestamp = Date.now();
                    if (data.timestamp) {
                        const parsed = new Date(data.timestamp).getTime();
                        if (!isNaN(parsed)) timestamp = parsed;
                    }

                    // 1. Update active chat messages
                    if (selectedChat && selectedChat.id === data.chatId) {
                        const isMe = data.sender === 'bot' || data.sender === 'admin';
                        const newMsg = {
                            id: data.messageId || `socket-${timestamp}`, // Use real ID if available
                            fromMe: isMe,
                            body: data.text || '',
                            type: 'chat',
                            timestamp: timestamp
                        };
                        setMessages((prev) => {
                            if (!Array.isArray(prev)) return [newMsg];

                            // Check for pending optimistic message to REPLACE
                            if (isMe) {
                                const pendingIndex = prev.findIndex(m =>
                                    m.pending &&
                                    m.body === newMsg.body &&
                                    Math.abs(m.timestamp - timestamp) < 10000 // 10s tolerance
                                );
                                if (pendingIndex !== -1) {
                                    const updated = [...prev];
                                    updated[pendingIndex] = newMsg; // Replace pending with real
                                    return updated;
                                }
                            }

                            // Check for duplicates by ID or content/timestamp
                            const exists = prev.some(m =>
                                (m.id && m.id === newMsg.id) ||
                                (m.timestamp === timestamp && m.body === newMsg.body)
                            );
                            if (exists) return prev;

                            return [...prev, newMsg];
                        });
                    }

                    // 2. Update chat list preview
                    setChats((prev) => {
                        if (!Array.isArray(prev)) return [];
                        const incomingPhone = data.chatId.replace(/\D/g, '');
                        const existingChat = prev.find((c) => c.id === data.chatId || (incomingPhone && c.id.replace(/\D/g, '').endsWith(incomingPhone.slice(-10))));
                        if (existingChat) {
                            return prev.map((c) =>
                                c.id === existingChat.id
                                    ? {
                                        ...c,
                                        lastMessage: {
                                            body: data.text || '',
                                            timestamp: timestamp,
                                        },
                                        unreadCount: selectedChat?.id === existingChat.id ? 0 : (c.unreadCount || 0) + 1,
                                        time: new Date(timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }),
                                        assignedScript: data.assignedScript || c.assignedScript // update script assignment from socket
                                    }
                                    : c
                            );
                        } else {
                            // Add new chat to the list if it doesn't exist (fallback for v1)
                            return [{
                                id: data.chatId,
                                name: data.chatId,
                                unreadCount: selectedChat?.id === data.chatId ? 0 : 1,
                                lastMessage: { body: data.text || '', timestamp },
                                time: new Date(timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }),
                                assignedScript: data.assignedScript
                            }, ...prev];
                        }
                    });
                } catch (err) {
                    console.error("[SOCKET] Error processing new_log:", err);
                }
            });

            // Update bot status
            socket.on('bot_status_change', (data) => {
                try {
                    if (!data) return;
                    const { chatId, paused } = data;
                    setChats((prev) =>
                        Array.isArray(prev) ? prev.map((c) => (c.id === chatId ? { ...c, isPaused: paused } : c)) : []
                    );
                    if (selectedChat && selectedChat.id === chatId) {
                        setSelectedChat((prev) => ({ ...prev, isPaused: paused }));
                    }
                } catch (err) { console.error("[SOCKET] Error processing bot_status_change:", err); }
            });
        }

        return () => {
            if (socket) {
                socket.off('new_log');
                socket.off('bot_status_change');
            }
        };
    }, [socket, selectedChat]);

    // Load Script Flow
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
                setScriptFlow(scripts.v3); // Fallback

                if (pricesRes.data) setPrices(pricesRes.data);
            } catch (e) { console.error('Failed to load script or prices:', e); }
        };
        fetchScriptAndPrices();
    }, []);

    // Swap flow map based on selectedChat's script
    useEffect(() => {
        if (!selectedChat) return;
        const targetVersion = selectedChat.assignedScript || 'v3';
        if (availableScripts[targetVersion]) {
            setScriptFlow(availableScripts[targetVersion]);
        }
    }, [selectedChat, availableScripts]);


    // Format Message Helper
    const formatScriptMessage = (text) => {
        if (!text || !prices) return text;

        let formatted = text;
        formatted = formatted.replace(/{{PRICE_CAPSULAS_60}}/g, prices['Cápsulas']?.['60'] || '46.900');
        formatted = formatted.replace(/{{PRICE_CAPSULAS_120}}/g, prices['Cápsulas']?.['120'] || '66.900');
        formatted = formatted.replace(/{{PRICE_SEMILLAS_60}}/g, prices['Semillas']?.['60'] || '36.900');
        formatted = formatted.replace(/{{PRICE_SEMILLAS_120}}/g, prices['Semillas']?.['120'] || '49.900');
        formatted = formatted.replace(/{{PRICE_GOTAS_60}}/g, prices['Gotas']?.['60'] || '48.900');
        formatted = formatted.replace(/{{PRICE_GOTAS_120}}/g, prices['Gotas']?.['120'] || '68.900');
        formatted = formatted.replace(/{{ADICIONAL_MAX}}/g, prices.adicionalMAX || '6.000');
        formatted = formatted.replace(/{{COSTO_LOGISTICO}}/g, prices.costoLogistico || '18.000');

        return formatted;
    };

    // Load Messages and Active Order
    useEffect(() => {
        if (!selectedChat) return;
        setMessages([]);
        setSummaryText(null);
        setActiveOrder(null);

        const fetchMessages = async () => {
            setLoading(true);
            try {
                const res = await api.get(`/api/history/${selectedChat.id}`);
                setMessages(res.data);
            } catch (e) {
                console.error("Failed to load history", e);
                setMessages([]);
            }
            setLoading(false);
        };

        const fetchOrderInfo = async () => {
            setLoadingOrder(true);
            try {
                const res = await api.get('/api/orders');
                const orders = res.data || [];
                orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

                const chatOrder = orders.find(o => o.cliente === selectedChat.id);
                if (chatOrder) {
                    setActiveOrder(chatOrder);
                }
            } catch (e) {
                console.error("Failed to load order info", e);
            }
            setLoadingOrder(false);
        };

        fetchMessages();
        fetchOrderInfo();
    }, [selectedChat]);

    // Scroll to bottom
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };
    useEffect(scrollToBottom, [messages]);

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
                    dateStr = `[${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })}, ${d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}] `;
                }
            } catch (e) { }

            const sender = msg.fromMe ? 'Herbalis' : (selectedChat.name || selectedChat.id).split('@')[0];
            let body = msg.body || '';

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

    // Send
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

        // Optimistic add with temporary ID and pending flag
        const tempId = `temp-${Date.now()}`;
        const newMessage = {
            id: tempId,
            fromMe: true,
            body: text,
            type: 'chat',
            timestamp: Date.now(),
            pending: true
        };
        setMessages(prev => [...prev, newMessage]);

        try {
            await api.post('/api/send', {
                chatId: selectedChat.id,
                message: text
            });
        } catch (e) {
            toast.error('Error al enviar mensaje');
        }
    };

    // Send script step
    const handleSendScriptStep = (stepKey) => {
        if (!selectedChat) return;
        const step = scriptFlow[stepKey];
        if (!step?.response) return;

        const text = formatScriptMessage(step.response);
        setInput(text);
        toast.info(`Paso "${stepKey}" cargado. Editá si es necesario y enviá.`);
    };

    // Toggle Bot Action
    const handleToggleBot = async () => {
        if (!selectedChat) return;
        const newStatus = !selectedChat.isPaused;
        try {
            await api.post('/api/toggle-bot', {
                chatId: selectedChat.id,
                paused: newStatus
            });
            setSelectedChat(prev => ({ ...prev, isPaused: newStatus }));
            toast.success(newStatus ? 'Bot pausado para este chat' : 'Bot reactivado');
        } catch (e) { toast.error('Error cambiando estado del bot'); }
    };

    // Clear Chat Action
    const handleClearChat = async () => {
        if (!selectedChat) return;
        const ok = await window.confirm("¿Seguro que querés borrar el historial y reiniciar el bot para este usuario?");
        if (!ok) return;
        try {
            await api.post('/api/reset-chat', { chatId: selectedChat.id });
            setMessages([]);
            setSummaryText(null);
            toast.success('Chat reiniciado correctamente');
        } catch (e) { toast.error('Error reiniciando chat'); }
    };

    // Delete Message Action
    const handleDeleteMessage = async (msgId) => {
        if (!selectedChat || !msgId) return;
        if (!window.confirm("¿Eliminar este mensaje para todos?")) return;

        try {
            // Optimistic UI update
            setMessages(prev => prev.filter(m => m.id !== msgId));

            await api.delete('/api/messages', {
                data: { chatId: selectedChat.id, messageId: msgId }
            });
            toast.success('Mensaje eliminado');
        } catch (e) {
            console.error(e);
            toast.error('Error eliminando mensaje');
            // Revert on error (optional, or just reload)
        }
    };

    // AI Summarize
    const handleSummarize = async () => {
        if (!selectedChat) return;
        setSummarizing(true);
        try {
            const res = await api.get(`/api/summarize/${selectedChat.id}`);
            setSummaryText(res.data.summary || res.data.message || 'No se pudo generar resumen.');
            toast.success('Resumen IA generado');
        } catch (e) {
            toast.error('Error generando resumen con IA');
            setSummaryText(null);
        }
        setSummarizing(false);
    };

    // Handle file selection for attachment
    const handleFileSelect = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            toast.warning('Solo se pueden adjuntar imágenes');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            toast.warning('La imagen no puede superar 5MB');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const base64Full = reader.result; // data:image/jpeg;base64,...
            const base64Data = base64Full.split(',')[1];
            setAttachment({
                file,
                preview: base64Full,
                base64: base64Data,
                mimetype: file.type
            });
        };
        reader.readAsDataURL(file);
        // Reset input so same file can be selected again
        e.target.value = '';
    };

    // Send media attachment
    const handleSendMedia = async () => {
        if (!attachment || !selectedChat) return;
        setSendingMedia(true);
        try {
            await api.post('/api/send-media', {
                chatId: selectedChat.id,
                base64: attachment.base64,
                mimetype: attachment.mimetype,
                filename: attachment.file.name,
                caption: input.trim() || ''
            });
            // Add to messages list
            const newMsg = {
                id: `temp-media-${Date.now()}`,
                fromMe: true,
                body: `📷 Imagen enviada${input.trim() ? ': ' + input.trim() : ''}`,
                type: 'chat',
                timestamp: Date.now(),
                pending: true
            };
            setMessages(prev => [...prev, newMsg]);
            setAttachment(null);
            setInput('');
            toast.success('Imagen enviada');
        } catch (e) {
            toast.error('Error al enviar imagen');
        }
        setSendingMedia(false);
    };

    // Helper: Render Message Content
    const renderMessageBody = (msg) => {
        if (msg.body && msg.body.startsWith('MEDIA_IMAGE:')) {
            const url = msg.body.split('|')[0].replace('MEDIA_IMAGE:', '');
            const fullUrl = `${API_URL}${url}`;
            return (
                <div className="space-y-1">
                    <img src={fullUrl} alt="Received Media" className="rounded-lg max-w-full h-auto max-h-60 border border-slate-200/20" />
                    <p className="text-xs opacity-70 italic">Imagen recibida</p>
                </div>
            );
        }

        // Audio messages — visual renderer with playback
        // Handles: "MEDIA_AUDIO:/url|TRANSCRIPTION:text", "MEDIA_AUDIO:/url", "🎤 Audio: ..."
        if (msg.body && (msg.body.startsWith('MEDIA_AUDIO:') || msg.body.startsWith('🎤'))) {
            let audioUrl = null;
            let transcription = null;

            if (msg.body.startsWith('MEDIA_AUDIO:')) {
                const parts = msg.body.split('|');
                const rawUrl = parts[0].replace('MEDIA_AUDIO:', '').trim();
                if (rawUrl && rawUrl !== 'PENDING') audioUrl = `${API_URL}${rawUrl}`;
                transcription = parts[1] ? parts[1].replace('TRANSCRIPTION:', '').trim() : null;
            } else if (msg.body.startsWith('🎤 Audio:')) {
                transcription = msg.body.replace(/^🎤\s*Audio:\s*/, '').replace(/^"|"$/g, '').trim();
            }

            return (
                <div className="space-y-2 min-w-[200px]">
                    {/* Visual audio bubble with play button */}
                    <div className="flex items-center gap-2 bg-black/5 rounded-lg px-3 py-2">
                        {audioUrl ? (
                            <button
                                className="w-8 h-8 rounded-full bg-emerald-500 hover:bg-emerald-600 flex items-center justify-center flex-shrink-0 transition-colors cursor-pointer active:scale-95"
                                title="Reproducir audio"
                                onClick={(e) => {
                                    const btn = e.currentTarget;
                                    const container = btn.closest('.space-y-2');
                                    let audio = container.querySelector('audio');
                                    if (!audio) {
                                        audio = document.createElement('audio');
                                        audio.src = audioUrl;
                                        audio.style.display = 'none';
                                        container.appendChild(audio);
                                        audio.addEventListener('ended', () => {
                                            btn.dataset.playing = 'false';
                                            btn.innerHTML = '<svg class="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
                                        });
                                    }
                                    if (audio.paused) {
                                        audio.play();
                                        btn.dataset.playing = 'true';
                                        btn.innerHTML = '<svg class="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
                                    } else {
                                        audio.pause();
                                        btn.dataset.playing = 'false';
                                        btn.innerHTML = '<svg class="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
                                    }
                                }}
                            >
                                <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M8 5v14l11-7z" />
                                </svg>
                            </button>
                        ) : (
                            <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
                                <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                                </svg>
                            </div>
                        )}
                        <div className="flex items-center gap-0.5 flex-1">
                            {[4, 12, 8, 16, 6, 14, 10, 18, 5, 13, 7, 15, 9, 17, 6, 11, 8, 14, 10, 12].map((h, i) => (
                                <div
                                    key={i}
                                    className="w-1 rounded-full bg-emerald-400/60"
                                    style={{ height: `${h}px` }}
                                />
                            ))}
                        </div>
                    </div>
                    {/* Transcription */}
                    {transcription ? (
                        <div className="bg-black/5 p-2 rounded-lg text-xs italic text-slate-600 border-l-2 border-emerald-400">
                            📝 "{transcription}"
                        </div>
                    ) : (
                        <p className="text-[11px] text-slate-400 italic">🎤 Audio recibido</p>
                    )}
                </div>
            );
        }

        return msg.body;
    };

    return (
        <div className="h-full flex overflow-hidden rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm animate-fade-in">

            {/* 1. SIDEBAR: Contacts */}
            <div className="w-80 border-r border-slate-200 dark:border-slate-700 flex flex-col bg-slate-50 dark:bg-slate-800/50">
                {/* Search */}
                <div className="p-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                    <div className="relative">
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Buscar contactos..."
                            className="w-full bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-md pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all text-slate-700 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500"
                        />
                        <span className="absolute left-3 top-2.5 text-slate-400 dark:text-slate-500"><Icons.Search /></span>
                    </div>
                </div>

                {/* Contact List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {filteredChats.length === 0 ? (
                        <div className="p-6 text-center text-slate-400 dark:text-slate-500 text-sm">
                            {searchTerm ? 'No se encontraron resultados' : 'No hay chats todavía'}
                        </div>
                    ) : (
                        filteredChats.map(chat => (
                            <div
                                key={chat.id}
                                onClick={() => setSelectedChat(chat)}
                                className={`p-4 flex gap-3 cursor-pointer transition-colors border-l-2 ${selectedChat?.id === chat.id ? 'bg-white dark:bg-slate-800 border-blue-600 dark:border-blue-500 shadow-sm' : 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-700/50'}`}
                            >
                                <div className="w-10 h-10 rounded bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-slate-500 dark:text-slate-400 font-bold text-xs uppercase shadow-sm relative">
                                    {chat.name.substring(0, 2)}
                                    {chat.isPaused && (
                                        <span className="absolute -bottom-1 -right-1 w-4 h-4 bg-amber-500 rounded-full border-2 border-white dark:border-slate-800 flex items-center justify-center">
                                            <span className="text-[8px] text-white tooltip" title="Bot Pausado">||</span>
                                        </span>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-baseline mb-0.5">
                                        <div className="flex flex-col min-w-0">
                                            <span className={`font-mono text-[10px] tracking-tight ${selectedChat?.id === chat.id ? 'text-blue-200' : 'text-slate-400 dark:text-slate-500'}`}>
                                                +{chat.id?.split('@')[0]}
                                            </span>
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                <h3 className={`font-semibold text-sm truncate flex items-center gap-1 ${selectedChat?.id === chat.id ? 'text-blue-700 dark:text-blue-400' : 'text-slate-700 dark:text-slate-300'}`}>
                                                    {chat.name}
                                                    {chat.hasBought && <span title="Cliente Recurrente" className="inline-flex items-center text-[8px] bg-green-100 text-green-700 px-1 py-0.5 rounded-sm font-bold ml-1">CLIENTE</span>}
                                                </h3>
                                                {chat.assignedScript && (
                                                    <span className="px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-700 text-[9px] font-bold text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-600 uppercase whitespace-nowrap">
                                                        {chat.assignedScript}
                                                    </span>
                                                )}
                                            </div>
                                            <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium font-mono ml-2 flex-shrink-0">{chat.time}</span>
                                        </div>
                                    </div>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate font-medium mt-1">{chat.lastMessage?.body || (typeof chat.lastMessage === 'string' ? chat.lastMessage : '') || 'Sin mensajes'}</p>
                                </div>
                                {chat.unread > 0 && (
                                    <div className="flex flex-col justify-center items-end ml-2">
                                        <span className="w-5 h-5 bg-blue-600 text-white text-[10px] font-bold rounded flex items-center justify-center shadow-sm">
                                            {chat.unread}
                                        </span>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>

            <span className="text-sm">Cargando mensajes...</span>
        </div>
                                    </div >
                                ) : messages.length === 0 ? (
    <div className="flex items-center justify-center h-full text-slate-400 dark:text-slate-500 text-sm">
        No hay mensajes en este chat
    </div>
) : (
    messages.map((msg, idx) => (
        <div key={idx} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[70%] p-3 text-sm leading-relaxed shadow-sm relative group ${msg.fromMe
                ? 'bg-blue-600 text-white rounded-l-lg rounded-br-lg'
                : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-white rounded-r-lg rounded-bl-lg border border-slate-200 dark:border-slate-600'
                }`}>
                {renderMessageBody(msg)}
                <span className={`text-[10px] block text-right mt-1 font-mono opacity-80 ${msg.fromMe ? 'text-blue-100' : 'text-slate-400 dark:text-slate-400'}`}>
                    {(() => {
                        try {
                            const d = new Date(msg.timestamp);
                            return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
                        } catch (e) { return ''; }
                    })()}
                </span>

                {/* Delete Button (Only for own messages) */}
                {msg.fromMe && (
                    <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteMessage(msg.id); }}
                        className="absolute -left-8 top-1/2 -translate-y-1/2 p-1.5 text-slate-300 dark:text-slate-500 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded-full opacity-0 group-hover:opacity-100 transition-all"
                        title="Eliminar mensaje para todos"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                )}
            </div>
        </div>
    ))
)}
<div ref={messagesEndRef} />
                            </div >

    {/* Input */ }
    < div className = "p-4 bg-white dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700" >
        {/* Attachment Preview */ }
{
    attachment && (
        <div className="mb-3 p-3 bg-slate-50 dark:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-600 flex items-center gap-3 animate-fade-in">
            <img src={attachment.preview} alt="Preview" className="w-16 h-16 object-cover rounded-lg border border-slate-200 dark:border-slate-600 shadow-sm" />
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{attachment.file.name}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500">{(attachment.file.size / 1024).toFixed(0)} KB</p>
            </div>
            <button
                onClick={() => setAttachment(null)}
                className="p-1.5 hover:bg-rose-100 dark:hover:bg-rose-900/30 rounded-lg text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 transition"
            >
                ✕
            </button>
        </div>
    )
}
<form onSubmit={attachment ? (e) => { e.preventDefault(); handleSendMedia(); } : handleSend} className="flex items-center gap-3">
    {/* Hidden file input */}
    <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
    />
    {/* Attachment button */}
    <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="p-2.5 rounded-md text-slate-400 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/40 transition-all"
        title="Adjuntar imagen"
    >
        <Icons.Clip />
    </button>
    <div className="flex-1 relative">
        <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={attachment ? 'Agregar texto (opcional)...' : 'Escribe un mensaje...'}
            className="w-full bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-md pl-4 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-all text-slate-700 dark:text-white placeholder-slate-400 dark:placeholder-slate-400"
        />
    </div>
    <button
        type="submit"
        disabled={attachment ? sendingMedia : !input.trim()}
        className="bg-slate-900 hover:bg-black text-white p-2.5 rounded-md shadow-lg transition-all disabled:opacity-50"
    >
        {sendingMedia ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : (
            <Icons.Send />
        )}
    </button>
</form>
                            </div >
                        </>
                    ) : (
    <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
        <div className="w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center mb-4 text-slate-400">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
        </div>
        <h3 className="text-lg font-bold text-slate-600">Selecciona un Chat</h3>
        <p className="text-sm opacity-70 mt-1">Selecciona una conversación de la lista para comenzar.</p>
    </div>
)}
                </div >

    {/* 3. ORDER SUMMARY SIDEBAR */ }
{
    selectedChat && (
        <div className={`w-72 border-l border-slate-200 bg-white flex flex-col transition-all duration-300 ${activeOrder || loadingOrder ? 'translate-x-0' : 'hidden'}`}>
            <div className="h-16 border-b border-slate-200 flex items-center px-5 bg-slate-50">
                <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
                    <Icons.Script /> Info del Cliente
                </h3>
            </div>

            <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
                {loadingOrder ? (
                    <div className="flex flex-col items-center justify-center h-40 text-slate-400 gap-3">
                        <div className="w-5 h-5 border-2 border-slate-300 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-xs">Buscando pedido...</span>
                    </div>
                ) : activeOrder ? (
                    <div className="space-y-5">
                        {/* Status Badge */}
                        <div className="flex justify-between items-center">
                            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Estado</span>
                            <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${activeOrder.status === 'Confirmado' ? 'bg-blue-50 text-blue-600 border-blue-200' :
                                activeOrder.status === 'Enviado' ? 'bg-indigo-50 text-indigo-600 border-indigo-200' :
                                    activeOrder.status === 'Entregado' ? 'bg-emerald-50 text-emerald-600 border-emerald-200' :
                                        activeOrder.status === 'Cancelado' ? 'bg-rose-50 text-rose-600 border-rose-200' :
                                            'bg-amber-50 text-amber-600 border-amber-200'
                                }`}>
                                {activeOrder.status || 'Pendiente'}
                            </span>
                        </div>

                        {/* Product Info */}
                        <div className="p-3 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl border border-blue-100/50 dark:border-blue-800/20">
                            <p className="text-[10px] font-bold text-blue-400 dark:text-blue-500 uppercase tracking-widest mb-1">Producto</p>
                            <p className="font-bold text-slate-800 dark:text-slate-100 text-sm">{activeOrder.producto}</p>
                            {activeOrder.plan && (
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Plan {activeOrder.plan}</p>
                            )}
                        </div>

                        {/* Delivery Info */}
                        <div className="space-y-2.5">
                            <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest border-b border-slate-100 dark:border-slate-700 pb-1.5">Envío a</p>
                            <div>
                                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{activeOrder.nombre}</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{activeOrder.calle}</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400">{activeOrder.ciudad} {activeOrder.cp ? `(CP ${activeOrder.cp})` : ''}</p>
                                {activeOrder.provincia && <p className="text-xs text-slate-500 dark:text-slate-400">{activeOrder.provincia}</p>}
                            </div>
                            {activeOrder.tracking && (
                                <div className="mt-3 p-2.5 bg-slate-50 dark:bg-slate-700/50 rounded-lg border border-slate-200 dark:border-slate-600">
                                    <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">Tracking Correo</p>
                                    <p className="font-mono text-xs font-bold text-blue-600 dark:text-blue-400 break-all">{activeOrder.tracking}</p>
                                </div>
                            )}
                        </div>

                        {/* Total */}
                        <div className="pt-4 border-t border-slate-100 dark:border-slate-700 flex justify-between items-end">
                            <span className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase">Total</span>
                            <span className="text-lg font-black text-emerald-600 dark:text-emerald-500">${activeOrder.precio}</span>
                        </div>

                        <div className="pt-2 text-[10px] text-center text-slate-400 dark:text-slate-500 font-mono">
                            Creado: {new Date(activeOrder.createdAt).toLocaleDateString()}
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    )
}

{/* 4. RIGHT PANEL - AI & Scripts Context Drawer (Imported from V3) */ }
{
    selectedChat && showScriptPanel && (
        <div className="w-[320px] shrink-0 border-l border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 flex flex-col z-30 overflow-y-auto animate-fade-in relative shadow-[-4px_0_24px_-12px_rgba(0,0,0,0.05)]">

            <div className="p-5 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center bg-white dark:bg-slate-800 shadow-sm z-10">
                <h3 className="font-extrabold text-slate-800 dark:text-slate-100 text-sm flex items-center gap-2">
                    <Icons.AI /> Asistente IA
                </h3>
                <button onClick={() => setShowScriptPanel(false)} className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md transition-colors">
                    <span className="text-xl leading-none">&times;</span>
                </button>
            </div>

            <div className="p-5 flex-1 flex flex-col gap-6 custom-scrollbar">

                {/* Summary Block */}
                <div>
                    <div className="flex justify-between items-center mb-3">
                        <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Contexto IA</h4>
                        <button onClick={handleSummarize} disabled={summarizing || messages.length === 0} className="text-[10px] font-bold text-indigo-700 dark:text-indigo-400 bg-indigo-100 dark:bg-indigo-900/30 px-2 py-1 rounded hover:bg-indigo-200 dark:hover:bg-indigo-900/60 transition-colors disabled:opacity-50 border border-indigo-200 dark:border-indigo-800/50">
                            {summarizing ? 'Generando...' : 'Resumir Chat'}
                        </button>
                    </div>
                    <div className="bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl p-4 text-xs font-medium text-slate-600 dark:text-slate-300 shadow-sm min-h-[100px] relative">
                        {summaryText ? (
                            <div className="whitespace-pre-wrap leading-relaxed">
                                {summaryText}
                                <button onClick={() => setSummaryText(null)} className="absolute top-2 right-2 text-slate-300 hover:text-slate-500 dark:hover:text-slate-400 bg-white dark:bg-slate-700 rounded-full p-0.5"><Icons.Trash /></button>
                            </div>
                        ) : (
                            <span className="text-slate-400 dark:text-slate-500 italic flex items-center h-full justify-center text-center">Haz clic en resumir para analizar la intención de compra del cliente.</span>
                        )}
                    </div>
                </div>

                {/* Script Injection */}
                <div className="flex-1">
                    <div className="flex items-center justify-between mb-3">
                        <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Guión Sugerido</h4>
                        <span className="bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase">{selectedChat.assignedScript || 'V3'}</span>
                    </div>

                    {Object.keys(scriptFlow).length > 0 ? (
                        <div className="space-y-2">
                            {Object.keys(scriptFlow).map((stepKey) => {
                                const step = scriptFlow[stepKey];
                                if (!step?.response) return null;
                                return (
                                    <button
                                        key={stepKey}
                                        onClick={() => {
                                            // Pausar bot automáticamente al inyectar humano
                                            if (!selectedChat.isPaused) handleToggleBot();
                                            setInput(formatScriptMessage(step.response));
                                        }}
                                        className="w-full text-left p-3 rounded-lg border border-slate-200 dark:border-slate-600 hover:border-indigo-300 dark:hover:border-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/40 transition-colors group cursor-pointer bg-white dark:bg-slate-700 shadow-sm"
                                    >
                                        <div className="flex items-center justify-between mb-1.5 text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
                                            <span>{stepKey.replace(/_/g, ' ')}</span>
                                            <span className="opacity-0 group-hover:opacity-100 transition-opacity">Insertar +</span>
                                        </div>
                                        <p className="text-[11px] text-slate-600 dark:text-slate-300 font-medium line-clamp-3 leading-relaxed">
                                            {formatScriptMessage(step.response)}
                                        </p>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-xs text-slate-400 dark:text-slate-500 italic text-center mt-4">No hay pasos de guión configurados.</p>
                    )}
                </div>

            </div>
        </div>
    )
}
            </div >
            );
};

export default CommsView;
