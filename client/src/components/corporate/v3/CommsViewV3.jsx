import React, { useState, useEffect, useRef } from 'react';
import api from '../../../config/axios';
import { useSocket } from '../../../context/SocketContext';
import { useToast } from '../../ui/Toast';

const IconsV3 = {
    Search: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
    AI: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>,
    Play: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Pause: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Trash: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
    Send: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>,
    Clip: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>,
    ArrowLeft: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>,
    ChevronRight: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
};

const CommsViewV3 = ({ initialChatId, onChatSelected }) => {
    const { socket } = useSocket();
    const { toast } = useToast();

    // Core State
    const [chats, setChats] = useState([]);
    const [selectedChat, setSelectedChat] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [loading, setLoading] = useState(false);

    // UI Panels State
    const [showInfoPanel, setShowInfoPanel] = useState(false);
    const [scriptFlow, setScriptFlow] = useState({});
    const [availableScripts, setAvailableScripts] = useState({ v3: {}, v4: {} });
    const [prices, setPrices] = useState(null);
    const [summaryText, setSummaryText] = useState(null);
    const [summarizing, setSummarizing] = useState(false);

    // Media State
    const [attachment, setAttachment] = useState(null);
    const [sendingMedia, setSendingMedia] = useState(false);

    // Refs
    const messagesEndRef = useRef(null);
    const scrollContainerRef = useRef(null);
    const fileInputRef = useRef(null);

    const filteredChats = searchTerm
        ? chats.filter(c => c.name?.toLowerCase().includes(searchTerm.toLowerCase()) || c.id?.includes(searchTerm))
        : chats;

    // 1. Initialization & Socket Handlers
    useEffect(() => {
        if (initialChatId && chats.length > 0) {
            const chatToSelect = chats.find(c => c.id === initialChatId);
            setSelectedChat(chatToSelect || { id: initialChatId, name: initialChatId });
            if (onChatSelected) onChatSelected();
        }
    }, [initialChatId, chats, onChatSelected]);

    useEffect(() => {
        const fetchDeps = async () => {
            try {
                const [chatsRes, scriptV3, scriptV4, pricesRes] = await Promise.all([
                    api.get('/api/chats'),
                    api.get('/api/script/v3'),
                    api.get('/api/script/v4'),
                    api.get('/api/prices')
                ]);
                setChats(chatsRes.data);
                setAvailableScripts({ v3: scriptV3.data?.flow || {}, v4: scriptV4.data?.flow || {} });
                setScriptFlow(scriptV3.data?.flow || {});
                if (pricesRes.data) setPrices(pricesRes.data);
            } catch (e) {
                console.error("Failed to load comms deps", e);
            }
        };
        fetchDeps();

        if (socket) {
            socket.on('new_log', (data) => {
                if (!data || !data.chatId) return;
                const timestamp = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();
                const isMe = data.sender === 'bot' || data.sender === 'admin';
                const newMsg = { id: data.messageId || `soc-${timestamp}`, fromMe: isMe, body: data.text || '', type: 'chat', timestamp };

                setMessages(prev => {
                    if (selectedChat?.id !== data.chatId) return prev;
                    if (isMe) {
                        const pendingIdx = prev.findIndex(m => m.pending && m.body === newMsg.body);
                        if (pendingIdx !== -1) {
                            const updated = [...prev];
                            updated[pendingIdx] = newMsg;
                            return updated;
                        }
                    }
                    if (prev.some(m => m.id === newMsg.id || (m.timestamp === timestamp && m.body === newMsg.body))) return prev;
                    return [...prev, newMsg];
                });

                setChats(prev => {
                    const exists = prev.find(c => c.id === data.chatId);
                    if (exists) {
                        return prev.map(c => c.id === data.chatId ? {
                            ...c,
                            lastMessage: { body: data.text || '', timestamp },
                            unreadCount: selectedChat?.id === data.chatId ? 0 : (c.unreadCount || 0) + 1,
                            time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        } : c).sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
                    }
                    return prev;
                });
            });

            socket.on('bot_status_change', (data) => {
                if (!data) return;
                setChats(prev => prev.map(c => c.id === data.chatId ? { ...c, isPaused: data.paused } : c));
                if (selectedChat?.id === data.chatId) {
                    setSelectedChat(prev => ({ ...prev, isPaused: data.paused }));
                }
            });
        }
        return () => { if (socket) { socket.off('new_log'); socket.off('bot_status_change'); } };
    }, [socket, selectedChat?.id]);

    useEffect(() => {
        if (!selectedChat) return;
        const targetVersion = selectedChat.assignedScript || 'v3';
        if (availableScripts[targetVersion]) setScriptFlow(availableScripts[targetVersion]);

        setMessages([]);
        setSummaryText(null);
        setLoading(true);
        api.get(`/api/history/${selectedChat.id}`)
            .then(res => setMessages(res.data))
            .catch(() => setMessages([]))
            .finally(() => setLoading(false));
    }, [selectedChat?.id]);

    useEffect(() => {
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
    }, [messages]);

    // 2. Actions
    const handleSend = async (e) => {
        e.preventDefault();
        if (!input.trim() || !selectedChat) return;
        const text = input.trim();
        setInput('');
        setMessages(prev => [...prev, { id: `temp-${Date.now()}`, fromMe: true, body: text, type: 'chat', timestamp: Date.now(), pending: true }]);
        try { await api.post('/api/send', { chatId: selectedChat.id, message: text }); }
        catch (e) { toast.error('Error al enviar mensaje'); }
    };

    const handleToggleBot = async () => {
        const newStatus = !selectedChat.isPaused;
        try {
            await api.post('/api/toggle-bot', { chatId: selectedChat.id, paused: newStatus });
            toast.success(newStatus ? 'Asesor IA Pausado' : 'Asesor IA Reactivado');
        } catch (e) { toast.error('Error cambiando estado de IA'); }
    };

    const handleSummarize = async () => {
        setSummarizing(true);
        try {
            const res = await api.get(`/api/summarize/${selectedChat.id}`);
            setSummaryText(res.data.summary || res.data.message);
        } catch (e) { toast.error('Error generando resumen de IA'); }
        setSummarizing(false);
    };

    const formatScript = (text) => {
        if (!text || !prices) return text;
        const p = prices;
        return text.replace(/{{PRICE_CAPSULAS_60}}/g, p['Cápsulas']?.['60'] || '')
            .replace(/{{PRICE_CAPSULAS_120}}/g, p['Cápsulas']?.['120'] || '')
            .replace(/{{PRICE_SEMILLAS_60}}/g, p['Semillas']?.['60'] || '')
            .replace(/{{PRICE_SEMILLAS_120}}/g, p['Semillas']?.['120'] || '')
            .replace(/{{PRICE_GOTAS_60}}/g, p['Gotas']?.['60'] || '')
            .replace(/{{ADICIONAL_MAX}}/g, p.adicionalMAX || '')
            .replace(/{{COSTO_LOGISTICO}}/g, p.costoLogistico || '');
    };

    // 3. Render Helpers
    const formatTime = (ts) => {
        if (!ts) return '';
        const date = new Date(ts);
        return isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div className="flex h-full max-h-full bg-white border border-slate-200/60 rounded-[2rem] shadow-sm overflow-hidden" style={{ minHeight: 'calc(100vh - 140px)' }}>

            {/* LEFT PANEL - Chat List */}
            <div className={`w-full md:w-[340px] flex-shrink-0 flex flex-col bg-slate-50/50 border-r border-slate-200/60 transition-transform ${selectedChat ? 'hidden md:flex' : 'flex'}`}>
                {/* Search Bar */}
                <div className="p-4 bg-white border-b border-slate-100 z-10 shrink-0">
                    <h2 className="text-xl font-bold text-slate-800 tracking-tight mb-4">Conversaciones</h2>
                    <div className="relative">
                        <input
                            type="text"
                            placeholder="Buscar cliente o número..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full bg-slate-100 border-none rounded-2xl py-2.5 pl-11 pr-4 text-sm font-medium focus:ring-2 focus:ring-blue-500/20 focus:bg-white transition-all outline-none"
                        />
                        <div className="absolute left-4 top-3 text-slate-400">
                            <IconsV3.Search />
                        </div>
                    </div>
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto hide-scrollbar p-3 space-y-1">
                    {filteredChats.map((chat) => {
                        const isSelected = selectedChat?.id === chat.id;
                        return (
                            <button
                                key={chat.id}
                                onClick={() => { setSelectedChat(chat); setChats(prev => prev.map(c => c.id === chat.id ? { ...c, unreadCount: 0 } : c)); }}
                                className={`w-full text-left p-3 rounded-2xl transition-all duration-200 border ${isSelected
                                        ? 'bg-blue-600 border-blue-600 shadow-md shadow-blue-600/20'
                                        : 'bg-white border-transparent hover:border-slate-200 hover:shadow-sm'
                                    }`}
                            >
                                <div className="flex justify-between items-start mb-1">
                                    <h4 className={`font-bold truncate pr-2 ${isSelected ? 'text-white' : 'text-slate-800'}`}>
                                        {chat.name || chat.id.split('@')[0]}
                                    </h4>
                                    <span className={`text-[10px] whitespace-nowrap font-medium mt-1 ${isSelected ? 'text-blue-100' : 'text-slate-400'}`}>
                                        {chat.time || ''}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <p className={`text-xs truncate max-w-[80%] ${isSelected ? 'text-blue-50 font-medium' : 'text-slate-500'}`}>
                                        {chat.lastMessage?.body || 'Sin mensajes recientes'}
                                    </p>
                                    {chat.unreadCount > 0 && !isSelected && (
                                        <span className="bg-rose-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                                            {chat.unreadCount}
                                        </span>
                                    )}
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* CENTER PANEL - Chat Window */}
            {selectedChat ? (
                <div className="flex-1 flex flex-col min-w-0 bg-[#F4F5F7] relative">
                    {/* Chat Header Glassmorphism */}
                    <div className="h-16 shrink-0 bg-white/80 backdrop-blur-xl border-b border-slate-200/60 px-4 sm:px-6 flex justify-between items-center z-20">
                        <div className="flex items-center gap-3">
                            <button onClick={() => setSelectedChat(null)} className="md:hidden p-2 -ml-2 text-slate-500 hover:bg-slate-100 rounded-xl">
                                <IconsV3.ArrowLeft />
                            </button>
                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-100 to-blue-50 flex items-center justify-center border border-indigo-100">
                                <span className="text-blue-600 font-bold text-sm tracking-wider">
                                    {selectedChat.name ? selectedChat.name.substring(0, 2).toUpperCase() : 'WA'}
                                </span>
                            </div>
                            <div>
                                <h3 className="font-extrabold text-slate-800 leading-tight">
                                    {selectedChat.name || selectedChat.id.split('@')[0]}
                                </h3>
                                <div className="flex items-center gap-2 mt-0.5">
                                    <div className={`w-1.5 h-1.5 rounded-full ${selectedChat.isPaused ? 'bg-orange-400' : 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]'}`}></div>
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                                        {selectedChat.isPaused ? 'Humano al mando' : 'IA Operando'}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-1 sm:gap-2">
                            <button
                                onClick={handleToggleBot}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-sm ${selectedChat.isPaused
                                        ? 'bg-white text-emerald-600 hover:bg-emerald-50 border border-emerald-200'
                                        : 'bg-white text-orange-600 hover:bg-orange-50 border border-orange-200'
                                    }`}
                            >
                                {selectedChat.isPaused ? <IconsV3.Play /> : <IconsV3.Pause />}
                                <span className="hidden sm:inline">{selectedChat.isPaused ? 'Reactivar IA' : 'Pausar IA'}</span>
                            </button>
                            <button
                                onClick={() => setShowInfoPanel(!showInfoPanel)}
                                className={`p-2 rounded-xl transition-all border ${showInfoPanel ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                            >
                                <IconsV3.AI />
                            </button>
                        </div>
                    </div>

                    {/* Chat Messages */}
                    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-6 scroll-smooth" style={{ background: 'linear-gradient(180deg, #F9FAFB 0%, #F3F4F6 100%)' }}>
                        {loading ? (
                            <div className="flex h-full items-center justify-center">
                                <div className="w-8 h-8 border-4 border-indigo-200 border-t-blue-600 rounded-full animate-spin"></div>
                            </div>
                        ) : messages.length === 0 ? (
                            <div className="flex h-full flex-col items-center justify-center text-center p-8">
                                <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center mb-4 shadow-sm border border-slate-100">
                                    <IconsV3.AI className="w-10 h-10 text-slate-300" />
                                </div>
                                <h4 className="text-lg font-bold text-slate-700 mb-1">Inicia la conversación</h4>
                                <p className="text-sm text-slate-400 max-w-sm">Los mensajes se enviarán directamente a este cliente usando la sesión de WhatsApp vinculada.</p>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-3">
                                {messages.map((msg, idx) => {
                                    const showTime = idx === 0 || messages[idx - 1].fromMe !== msg.fromMe || (msg.timestamp - messages[idx - 1].timestamp > 300000);
                                    return (
                                        <div key={msg.id || idx} className={`flex flex-col ${msg.fromMe ? 'items-end' : 'items-start'} max-w-full`}>
                                            {showTime && (
                                                <span className="text-[10px] font-semibold text-slate-400 mb-1 mt-2 tracking-wide px-2">
                                                    {formatTime(msg.timestamp)}
                                                </span>
                                            )}
                                            <div className="flex items-end gap-2 max-w-[85%] lg:max-w-[70%] group">
                                                {!msg.fromMe && (
                                                    <div className="w-6 h-6 rounded-full bg-slate-200 flex-shrink-0 flex items-center justify-center -mb-1 shadow-sm">
                                                        <span className="text-[9px] font-bold text-slate-500">C</span>
                                                    </div>
                                                )}
                                                <div className={`px-4 py-2.5 rounded-2xl shadow-sm text-[15px] leading-relaxed relative ${msg.fromMe
                                                        ? 'bg-blue-600 text-white rounded-br-sm'
                                                        : 'bg-white text-slate-800 rounded-bl-sm border border-slate-100'
                                                    } ${msg.pending ? 'opacity-70' : ''}`}>

                                                    {/* Markdown/Text Support */}
                                                    <div className="whitespace-pre-wrap word-break">
                                                        {msg.body}
                                                    </div>

                                                    {msg.type === 'image' && (
                                                        <div className="mt-2 bg-slate-100/20 rounded-xl flex items-center justify-center p-4">
                                                            <IconsV3.Clip /> <span className="ml-2 text-xs font-medium">Media adjunta</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Attachment Preview Overlay */}
                    {attachment && (
                        <div className="absolute bottom-20 left-4 bg-white p-3 rounded-2xl shadow-xl border border-slate-200 z-30 animate-fade-in flex items-center gap-3">
                            <div className="w-14 h-14 bg-slate-100 rounded-xl overflow-hidden border border-slate-200">
                                {attachment.mimetype.startsWith('image/')
                                    ? <img src={attachment.preview} className="w-full h-full object-cover" alt="Preview" />
                                    : <div className="w-full h-full flex items-center justify-center"><IconsV3.Clip /></div>}
                            </div>
                            <div className="flex-1">
                                <p className="text-xs font-bold text-slate-700 truncate max-w-[150px]">{attachment.file.name}</p>
                                <p className="text-[10px] text-slate-400">Adjunto listo</p>
                            </div>
                            <button onClick={() => setAttachment(null)} className="p-1.5 bg-rose-50 text-rose-500 hover:bg-rose-100 rounded-lg shrink-0">
                                <IconsV3.Trash />
                            </button>
                        </div>
                    )}

                    {/* Chat Input */}
                    <div className="bg-white shrink-0 p-3 sm:p-4 border-t border-slate-200/50 relative z-20">
                        <form onSubmit={handleSend} className="flex gap-2 sm:gap-3 items-end max-w-4xl mx-auto">
                            <button
                                type="button"
                                className="p-3 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-all"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <IconsV3.Clip />
                            </button>
                            <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={(e) => {
                                const f = e.target.files[0];
                                if (f) {
                                    const r = new FileReader();
                                    r.onload = () => setAttachment({ file: f, preview: r.result, base64: r.result.split(',')[1], mimetype: f.type });
                                    r.readAsDataURL(f);
                                    e.target.value = '';
                                }
                            }} />

                            <div className="flex-1 relative">
                                <textarea
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleSend(e);
                                        }
                                    }}
                                    placeholder={selectedChat.isPaused ? "Escribe un mensaje al cliente..." : "Pausa la IA para hablar tú..."}
                                    className={`w-full max-h-32 min-h-[48px] bg-slate-100 rounded-2xl px-5 py-3 text-sm focus:ring-2 focus:ring-blue-500/20 outline-none resize-none transition-all placeholder-slate-400 font-medium ${!selectedChat.isPaused && 'opacity-60 cursor-not-allowed'}`}
                                    rows="1"
                                    disabled={!selectedChat.isPaused}
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={!input.trim() && !attachment}
                                className={`p-3 rounded-2xl flex items-center justify-center transition-all bg-blue-600 text-white shadow-md shadow-blue-500/20 ${(!input.trim() && !attachment) ? 'opacity-50 cursor-not-allowed hidden sm:flex' : 'hover:bg-blue-700 hover:-translate-y-0.5'}`}
                            >
                                <IconsV3.Send />
                            </button>
                        </form>
                    </div>
                </div>
            ) : (
                <div className="hidden md:flex flex-1 items-center justify-center bg-slate-50/50">
                    <div className="text-center p-8 animate-fade-in">
                        <div className="w-24 h-24 bg-white rounded-[2rem] shadow-xl shadow-blue-500/10 flex items-center justify-center mx-auto mb-6 transform rotate-3">
                            <svg className="w-12 h-12 text-blue-500 -rotate-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                        </div>
                        <h2 className="text-2xl font-black text-slate-800 tracking-tight mb-2">Workspace V3</h2>
                        <p className="text-slate-500 font-medium text-sm">Selecciona una conversación a la izquierda para interactuar.</p>
                    </div>
                </div>
            )}

            {/* RIGHT PANEL - AI & Scripts Context Drawer */}
            {selectedChat && showInfoPanel && (
                <div className="w-[320px] shrink-0 border-l border-slate-200/60 bg-white shadow-[-4px_0_24px_-12px_rgba(0,0,0,0.1)] flex flex-col z-30 overflow-y-auto absolute right-0 top-0 bottom-0 md:relative animate-slide-in-right">

                    <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                        <h3 className="font-extrabold text-slate-800 text-lg">Asistente IA</h3>
                        <button onClick={() => setShowInfoPanel(false)} className="p-1.5 bg-white shadow-sm border border-slate-200 rounded-lg text-slate-400 hover:text-slate-700">
                            <IconsV3.ChevronRight />
                        </button>
                    </div>

                    <div className="p-5 space-y-8 flex-1">

                        {/* Summary Block */}
                        <div>
                            <div className="flex justify-between items-center mb-3">
                                <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-400">Contexto IA</h4>
                                <button onClick={handleSummarize} disabled={summarizing} className="text-[10px] font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md hover:bg-blue-100 transition-colors">
                                    {summarizing ? 'Gerenando...' : 'Resumir Chat'}
                                </button>
                            </div>
                            <div className="bg-[#F8FAFC] border border-slate-200/60 rounded-2xl p-4 text-sm font-medium text-slate-600 shadow-inner min-h-[100px]">
                                {summaryText || <span className="text-slate-400 italic">Haz clic en resumir para pedirle a OpenAI que analice el estado emocional y la intención de compra de este cliente.</span>}
                            </div>
                        </div>

                        {/* Script Injection */}
                        <div>
                            <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-3">Guión Rápido (Activo: {selectedChat.assignedScript?.toUpperCase() || 'V3'})</h4>
                            <div className="space-y-2">
                                {Object.keys(scriptFlow).map((stepKey) => {
                                    const step = scriptFlow[stepKey];
                                    if (!step?.response) return null;
                                    return (
                                        <button
                                            key={stepKey}
                                            onClick={() => {
                                                if (!selectedChat.isPaused) handleToggleBot();
                                                setInput(formatScript(step.response));
                                            }}
                                            className="w-full text-left p-3 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors group cursor-pointer bg-white"
                                        >
                                            <div className="flex items-center justify-between mb-1 text-[10px] font-bold text-slate-400 uppercase tracking-widest group-hover:text-blue-500">
                                                <span>Fase: {stepKey}</span>
                                                <svg className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                                            </div>
                                            <p className="text-xs text-slate-600 font-medium line-clamp-2 leading-relaxed">
                                                {formatScript(step.response)}
                                            </p>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                    </div>
                </div>
            )}
        </div>
    );
};

export default CommsViewV3;
