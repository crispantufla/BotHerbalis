import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../config/axios';
import { useSocket } from '../context/SocketContext';

export const useChat = (selectedChatId) => {
    const queryClient = useQueryClient();
    const { socket } = useSocket();

    const [instanceId, setInstanceId] = useState('default');
    const [globalPause, setGlobalPause] = useState(false);

    // Initial Metadata Fetching (Chats list, global status)
    const { data: metaData, isLoading: isLoadingChats } = useQuery({
        queryKey: ['chatMetadata'],
        queryFn: async () => {
            const statusRes = await api.get('/api/status');
            const id = statusRes.data?.instanceId || 'default';
            setInstanceId(id);

            const [chatsRes, statsRes] = await Promise.all([
                api.get(`/api/chats?instanceId=${id}`),
                api.get('/api/stats')
            ]);

            const chatsWithTime = chatsRes.data.map(c => ({
                ...c,
                time: c.lastMessage?.timestamp ? new Date(c.lastMessage.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) : ''
            }));

            setGlobalPause(!!statsRes.data.globalPause);

            return {
                chats: chatsWithTime,
                stats: statsRes.data
            };
        },
        staleTime: 5000 // Cache for 5 seconds to avoid spamming
    });

    // We maintain chats locally to allow manual optimistic updates fast
    const [chats, setChats] = useState([]);
    useEffect(() => {
        if (metaData?.chats) setChats(metaData.chats);
    }, [metaData]);

    const { data: messagesData, isLoading: isLoadingMessages } = useQuery({
        queryKey: ['messages', selectedChatId],
        queryFn: async () => {
            if (!selectedChatId) return [];
            const res = await api.get(`/api/history/${selectedChatId}`);
            return res.data;
        },
        enabled: !!selectedChatId,
    });

    const [messages, setMessages] = useState([]);
    useEffect(() => {
        if (messagesData) setMessages(messagesData);
        else setMessages([]);
    }, [messagesData, selectedChatId]);

    const selectedChatIdRef = useRef(selectedChatId);
    useEffect(() => {
        selectedChatIdRef.current = selectedChatId;
    }, [selectedChatId]);

    // WebSocket logic for updates
    useEffect(() => {
        if (!socket) return;

        const handleNewLog = (data) => {
            try {
                if (!data || !data.chatId) return;
                let timestamp = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();
                const currentSelectedId = selectedChatIdRef.current;

                if (currentSelectedId === data.chatId) {
                    const isMe = data.sender === 'bot' || data.sender === 'admin';
                    const newMsg = { id: data.messageId || `socket-${timestamp}`, fromMe: isMe, body: data.text || '', type: 'chat', timestamp };
                    setMessages((prev) => {
                        if (!Array.isArray(prev)) return [newMsg];
                        if (isMe) {
                            const pendingIndex = prev.findIndex(m => m.pending && m.body === newMsg.body && Math.abs(m.timestamp - timestamp) < 10000);
                            if (pendingIndex !== -1) {
                                const updated = [...prev];
                                updated[pendingIndex] = { ...newMsg, pending: false };
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
                    const incomingPhone = data.chatId.replace(/\D/g, '');
                    const existingChat = prev.find(c => c.id === data.chatId || (incomingPhone && c.id.replace(/\D/g, '').endsWith(incomingPhone.slice(-10))));

                    if (existingChat) {
                        return prev.map((c) => c.id === existingChat.id ? {
                            ...c,
                            lastMessage: { body: data.text || '', timestamp },
                            unreadCount: currentSelectedId === existingChat.id ? 0 : (c.unreadCount || 0) + 1,
                            time: new Date(timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }),
                            assignedScript: data.assignedScript || c.assignedScript
                        } : c);
                    }
                    return [{
                        id: data.chatId,
                        name: data.chatId,
                        unreadCount: currentSelectedId === data.chatId ? 0 : 1,
                        lastMessage: { body: data.text || '', timestamp },
                        time: new Date(timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }),
                        assignedScript: data.assignedScript
                    }, ...prev];
                });
            } catch (err) { }
        };

        const handleBotStatusChange = (data) => {
            if (!data) return;
            setChats(prev => Array.isArray(prev) ? prev.map(c => c.id === data.chatId ? { ...c, isPaused: data.paused } : c) : []);
        };

        const handleGlobalPause = (data) => {
            if (data && typeof data.globalPause !== 'undefined') {
                setGlobalPause(data.globalPause);
            }
        };

        socket.on('new_log', handleNewLog);
        socket.on('bot_status_change', handleBotStatusChange);
        socket.on('global_pause_changed', handleGlobalPause);

        return () => {
            socket.off('new_log', handleNewLog);
            socket.off('bot_status_change', handleBotStatusChange);
            socket.off('global_pause_changed', handleGlobalPause);
        };
    }, [socket]);

    const sendMessageMutation = useMutation({
        mutationFn: async ({ chatId, message }) => {
            await api.post('/api/send', { chatId, message });
        }
    });

    const sendMediaMutation = useMutation({
        mutationFn: async ({ chatId, base64, mimetype, filename, caption }) => {
            await api.post('/api/send-media', { chatId, base64, mimetype, filename, caption });
        }
    });

    const deleteMessageMutation = useMutation({
        mutationFn: async ({ chatId, messageId }) => {
            await api.delete('/api/messages', { data: { chatId, messageId } });
        }
    });

    const toggleBotMutation = useMutation({
        mutationFn: async ({ chatId, paused }) => {
            await api.post('/api/toggle-bot', { chatId, paused });
        }
    });

    const clearChatMutation = useMutation({
        mutationFn: async (chatId) => {
            await api.post('/api/reset-chat', { chatId });
        }
    });

    return {
        chats,
        setChats,
        messages,
        setMessages,
        isLoadingChats,
        isLoadingMessages,
        globalPause,
        instanceId,
        sendMessage: sendMessageMutation.mutateAsync,
        sendMedia: sendMediaMutation.mutateAsync,
        deleteMessage: deleteMessageMutation.mutateAsync,
        toggleBot: toggleBotMutation.mutateAsync,
        clearChat: clearChatMutation.mutateAsync,
    };
};
