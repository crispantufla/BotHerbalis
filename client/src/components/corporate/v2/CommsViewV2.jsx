import React, { useState, useEffect, useRef } from 'react';
import api from '../../../config/axios';
import { useSocket } from '../../../context/SocketContext';
import { API_URL } from '../../../config/api';
import { useToast } from '../../ui/Toast';

const IconsV2 = {
    Search: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
    AI: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>,
    Play: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Pause: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Trash: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
    Script: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
    ChevronDown: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>,
    Send: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>,
    Clip: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
};

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
    const [scriptFlow, setScriptFlow] = useState({});
    const [summarizing, setSummarizing] = useState(false);
    const [summaryText, setSummaryText] = useState(null);
    const [attachment, setAttachment] = useState(null);
    const [sendingMedia, setSendingMedia] = useState(false);
    const [prices, setPrices] = useState(null);
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
        fetchChats();

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
                                time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
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
        }
        return () => { if (socket) { socket.off('new_log'); socket.off('bot_status_change'); } };
    }, [socket, selectedChat]);

    useEffect(() => {
        const fetchScriptAndPrices = async () => {
            try {
                const [scriptRes, pricesRes] = await Promise.all([api.get('/api/script'), api.get('/api/prices')]);
                if (scriptRes.data?.flow) setScriptFlow(scriptRes.data.flow);
                if (pricesRes.data) setPrices(pricesRes.data);
            } catch (e) { }
        };
        fetchScriptAndPrices();
    }, []);

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
    }, [selectedChat]);

    const scrollToBottom = () => {
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
    };

    useEffect(scrollToBottom, [messages]);

    const formatScriptMessage = (text) => {
        if (!text || !prices) return text;
        let p = prices;
        return text.replace(/{{PRICE_CAPSULAS_60}}/g, p['Cápsulas']?.['60'] || '46.900')
            .replace(/{{PRICE_CAPSULAS_120}}/g, p['Cápsulas']?.['120'] || '66.900')
            .replace(/{{PRICE_SEMILLAS_60}}/g, p['Semillas']?.['60'] || '36.900')
            .replace(/{{PRICE_SEMILLAS_120}}/g, p['Semillas']?.['120'] || '49.900')
            .replace(/{{PRICE_GOTAS_60}}/g, p['Gotas']?.['60'] || '48.900')
            .replace(/{{PRICE_GOTAS_120}}/g, p['Gotas']?.['120'] || '68.900')
            .replace(/{{ADICIONAL_MAX}}/g, p.adicionalMAX || '6.000')
            .replace(/{{COSTO_LOGISTICO}}/g, p.costoLogistico || '18.000');
    };

    const handleSend = async (e) => {
        e.preventDefault();
        if (!input.trim() || !selectedChat) return;
        const text = input;
        setInput('');
        setMessages(prev => [...prev, { id: `temp-${Date.now()}`, fromMe: true, body: text, type: 'chat', timestamp: Date.now(), pending: true }]);
        try { await api.post('/api/send', { chatId: selectedChat.id, message: text }); }
        catch (e) { toast.error('Error al enviar mensaje'); }
    };

    const handleSendScriptStep = (stepKey) => {
        const step = scriptFlow[stepKey];
        if (step?.response) setInput(formatScriptMessage(step.response));
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
        } catch (e) { toast.error('Error generando resumen'); }
        setSummarizing(false);
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
            return <img src={`${API_URL}${url}`} alt="Media" className="rounded-2xl max-w-full h-auto max-h-64 object-cover border border-white/20 shadow-sm" />;
        }
        if (msg.body && (msg.body.startsWith('MEDIA_AUDIO:') || msg.body.startsWith('🎤'))) {
            let transcription = msg.body.includes('TRANSCRIPTION:') ? msg.body.split('TRANSCRIPTION:')[1].trim() : msg.body.replace(/^🎤\s*Audio:\s*/, '').replace(/^"|"$/g, '').trim();
            return (
                <div className="space-y-3 min-w-[200px]">
                    <div className="flex items-center gap-3 bg-black/10 rounded-2xl p-3 border border-white/10">
                        <div className="w-10 h-10 rounded-full bg-emerald-500/90 text-white flex items-center justify-center shadow-lg"><IconsV2.Play /></div>
                        <div className="flex-1 h-2 bg-black/10 rounded-full overflow-hidden text-emerald-500 font-mono text-[8px] leading-none text-center">Audio Player</div>
                    </div>
                    {transcription && <div className="bg-white/40 p-3 rounded-xl text-xs italic text-slate-800 font-medium">📝 "{transcription}"</div>}
                </div>
            );
        }
        return <p className="whitespace-pre-wrap font-medium">{msg.body}</p>;
    };

    return (
        <div className="h-full flex overflow-hidden rounded-[2rem] bg-white/40 backdrop-blur-xl border border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] animate-fade-in relative z-10">
            {/* Background elements inside chat container */}
            <div className="absolute top-0 right-1/4 w-64 h-64 bg-indigo-400/10 blur-[80px] rounded-full pointer-events-none"></div>

            {/* SIDEBAR: Contacts */}
            <div className="w-80 md:w-96 border-r border-white/50 flex flex-col bg-white/40 backdrop-blur-md z-10">
                {/* Search Header */}
                <div className="p-5 border-b border-white/50 bg-white/30 backdrop-blur-sm">
                    <div className="relative group">
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Buscar chats..."
                            className="w-full bg-white/60 border border-white rounded-2xl pl-12 pr-4 py-3 text-sm focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-300 transition-all text-slate-700 shadow-inner font-medium placeholder:text-slate-400"
                        />
                        <span className="absolute left-4 top-3 text-slate-400 group-focus-within:text-indigo-500 transition-colors"><IconsV2.Search /></span>
                    </div>
                </div>

                {/* Contact List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
                    {filteredChats.map(chat => (
                        <div key={chat.id} onClick={() => setSelectedChat(chat)} className={`p-4 mb-2 rounded-2xl flex gap-4 cursor-pointer transition-all duration-300 ${selectedChat?.id === chat.id ? 'bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 transform scale-[1.02]' : 'hover:bg-white/80'}`}>
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-sm shadow-inner relative flex-shrink-0 ${selectedChat?.id === chat.id ? 'bg-white/20 text-white' : 'bg-gradient-to-br from-indigo-50 to-blue-50 text-indigo-700'}`}>
                                {chat.name.substring(0, 2).toUpperCase()}
                                {chat.isPaused && <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 rounded-full border-2 border-white/50"></span>}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex justify-between items-center mb-1">
                                    <h3 className={`font-extrabold text-sm truncate ${selectedChat?.id === chat.id ? 'text-white' : 'text-slate-800'}`}>{chat.name}</h3>
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

            {/* CHAT AREA */}
            <div className="flex-1 flex flex-col bg-slate-50/30 backdrop-blur-md relative z-10">
                {selectedChat ? (
                    <>
                        {/* Header */}
                        <div className="flex-shrink-0 h-20 border-b border-white/50 flex items-center justify-between px-8 bg-white/50 backdrop-blur-md shadow-[0_2px_10px_rgba(0,0,0,0.02)] z-20">
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white flex items-center justify-center font-bold text-lg shadow-md shadow-indigo-500/20">
                                    {selectedChat.name.substring(0, 2).toUpperCase()}
                                </div>
                                <div>
                                    <div className="flex items-center gap-3">
                                        <h2 className="font-extrabold text-slate-800 text-lg tracking-tight">{selectedChat.name}</h2>
                                        {selectedChat.assignedScript && (
                                            <span className="px-3 py-1 rounded-full bg-indigo-100 text-[10px] font-bold text-indigo-700 uppercase tracking-widest border border-indigo-200">
                                                Flow: {selectedChat.assignedScript}
                                            </span>
                                        )}
                                    </div>
                                    <p className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 mt-0.5 ${selectedChat.isPaused ? 'text-amber-500' : 'text-emerald-500'}`}>
                                        <span className={`w-2 h-2 rounded-full ${selectedChat.isPaused ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'}`}></span>
                                        {selectedChat.isPaused ? 'Auto-Bot Pausado' : 'Auto-Bot Activo'}
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                <button onClick={handleSummarize} disabled={summarizing} className="p-3 rounded-xl bg-violet-100/80 text-violet-700 hover:bg-violet-200 hover:shadow-md transition-all" title="Resumen de IA">
                                    <IconsV2.AI />
                                </button>
                                <button onClick={handleClearChat} className="p-3 rounded-xl bg-rose-100/80 text-rose-600 hover:bg-rose-200 hover:shadow-md transition-all" title="Reiniciar Memoria e Historial">
                                    <IconsV2.Trash />
                                </button>
                                <button onClick={handleToggleBot} className={`p-3 rounded-xl text-white shadow-md transition-all ${selectedChat.isPaused ? 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:scale-105' : 'bg-gradient-to-r from-amber-500 to-orange-500 hover:scale-105'}`} title={selectedChat.isPaused ? 'Reactivar Bot' : 'Pausar Bot'}>
                                    {selectedChat.isPaused ? <IconsV2.Play /> : <IconsV2.Pause />}
                                </button>
                                <button onClick={() => setShowScriptPanel(!showScriptPanel)} className="flex items-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-slate-800 to-slate-700 text-white font-bold text-sm hover:shadow-lg transition-all active:scale-95">
                                    <IconsV2.Script />
                                    <span>Script</span>
                                </button>
                            </div>
                        </div>

                        {/* Script Panel */}
                        {showScriptPanel && (
                            <div className="border-b border-white border-opacity-50 bg-slate-800/90 backdrop-blur-xl p-6 z-20 animate-fade-in shadow-xl">
                                <p className="text-[10px] font-bold text-indigo-300 uppercase tracking-widest mb-4">Módulos del Guión (Click para cargar)</p>
                                <div className="flex flex-wrap gap-2">
                                    {Object.entries(scriptFlow).map(([key, step]) => (
                                        <button key={key} onClick={() => handleSendScriptStep(key)} className="px-4 py-2 bg-white/10 hover:bg-indigo-500 border border-white/20 rounded-xl text-xs font-medium text-white transition-all shadow-sm backdrop-blur-md">
                                            {key.replace(/_/g, ' ')}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* AI Summary */}
                        {summaryText && (
                            <div className="absolute top-24 left-1/2 -translate-x-1/2 w-3/4 max-w-2xl bg-white/90 backdrop-blur-2xl border border-violet-200/50 p-6 rounded-3xl shadow-2xl z-30 animate-fade-in">
                                <button onClick={() => setSummaryText(null)} className="absolute top-4 right-4 p-2 bg-slate-100 hover:bg-slate-200 rounded-full text-slate-500 transition-colors">✕</button>
                                <div className="flex gap-4">
                                    <div className="w-12 h-12 bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl flex items-center justify-center text-white shadow-lg"><IconsV2.AI /></div>
                                    <div>
                                        <h3 className="font-extrabold text-violet-900 mb-2">Análisis de IA</h3>
                                        <p className="text-sm font-medium text-slate-700 leading-relaxed max-h-48 overflow-y-auto custom-scrollbar pr-2">{summaryText}</p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Messages Area */}
                        <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto p-8 space-y-6 custom-scrollbar scroll-smooth">
                            {loading ? (
                                <div className="w-full h-full flex items-center justify-center">
                                    <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                                </div>
                            ) : messages.map((msg, idx) => (
                                <div key={idx} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[75%] p-4 text-sm leading-relaxed shadow-sm relative group ${msg.fromMe ? 'bg-gradient-to-br from-indigo-600 to-purple-600 text-white rounded-3xl rounded-tr-sm shadow-indigo-500/20' : 'bg-white text-slate-800 rounded-3xl rounded-tl-sm border border-white/60'}`}>
                                        {renderMessageBody(msg)}
                                        <span className={`text-[10px] block text-right mt-2 font-mono font-bold ${msg.fromMe ? 'text-indigo-200' : 'text-slate-400'}`}>
                                            {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    </div>
                                </div>
                            ))}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Input Area */}
                        <div className="flex-shrink-0 p-6 bg-white/50 backdrop-blur-md border-t border-white/60 z-20">
                            {attachment && (
                                <div className="mb-4 p-4 bg-white/80 rounded-2xl border border-indigo-100 shadow-sm flex items-center gap-4">
                                    <img src={attachment.preview} alt="Preview" className="w-16 h-16 object-cover rounded-xl" />
                                    <div className="flex-1">
                                        <p className="font-bold text-slate-800 text-sm">{attachment.file.name}</p>
                                        <p className="text-xs text-slate-500">{(attachment.file.size / 1024).toFixed(0)} KB</p>
                                    </div>
                                    <button onClick={() => setAttachment(null)} className="p-2 bg-slate-100 hover:bg-rose-100 hover:text-rose-600 rounded-xl transition-colors">✕</button>
                                </div>
                            )}
                            <form onSubmit={attachment ? (e) => { e.preventDefault(); handleSendMedia(); } : handleSend} className="flex gap-4">
                                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />
                                <button type="button" onClick={() => fileInputRef.current?.click()} className="w-14 h-14 flex items-center justify-center rounded-2xl bg-white border border-slate-200 text-slate-500 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all shadow-sm">
                                    <IconsV2.Clip />
                                </button>
                                <input
                                    type="text"
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    placeholder="Escribe un mensaje para el cliente..."
                                    className="flex-1 bg-white border border-slate-200 rounded-2xl px-6 py-4 text-slate-800 font-medium focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all shadow-inner placeholder:text-slate-400"
                                />
                                <button type="submit" disabled={(!input.trim() && !attachment) || sendingMedia} className="w-14 h-14 flex items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-105 active:scale-95 transition-all disabled:opacity-50 disabled:scale-100">
                                    {sendingMedia ? <div className="w-6 h-6 border-2 border-white/50 border-t-white rounded-full animate-spin"></div> : <IconsV2.Send />}
                                </button>
                            </form>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center p-12">
                        <div className="text-center">
                            <div className="w-24 h-24 bg-white/60 backdrop-blur-xl rounded-full flex items-center justify-center mx-auto mb-6 shadow-sm border border-white">
                                <span className="text-4xl">👋</span>
                            </div>
                            <h2 className="text-2xl font-extrabold text-slate-800 mb-2">Inbox de Mensajes V2</h2>
                            <p className="text-slate-500 font-medium">Seleccioná un chat del sidebar para iniciar a responder</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CommsViewV2;
