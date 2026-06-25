import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../config/axios';
import { useSocket } from '../context/SocketContext';
import { useSeller } from '../context/SellerContext';

export const useChat = (selectedChatId) => {
    const queryClient = useQueryClient();
    const { socket } = useSocket();
    const { selectedSellerId } = useSeller();

    const [instanceId, setInstanceId] = useState('default');
    const [globalPause, setGlobalPause] = useState(false);

    // Reset local chat state when seller changes
    useEffect(() => {
        setChats([]);
        setMessages([]);
    }, [selectedSellerId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Initial Metadata Fetching (Chats list, global status)
    const { data: metaData, isLoading: isLoadingChats } = useQuery({
        queryKey: ['chatMetadata', selectedSellerId],
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

    // Prefetch history for chats with recent activity (last 3h) — one at a time to not overwhelm WA
    useEffect(() => {
        if (!metaData?.chats?.length) return;
        const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
        const recent = metaData.chats
            .filter(c => c.lastMessage?.timestamp && c.lastMessage.timestamp > threeHoursAgo)
            .slice(0, 8); // max 8 chats

        let cancelled = false;
        (async () => {
            for (const chat of recent) {
                if (cancelled) break;
                const key = ['messages', chat.id, selectedSellerId];
                if (queryClient.getQueryData(key)) continue; // already cached
                await queryClient.prefetchQuery({
                    queryKey: key,
                    queryFn: () => api.get(`/api/history/${chat.id}?prefetch=1`).then(r => r.data),
                    staleTime: 60 * 1000,
                });
                await new Promise(r => setTimeout(r, 800)); // stagger to avoid WA overload
            }
        })();
        return () => { cancelled = true; };
    }, [metaData, selectedSellerId, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

    const { data: messagesData, isLoading: isLoadingMessages } = useQuery({
        queryKey: ['messages', selectedChatId, selectedSellerId],
        queryFn: async () => {
            if (!selectedChatId) return [];
            const res = await api.get(`/api/history/${selectedChatId}`);
            return res.data;
        },
        enabled: !!selectedChatId,
        staleTime: 60 * 1000, // consider cached result fresh for 1 min — re-opening same chat is instant
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

                // Match teléfono-tolerante (mismo criterio que el preview de la lista
                // más abajo): el chatId del socket puede diferir del id de la lista
                // cuando el número resuelve vía @lid/proxy (más común si hay otra
                // sesión de WhatsApp Web abierta). Sin esto, el preview se actualizaba
                // (match difuso) pero el append a la ventana abierta fallaba (match
                // exacto) → el mensaje aparecía en la lista pero no en el chat abierto.
                const incomingPhone = data.chatId.replace(/\D/g, '');
                const matchesSelected = !!currentSelectedId && (
                    currentSelectedId === data.chatId ||
                    (incomingPhone.length >= 10 && currentSelectedId.replace(/\D/g, '').endsWith(incomingPhone.slice(-10)))
                );

                if (matchesSelected) {
                    const isMe = data.sender === 'bot' || data.sender === 'admin';
                    const newMsg = { id: data.messageId || `socket-${timestamp}`, fromMe: isMe, body: data.text || '', type: 'chat', timestamp };
                    setMessages((prev) => {
                        const list = Array.isArray(prev) ? prev : [];

                        // 1) Reemplazar el placeholder optimista (mensaje propio recién
                        //    enviado desde el panel) por la versión confirmada.
                        if (isMe) {
                            const pendingIndex = list.findIndex(m => m.pending && m.body === newMsg.body && Math.abs(m.timestamp - timestamp) < 10000);
                            if (pendingIndex !== -1) {
                                const updated = [...list];
                                updated[pendingIndex] = { ...newMsg, pending: false };
                                return updated.sort((a, b) => a.timestamp - b.timestamp);
                            }
                        }

                        // 2) De-dup con tolerancia — MISMO criterio que el merge del
                        //    backend en GET /history (mismo emisor + body + ventana 60s).
                        //    El backend loguea un mismo mensaje del bot por dos caminos
                        //    (logAndEmit 'bot' + message_create 'admin' si el id no llegó
                        //    a tiempo a botSentMessageIds — más probable con el agente
                        //    remoto), y un admin global recibe cada evento dos veces
                        //    (rooms seller + admin). Con el de-dup viejo (timestamp EXACTO)
                        //    esos llegaban con ts distintos y se veían duplicados hasta
                        //    recargar. La tolerancia los colapsa en vivo, igual que el refetch.
                        const exists = list.some(m =>
                            (m.id && m.id === newMsg.id) ||
                            (m.fromMe === newMsg.fromMe && m.body === newMsg.body && Math.abs(m.timestamp - timestamp) <= 60000)
                        );
                        if (exists) return list;

                        // 3) Insertar y reordenar por timestamp. Los eventos por socket
                        //    llegan desordenados (delays humanizados del bot, latencia del
                        //    bridge remoto, mensaje manual de Horacio desde el móvil); antes
                        //    se appendeaban al final sin reordenar → "no salen en orden" y
                        //    los manuales parecían faltar por caer en el lugar equivocado.
                        return [...list, newMsg].sort((a, b) => a.timestamp - b.timestamp);
                    });
                }

                setChats((prev) => {
                    if (!Array.isArray(prev)) return [];
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
            } catch (err) { console.error('[useChat] Error handling socket message:', err); }
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
