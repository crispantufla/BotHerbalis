import React, { createContext, useContext, useState, useEffect } from 'react';
import api from '../config/axios';
import { useToast } from '../components/ui/Toast';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const { toast } = useToast();

    useEffect(() => {
        // Restore session from localStorage
        const storedUser = localStorage.getItem('user');
        const storedToken = localStorage.getItem('token');
        if (storedUser && storedToken) {
            try {
                const parsed = JSON.parse(storedUser);
                setUser(parsed);
                // For non-admin users, ensure selectedSellerId is set
                if (parsed.role !== 'admin' && parsed.sellerId && !localStorage.getItem('selectedSellerId')) {
                    localStorage.setItem('selectedSellerId', parsed.sellerId);
                }
            } catch (e) {
                localStorage.removeItem('user');
                localStorage.removeItem('token');
            }
        }
        setLoading(false);
    }, []);

    const login = async (username, password) => {
        try {
            const res = await api.post('/api/login', { username, password });
            if (res.data.token) {
                localStorage.setItem('token', res.data.token);
                localStorage.setItem('user', JSON.stringify(res.data.user));
                setUser(res.data.user);
                // Auto-select seller for non-admin users; admins start with "all sellers" view
                if (res.data.user.role !== 'admin' && res.data.user.sellerId) {
                    localStorage.setItem('selectedSellerId', res.data.user.sellerId);
                }
                return true;
            }
        } catch (e) {
            console.error("Login failed", e);
            toast.error(e.response?.data?.error || "Error de conexión");
            return false;
        }
        return false;
    };

    const logout = () => {
        setUser(null);
        localStorage.removeItem('user');
        localStorage.removeItem('token');
        localStorage.removeItem('selectedSellerId');
    };

    const isAdmin = user?.role === 'admin';

    return (
        <AuthContext.Provider value={{ user, login, logout, loading, isAdmin }}>
            {!loading && children}
        </AuthContext.Provider>
    );
};
