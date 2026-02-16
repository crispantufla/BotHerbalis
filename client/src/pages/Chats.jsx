import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useSocket } from '../context/SocketContext';

const Chats = () => {
    const { socket } = useSocket();
    const [chats, setChats] = useState([]);
    const [selectedChatId, setSelectedChatId] = useState(null);
    const [messages, setMessages] = useState([]);
    const [messageText, setMessageText] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const messagesEndRef = useRef(null);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [showRightPanel, setShowRightPanel] = useState(false);

    const API_URL = 'http://localhost:3001';

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    useEffect(() => {
        fetchChats();
        if (socket) {
            socket.on('new_log', (log) => {
                if (selectedChatId === log.chatId) {
                    setMessages(prev => [...prev, {
                        fromMe: log.sender === 'bot' || log.sender === 'admin' || log.sender === 'system',
                        body: log.text,
                        timestamp: Math.floor(new Date(log.timestamp).getTime() / 1000),
                        id: 'temp_' + Date.now()
                    }]);
                }
                setChats(prevChats => {
                    const index = prevChats.findIndex(c => c.id === log.chatId);
                    if (index === -1) return prevChats;
                    const updated = [...prevChats];
                    updated[index] = {
                        ...updated[index],
                        lastMessage: log.text,
                        timestamp: Math.floor(new Date().getTime() / 1000),
                        step: log.step || updated[index].step
                    };
                    const item = updated.splice(index, 1)[0];
                    updated.unshift(item);
                    return updated;
                });
            });
            socket.on('bot_status_change', ({ chatId, paused }) => {
                setChats(prev => prev.map(c => c.id === chatId ? { ...c, isPaused: paused } : c));
            });
        }
        return () => {
            if (socket) {
                socket.off('new_log');
                socket.off('bot_status_change');
            }
        };
    }, [socket, selectedChatId]);

    useEffect(() => {
        if (selectedChatId) {
            axios.get(`${API_URL}/api/history/${selectedChatId}`)
                .then(res => setMessages(res.data))
                .catch(err => console.error(err));
            setChats(prev => prev.map(c => c.id === selectedChatId ? { ...c, unreadCount: 0 } : c));
            axios.post(`${API_URL}/api/chats/${selectedChatId}/read`).catch(() => { });
        }
    }, [selectedChatId]);

    const fetchChats = async () => {
        try {
            const res = await axios.get(`${API_URL}/api/chats`);
            setChats(res.data);
        } catch (e) {
            console.error(e);
        }
    };

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (!messageText.trim() || !selectedChatId) return;
        try {
            await axios.post(`${API_URL}/api/send`, { chatId: selectedChatId, message: messageText });
            setMessageText('');
        } catch (err) { alert('Error sending'); }
    };

    const toggleBot = async (chatId, currentStatus) => {
        try { await axios.post(`${API_URL}/api/toggle-bot`, { chatId, paused: !currentStatus }); }
        catch (e) { console.error(e); }
    };

    const formatTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const filteredChats = chats.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()) || c.id.includes(searchQuery));
    const selectedChat = chats.find(c => c.id === selectedChatId);

    const SCRIPT_LABELS = {
        greeting: "Saludo",
        waiting_weight: "Pedir Peso",
        recommendation: "Recomendación",
        waiting_preference: "Pedir Preferencia",
        preference_capsulas: "Info Cápsulas",
        preference_semillas: "Info Semillas",
        waiting_plan_choice: "Elegir Plan",
        closing: "Cierre Venta",
        waiting_ok: "Esperar OK",
        data_request: "Pedir Datos",
        waiting_data: "Esperando Datos",
        waiting_admin_ok: "Revisión Admin",
        completed: "Completado"
    };

    return (
        <div className="flex h-full bg-white border border-gray-200 shadow-sm rounded-xl overflow-hidden">

            {/* --- SIDEBAR LIST --- */}
            <div className={`${isSidebarOpen ? 'w-full md:w-80' : 'w-0'} bg-white border-r flex flex-col transition-all duration-300`}>
                <div className="p-3 bg-gray-50 border-b flex justify-between items-center h-16">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-gray-300"></div>
                        <span className="font-medium text-gray-700">Chats</span>
                    </div>
                    <div className="flex gap-2 text-gray-500">
                        <button title="Nuevo Chat">📝</button>
                        <button title="Opciones">⋮</button>
                    </div>
                </div>

                <div className="p-2 bg-white border-b">
                    <div className="bg-gray-100 rounded-lg flex items-center px-3 py-1.5">
                        <span className="text-gray-400 mr-2">🔍</span>
                        <input
                            type="text"
                            placeholder="Buscar o empezar un nuevo chat"
                            className="bg-transparent w-full text-sm outline-none placeholder-gray-500"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto bg-white">
                    {filteredChats.map(chat => (
                        <div
                            key={chat.id}
                            onClick={() => { setSelectedChatId(chat.id); setIsSidebarOpen(false); }}
                            className={`flex items-center p-3 cursor-pointer hover:bg-gray-50 transition border-b border-gray-100 ${selectedChatId === chat.id ? 'bg-[#f0f2f5]' : ''}`}
                        >
                            <div className="w-12 h-12 rounded-full bg-gray-200 flex-shrink-0 flex items-center justify-center text-xl mr-3">👤</div>
                            <div className="flex-1 min-w-0">
                                <div className="flex justify-between items-baseline">
                                    <h4 className="text-gray-900 font-normal truncate">{chat.name}</h4>
                                    <span className={`text-xs ${chat.unreadCount > 0 ? 'text-green-500 font-bold' : 'text-gray-400'}`}>
                                        {formatTime(chat.timestamp)}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center mt-0.5">
                                    <p className="text-sm text-gray-500 truncate flex-1 pr-2">
                                        {chat.isPaused && <span className="text-red-500 font-bold text-xs mr-1">PAUSADO</span>}
                                        {chat.lastMessage}
                                    </p>
                                    <div className="flex gap-1">
                                        {chat.unreadCount > 0 && (
                                            <span className="bg-green-500 text-white text-xs px-1.5 py-0.5 rounded-full font-bold min-w-[1.2rem] text-center">
                                                {chat.unreadCount}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* --- MAIN CHAT AREA --- */}
            <div className="flex-1 flex flex-col h-full bg-[#efe7dd] relative">
                {selectedChatId ? (
                    <>
                        {/* HEADER */}
                        <div className="h-16 bg-[#f0f2f5] px-4 flex justify-between items-center border-b border-gray-300 shadow-sm z-10">
                            <div className="flex items-center gap-3 clickable" onClick={() => setShowRightPanel(!showRightPanel)}>
                                <button onClick={(e) => { e.stopPropagation(); setIsSidebarOpen(!isSidebarOpen); }} className="md:hidden text-gray-600">⬅</button>
                                <div className="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center text-xl">👤</div>
                                <div>
                                    <h3 className="text-gray-900 font-normal truncate max-w-[150px] md:max-w-xs">{selectedChat?.name}</h3>
                                    <p className="text-xs text-gray-500">Hacé clic para info del contacto</p>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                {/* PAUSE BUTTON - PROMINENT */}
                                <button
                                    onClick={() => toggleBot(selectedChatId, selectedChat?.isPaused)}
                                    className={`px-4 py-2 rounded shadow-sm text-sm font-bold uppercase tracking-wide transition ${selectedChat?.isPaused
                                        ? 'bg-green-600 text-white hover:bg-green-700'
                                        : 'bg-red-500 text-white hover:bg-red-600'}`}
                                >
                                    {selectedChat?.isPaused ? '▶ Reactivar Bot' : '⏸ Pausar Bot'}
                                </button>
                                <button className="text-gray-500 px-2 py-2 hover:bg-gray-200 rounded-full">🔍</button>
                                <button className="text-gray-500 px-2 py-2 hover:bg-gray-200 rounded-full">⋮</button>
                            </div>
                        </div>

                        {/* MESSAGES BACKGROUND */}
                        <div className="absolute inset-0 z-0 opacity-40 pointer-events-none" style={{ backgroundImage: 'url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")' }}></div>

                        {/* MESSAGES LIST */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-2 relative z-10">
                            {messages.map((m, i) => {
                                const isBot = m.fromMe;
                                const bubbleColor = isBot ? 'bg-[#d9fdd3]' : 'bg-white';
                                const alignClass = isBot ? 'justify-end' : 'justify-start';
                                const roundedClass = isBot ? 'rounded-tr-none' : 'rounded-tl-none';

                                // MULTIMEDIA CONTENT RENDERER
                                let content = null;
                                if (m.body && m.body.startsWith('MEDIA_IMAGE:')) {
                                    const url = m.body.split('MEDIA_IMAGE:')[1];
                                    content = <img src={`${API_URL}${url}`} alt="Sticker/Image" className="rounded-md max-w-full max-h-60 object-contain" />;
                                } else if (m.body && m.body.startsWith('MEDIA_AUDIO:')) {
                                    const parts = m.body.split('|');
                                    const url = parts[0].split('MEDIA_AUDIO:')[1];
                                    const transcription = parts.find(p => p.startsWith('TRANSCRIPTION:'))?.split('TRANSCRIPTION:')[1];
                                    content = (
                                        <div className="min-w-[240px]">
                                            <div className="flex items-center gap-2 mb-2 text-gray-500 text-xs">🎤 Audio Recibido</div>
                                            <audio controls src={`${API_URL}${url}`} className="h-8 w-full mb-2" />
                                            {transcription && (
                                                <div className="text-xs italic text-gray-600 bg-black/5 p-2 rounded border-l-2 border-green-500">
                                                    "{transcription}"
                                                </div>
                                            )}
                                        </div>
                                    );
                                } else {
                                    content = <div className="whitespace-pre-wrap leading-relaxed text-sm text-gray-800">{m.body}</div>;
                                }

                                return (
                                    <div key={i} className={`flex ${alignClass} mb-1`}>
                                        <div className={`max-w-[85%] md:max-w-[65%] px-3 py-2 rounded-lg shadow-sm relative ${bubbleColor} ${roundedClass} break-words`}>
                                            {content}
                                            <div className="flex justify-end gap-1 mt-1 -mb-1">
                                                <span className="text-[10px] text-gray-500 min-w-[3.5rem] text-right">
                                                    {formatTime(m.timestamp)}
                                                    {isBot && <span className={`ml-1 ${true ? "text-[#53bdeb]" : "text-gray-400"}`}>✓✓</span>}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* INPUT AREA */}
                        <div className="bg-[#f0f2f5] px-4 py-3 flex items-center gap-3 z-20">
                            <button className="text-gray-500 hover:text-gray-600">😃</button>
                            <button className="text-gray-500 hover:text-gray-600">📎</button>
                            <form onSubmit={handleSendMessage} className="flex-1">
                                <input
                                    type="text"
                                    className="w-full px-4 py-2 rounded-lg border-none focus:outline-none shadow-sm text-sm"
                                    placeholder="Escribe un mensaje aquí"
                                    value={messageText}
                                    onChange={(e) => setMessageText(e.target.value)}
                                />
                            </form>
                            {messageText.trim() ? (
                                <button onClick={handleSendMessage} className="p-2 text-[#00a884] hover:bg-gray-200 rounded-full transition">
                                    <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M1.101 21.757 23.8 12.028 1.101 2.3l.011 7.912 13.623 1.816-13.623 1.817-.011 7.912z"></path></svg>
                                </button>
                            ) : (
                                <button className="text-gray-500 hover:text-gray-600">🎤</button>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center p-10 text-center border-b-8 border-[#00a884]">
                        <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/WhatsApp.svg/1024px-WhatsApp.svg.png" alt="WhatsApp" className="w-20 h-20 opacity-20 mb-6" />
                        <h2 className="text-3xl font-light text-gray-600 mb-4">Herbalis Web</h2>
                        <p className="text-gray-500 text-sm max-w-md leading-6">
                            Envía y recibe mensajes sin necesidad de mantener tu teléfono conectado.<br />
                            Usá Herbalis Bot en hasta 4 dispositivos vinculados y 1 teléfono a la vez.
                        </p>
                        <div className="mt-8 text-xs text-gray-400">🔒 Cifrado de extremo a extremo</div>
                    </div>
                )}
            </div>

            {/* INFO SIDEBAR */}
            {showRightPanel && selectedChat && (
                <div className="w-80 bg-white border-l border-gray-200 flex flex-col h-full animate-slide-in shadow-xl z-30">
                    <div className="h-16 bg-[#f0f2f5] px-4 flex items-center border-b">
                        <button onClick={() => setShowRightPanel(false)} className="mr-4 text-gray-600">✕</button>
                        <span className="font-medium text-gray-700">Info. del contacto</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-6 bg-white">
                        <div className="flex flex-col items-center mb-6">
                            <div className="w-32 h-32 rounded-full bg-gray-200 text-6xl flex items-center justify-center mb-4 text-gray-400">👤</div>
                            <h2 className="text-xl font-normal text-gray-900 mb-1">{selectedChat.name}</h2>
                            <p className="text-gray-500">~{selectedChat.id.split('@')[0]}</p>
                        </div>

                        <div className="bg-white shadow-sm rounded-lg border border-gray-100 p-4 mb-4">
                            <p className="text-sm text-green-600 font-bold mb-1">Estado del Funnel</p>
                            <p className="text-gray-800">{SCRIPT_LABELS[selectedChat.step] || selectedChat.step}</p>
                        </div>

                        <div className="space-y-2">
                            <button className="w-full py-2 bg-red-50 text-red-600 rounded flex items-center justify-center gap-2 hover:bg-red-100 transition">
                                🚫 Bloquear
                            </button>
                            <button className="w-full py-2 bg-gray-50 text-gray-600 rounded flex items-center justify-center gap-2 hover:bg-gray-100 transition">
                                🗑️ Eliminar chat
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Chats;
