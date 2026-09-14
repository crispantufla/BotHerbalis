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

        // Sin sesión no hay socket: el servidor solo acepta el JWT.
        if (!token) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- sin sesión se limpia el socket; el effect maneja el ciclo de vida de la conexión
            setSocket(null);
            setIsConnected(false);
            return;
        }

        const newSocket = io(API_URL, {
            auth: { token },
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000,
            transports: ['websocket', 'polling']
        });

        newSocket.on('connect', () => {
            setIsConnected(true);
        });

        newSocket.on('disconnect', () => {
            setIsConnected(false);
        });

        setSocket(newSocket);

        // Ping every 2 minutes so the server knows the tab is still active
        const pingInterval = setInterval(() => {
            if (newSocket.connected) newSocket.emit('activity_ping');
        }, 2 * 60 * 1000);

        return () => {
            clearInterval(pingInterval);
            newSocket.close();
        };
    }, [user]);

    // Let components call socket.emit('switch-seller', id) directly
    return (
        <SocketContext.Provider value={{ socket, isConnected }}>
            {children}
        </SocketContext.Provider>
    );
};
