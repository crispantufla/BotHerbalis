import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../config/axios';
import { useAuth } from './AuthContext';
import { useSocket } from './SocketContext';

const SellerContext = createContext();

export const useSeller = () => useContext(SellerContext);

export const SellerProvider = ({ children }) => {
    const { isAdmin } = useAuth();
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
        if (isAdmin) loadSellers();
        else {
            // Sellers only see their own data — clear any lingering selection
            _setSelectedSellerId(null);
            localStorage.removeItem('selectedSellerId');
        }
    }, [isAdmin, loadSellers]);

    // Listen for web presence updates from server
    useEffect(() => {
        if (!socket || !isAdmin) return;
        const handler = (presence) => setSellerPresence(presence);
        socket.on('sellers_presence', handler);
        return () => socket.off('sellers_presence', handler);
    }, [socket, isAdmin]);

    // Auto-select first seller if none is selected (admin must always have one)
    useEffect(() => {
        if (isAdmin && sellers.length > 0 && !sellers.find(s => s.sellerId === selectedSellerId)) {
            setSelectedSellerId(sellers[0].sellerId);
        }
    }, [isAdmin, sellers, selectedSellerId, setSelectedSellerId]);

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
