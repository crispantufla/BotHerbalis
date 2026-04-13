import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../config/axios';
import { useAuth } from './AuthContext';
import { useSocket } from './SocketContext';

const SellerContext = createContext();

export const useSeller = () => useContext(SellerContext);

export const SellerProvider = ({ children }) => {
    const { isAdmin, user } = useAuth();
    const { socket } = useSocket();
    const [sellers, setSellers] = useState([]);
    const [sellerPresence, setSellerPresence] = useState({}); // sellerId → boolean (web open)
    const [selectedSellerId, _setSelectedSellerId] = useState(() => {
        return localStorage.getItem('selectedSellerId') || null;
    });

    const setSelectedSellerId = useCallback((id) => {
        _setSelectedSellerId(id);
        if (id) {
            localStorage.setItem('selectedSellerId', id);
        } else {
            localStorage.removeItem('selectedSellerId');
        }
    }, []);

    const loadSellers = useCallback(async () => {
        if (!isAdmin) return;
        try {
            const res = await api.get('/api/sellers');
            setSellers(res.data);
        } catch (e) {
            console.error('[SellerContext] Failed to load sellers:', e);
        }
    }, [isAdmin]);

    useEffect(() => {
        if (isAdmin) {
            // Any admin (with or without a home sellerId) can see all sellers
            // and switch between them. Home sellerId is just their default.
            loadSellers();
        } else {
            // Regular seller: locked to their own sellerId.
            if (user?.sellerId) {
                _setSelectedSellerId(user.sellerId);
                localStorage.setItem('selectedSellerId', user.sellerId);
            } else {
                _setSelectedSellerId(null);
                localStorage.removeItem('selectedSellerId');
            }
        }
    }, [isAdmin, user?.sellerId, loadSellers]);

    // Listen for web presence updates from server (any admin who can supervise)
    useEffect(() => {
        if (!socket || !isAdmin) return;
        const handler = (presence) => setSellerPresence(presence);
        socket.on('sellers_presence', handler);
        return () => socket.off('sellers_presence', handler);
    }, [socket, isAdmin]);

    // Emit switch-seller on initial load and whenever selection changes,
    // so the server tracks admin presence for the viewed seller
    useEffect(() => {
        if (!socket || !isAdmin || !selectedSellerId) return;
        socket.emit('switch-seller', selectedSellerId);
    }, [socket, isAdmin, selectedSellerId]);

    // Auto-select a seller for admins: prefer their home sellerId (own seller),
    // then the current selection if still valid, then the first seller in the list.
    useEffect(() => {
        if (!isAdmin || sellers.length === 0) return;
        const current = sellers.find(s => s.sellerId === selectedSellerId);
        if (current) return;
        const home = user?.sellerId && sellers.find(s => s.sellerId === user.sellerId);
        setSelectedSellerId(home ? user.sellerId : sellers[0].sellerId);
    }, [isAdmin, sellers, selectedSellerId, setSelectedSellerId, user?.sellerId]);

    const selectedSeller = sellers.find(s => s.sellerId === selectedSellerId) || null;

    // Merge presence into sellers list for consumers
    // sellerPresence[sellerId] = 'online' | 'idle' | undefined (offline)
    const sellersWithPresence = sellers.map(s => ({
        ...s,
        webPresence: sellerPresence[s.sellerId] || 'offline', // 'online' | 'idle' | 'offline'
    }));

    return (
        <SellerContext.Provider value={{
            sellers: sellersWithPresence,
            selectedSellerId,
            setSelectedSellerId,
            selectedSeller: sellersWithPresence.find(s => s.sellerId === selectedSellerId) || null,
            loadSellers,
        }}>
            {children}
        </SellerContext.Provider>
    );
};
