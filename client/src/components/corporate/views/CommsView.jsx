import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useSocket } from '../../../context/SocketContext';
import { API_URL } from '../../../config/api';
import { useToast } from '../../ui/Toast';

// Icons
const Icons = {
    Send: () => <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>,
    Attach: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>,
    Search: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
    More: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" /></svg>,
    Pause: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Play: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
    Trash: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
    AI: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>,
};

const CommsView = () => {
    const { socket } = useSocket();
    const { toast, confirm } = useToast();
    const [chats, setChats] = useState([]);
    const [selectedChat, setSelectedChat] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [summarizing, setSummarizing] = useState(false);
    const [summaryText, setSummaryText] = useState(null);

    const messagesEndRef = useRef(null);

    // Load Chats — initial fetch + Socket.IO for real-time updates
    useEffect(() => {
        const fetchChats = async () => {
            try {
                const res = await axios.get(`${API_URL}/api/chats`);
                setChats(res.data);
            } catch (e) {
                console.error("Error fetching chats:", e);
                setChats([]);
            }
        };
        fetchChats();

        if (socket) {
            // Real-time chat list updates
            socket.on('bot_status_change', ({ chatId, paused }) => {
                setChats(prev => prev.map(c => c.id === chatId ? { ...c, isPaused: paused } : c));
                if (selectedChat?.id === chatId) {
                    setSelectedChat(prev => prev ? { ...prev, isPaused: paused } : prev);
                }
            });
            socket.on('new_message', () => fetchChats()); // Refresh chat list on new messages
        }

        // Reduced polling from 5s to 30s since Socket handles real-time
        const interval = setInterval(fetchChats, 30000);
        return () => {
            clearInterval(interval);
            if (socket) {
                socket.off('bot_status_change');
                socket.off('new_message');
            }
        };
    }, [socket]);

    // Load Messages
    useEffect(() => {
        if (!selectedChat) return;
        setMessages([]);
        setSummaryText(null);
        const fetchMessages = async () => {
            setLoading(true);
            try {
                const res = await axios.get(`${API_URL}/api/history/${selectedChat.id}`);
                setMessages(res.data);
            } catch (e) {
                console.error("Failed to load history", e);
                setMessages([]);
            }
            setLoading(false);
        };
        fetchMessages();
    }, [selectedChat]);

    // Scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Send
    const handleSend = async (e) => {
        e.preventDefault();
        if (!input.trim() || !selectedChat) return;

        const text = input;
        setInput('');

        const newMessage = { fromMe: true, body: text, type: 'chat', timestamp: Date.now() };
        setMessages(prev => [...prev, newMessage]);

        try {
            await axios.post(`${API_URL}/api/send`, {
                chatId: selectedChat.id,
                message: text
            });
        } catch (e) {
            toast.error('Error al enviar mensaje');
        }
    };

    // Toggle Bot Action
    const handleToggleBot = async () => {
        if (!selectedChat) return;
        const newStatus = !selectedChat.isPaused;
        try {
            await axios.post(`${API_URL}/api/toggle-bot`, {
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
        const ok = await confirm("¿Seguro que querés borrar el historial y reiniciar el bot para este usuario?");
        if (!ok) return;
        try {
            await axios.post(`${API_URL}/api/reset-chat`, { chatId: selectedChat.id });
            setMessages([]);
            setSummaryText(null);
            toast.success('Chat reiniciado correctamente');
        } catch (e) { toast.error('Error reiniciando chat'); }
    };

    // AI Summarize
    const handleSummarize = async () => {
        if (!selectedChat) return;
        setSummarizing(true);
        try {
            const res = await axios.get(`${API_URL}/api/summarize/${selectedChat.id}`);
            setSummaryText(res.data.summary || res.data.message || 'No se pudo generar resumen.');
            toast.success('Resumen IA generado');
        } catch (e) {
            toast.error('Error generando resumen con IA');
            setSummaryText(null);
        }
        setSummarizing(false);
    };

    // Filter chats
    const filteredChats = searchTerm
        ? chats.filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()))
        : chats;

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

        if (msg.body && msg.body.startsWith('MEDIA_AUDIO:')) {
            const parts = msg.body.split('|');
            const url = parts[0].replace('MEDIA_AUDIO:', '');
            const transcription = parts[1] ? parts[1].replace('TRANSCRIPTION:', '') : null;
            const fullUrl = `${API_URL}${url}`;
            return (
                <div className="space-y-2 min-w-[200px]">
                    <audio controls className="h-8 w-full max-w-[240px]">
                        <source src={fullUrl} type="audio/ogg" />
                        <source src={fullUrl} type="audio/mpeg" />
                        Audio not supported
                    </audio>
                    {transcription && (
                        <div className="bg-black/10 dark:bg-white/10 p-2 rounded text-xs italic">
                            "{transcription}"
                        </div>
                    )}
                </div>
            );
        }

        return msg.body;
    };

    return (
        <div className="h-full flex overflow-hidden rounded-lg bg-white border border-slate-200 shadow-sm animate-fade-in">

            {/* 1. SIDEBAR: Contacts */}
            <div className="w-80 border-r border-slate-200 flex flex-col bg-slate-50">
                {/* Search */}
                <div className="p-4 border-b border-slate-200 bg-white">
                    <div className="relative">
                        <input
                            type="text"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Buscar contactos..."
                            className="w-full bg-slate-100 border border-slate-200 rounded-md pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all text-slate-700"
                        />
                        <span className="absolute left-3 top-2.5 text-slate-400"><Icons.Search /></span>
                    </div>
                </div>

                {/* Contact List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {filteredChats.length === 0 ? (
                        <div className="p-6 text-center text-slate-400 text-sm">
                            {searchTerm ? 'No se encontraron resultados' : 'No hay chats todavía'}
                        </div>
                    ) : (
                        filteredChats.map(chat => (
                            <div
                                key={chat.id}
                                onClick={() => setSelectedChat(chat)}
                                className={`p-4 flex gap-3 cursor-pointer transition-colors border-l-2 ${selectedChat?.id === chat.id ? 'bg-white border-blue-600 shadow-sm' : 'border-transparent hover:bg-slate-100'}`}
                            >
                                <div className="w-10 h-10 rounded bg-slate-200 flex items-center justify-center text-slate-500 font-bold text-xs uppercase shadow-sm relative">
                                    {chat.name.substring(0, 2)}
                                    {chat.isPaused && (
                                        <span className="absolute -bottom-1 -right-1 w-4 h-4 bg-amber-500 rounded-full border-2 border-white flex items-center justify-center">
                                            <span className="text-[8px] text-white">||</span>
                                        </span>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-baseline mb-0.5">
                                        <h3 className={`font-semibold text-sm truncate ${selectedChat?.id === chat.id ? 'text-blue-700' : 'text-slate-700'}`}>{chat.name}</h3>
                                        <span className="text-[10px] text-slate-400 font-medium font-mono">{chat.time}</span>
                                    </div>
                                    <p className="text-xs text-slate-500 truncate font-medium">{chat.lastMessage || 'Sin mensajes'}</p>
                                </div>
                                {chat.unread > 0 && (
                                    <div className="flex flex-col justify-center items-end">
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

            {/* 2. CHAT AREA */}
            <div className="flex-1 flex flex-col bg-[#eef2f6] relative">
                {selectedChat ? (
                    <>
                        {/* Header */}
                        <div className="h-16 border-b border-slate-200 flex items-center justify-between px-6 bg-white shadow-sm z-10">
                            <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded bg-slate-800 text-white flex items-center justify-center font-bold text-sm">
                                    {selectedChat.name.substring(0, 2)}
                                </div>
                                <div>
                                    <h2 className="font-bold text-slate-800 text-sm">{selectedChat.name}</h2>
                                    {selectedChat.isPaused ? (
                                        <p className="text-xs text-amber-600 font-bold flex items-center gap-1">
                                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span> BOT PAUSADO
                                        </p>
                                    ) : (
                                        <p className="text-xs text-emerald-600 font-bold flex items-center gap-1">
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> BOT ACTIVO
                                        </p>
                                    )}
                                </div>
                            </div>

                            {/* Actions Toolbar */}
                            <div className="flex items-center gap-2">
                                {/* AI Summarize Button */}
                                <button
                                    onClick={handleSummarize}
                                    disabled={summarizing || messages.length === 0}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition bg-violet-100 text-violet-700 hover:bg-violet-200 disabled:opacity-50"
                                    title="Generar resumen IA de esta conversación"
                                >
                                    {summarizing ? (
                                        <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin"></div>
                                    ) : (
                                        <Icons.AI />
                                    )}
                                    {summarizing ? 'RESUMIENDO...' : 'RESUMIR IA'}
                                </button>

                                <button
                                    onClick={handleToggleBot}
                                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold transition ${selectedChat.isPaused ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'}`}
                                >
                                    {selectedChat.isPaused ? <><Icons.Play /> REACTIVAR BOT</> : <><Icons.Pause /> PAUSAR BOT</>}
                                </button>
                                <button
                                    onClick={handleClearChat}
                                    title="Borrar historial y reiniciar flow"
                                    className="p-2 hover:bg-rose-100 rounded text-slate-400 hover:text-rose-600 transition"
                                >
                                    <Icons.Trash />
                                </button>
                            </div>
                        </div>

                        {/* AI Summary Banner */}
                        {summaryText && (
                            <div className="mx-6 mt-3 p-4 bg-violet-50 border border-violet-200 rounded-lg animate-fade-in relative">
                                <button
                                    onClick={() => setSummaryText(null)}
                                    className="absolute top-2 right-2 text-violet-400 hover:text-violet-600 text-xs"
                                >✕</button>
                                <div className="flex items-start gap-2">
                                    <span className="text-violet-600 mt-0.5"><Icons.AI /></span>
                                    <div>
                                        <p className="text-xs font-bold text-violet-700 uppercase tracking-wide mb-1">Resumen IA</p>
                                        <p className="text-sm text-violet-800 whitespace-pre-wrap leading-relaxed">{summaryText}</p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Messages */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
                            {loading ? (
                                <div className="flex items-center justify-center h-full">
                                    <div className="flex items-center gap-3 text-slate-400">
                                        <div className="w-5 h-5 border-2 border-slate-300 border-t-transparent rounded-full animate-spin"></div>
                                        <span className="text-sm">Cargando mensajes...</span>
                                    </div>
                                </div>
                            ) : messages.length === 0 ? (
                                <div className="flex items-center justify-center h-full text-slate-400 text-sm">
                                    No hay mensajes en este chat
                                </div>
                            ) : (
                                messages.map((msg, idx) => (
                                    <div key={idx} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                                        <div className={`max-w-[70%] p-3 text-sm leading-relaxed shadow-sm relative group ${msg.fromMe
                                            ? 'bg-blue-600 text-white rounded-l-lg rounded-br-lg'
                                            : 'bg-white text-slate-700 rounded-r-lg rounded-bl-lg border border-slate-200'
                                            }`}>
                                            {renderMessageBody(msg)}
                                            <span className={`text-[10px] block text-right mt-1 font-mono opacity-80 ${msg.fromMe ? 'text-blue-100' : 'text-slate-400'}`}>
                                                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                    </div>
                                ))
                            )}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Input */}
                        <div className="p-4 bg-white border-t border-slate-200">
                            <form onSubmit={handleSend} className="flex items-center gap-3">
                                <div className="flex-1 relative">
                                    <input
                                        type="text"
                                        value={input}
                                        onChange={(e) => setInput(e.target.value)}
                                        placeholder="Escribe un mensaje..."
                                        className="w-full bg-slate-50 border border-slate-200 rounded-md pl-4 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-all text-slate-700"
                                    />
                                </div>
                                <button type="submit" disabled={!input.trim()} className="bg-slate-900 hover:bg-black text-white p-2.5 rounded-md shadow-lg transition-all disabled:opacity-50">
                                    <Icons.Send />
                                </button>
                            </form>
                        </div>
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
            </div>
        </div>
    );
};

export default CommsView;
