import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../config/axios';
import { useAuth } from './AuthContext';

const SellerContext = createContext();

export const useSeller = () => useContext(SellerContext);

export const SellerProvider = ({ children }) => {
    const { isAdmin } = useAuth();
    const [sellers, setSellers] = useState([]);
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

    const selectedSeller = sellers.find(s => s.sellerId === selectedSellerId) || null;

    return (
        <SellerContext.Provider value={{
            sellers,
            selectedSellerId,
            setSelectedSellerId,
            selectedSeller,
            loadSellers,
        }}>
            {children}
        </SellerContext.Provider>
    );
};
