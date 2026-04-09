import React, { createContext, useContext, useEffect, useState } from 'react';
import io from 'socket.io-client';
import { API_URL } from '../config/api';
import { useAuth } from './AuthContext';

const SocketContext = createContext();

export const useSocket = () => useContext(SocketContext);

export const SocketProvider = ({ children }) => {
    const [socket, setSocket] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    const { user } = useAuth();

    // Reconnect socket when user changes (login/logout)
    useEffect(() => {
        const token = localStorage.getItem('token');
        const apiKey = import.meta.env.VITE_API_KEY;

        // Don't connect if no auth available
        if (!token && !apiKey) {
            setSocket(null);
            setIsConnected(false);
            return;
        }

        const auth = token ? { token } : { apiKey };

        const newSocket = io(API_URL, {
            auth,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
            transports: ['websocket', 'polling']
        });

        newSocket.on('connect', () => {
            console.log('Socket connected');
            setIsConnected(true);
        });

        newSocket.on('disconnect', () => {
            console.log('Socket disconnected');
            setIsConnected(false);
        });

        setSocket(newSocket);

        return () => newSocket.close();
    }, [user]);

    // Let components call socket.emit('switch-seller', id) directly
    return (
        <SocketContext.Provider value={{ socket, isConnected }}>
            {children}
        </SocketContext.Provider>
    );
};
