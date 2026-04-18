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
                if (parsed.sellerId && !localStorage.getItem('selectedSellerId')) {
                    localStorage.setItem('selectedSellerId', parsed.sellerId);
                }
                // Refresh from /api/me so newly-added server-side flags
                // (e.g. canViewWaWeb) appear without requiring a re-login
                api.get('/api/me')
                    .then(res => {
                        if (res.data) {
                            const fresh = { ...parsed, ...res.data };
                            localStorage.setItem('user', JSON.stringify(fresh));
                            setUser(fresh);
                        }
                    })
                    .catch(() => {
                        // /me failed (token expired, etc.) — logout cleanly
                        localStorage.removeItem('user');
                        localStorage.removeItem('token');
                        setUser(null);
                    });
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
                // Auto-select seller on login (for sellers locked to their own, for admins their default)
                if (res.data.user.sellerId) {
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

    // All admins share the same privileges regardless of sellerId. The only
    // functional difference is that admins with a sellerId run their own
    // WhatsApp client (and scan a QR); admins without one don't.
    const isAdmin = user?.role === 'admin';

    return (
        <AuthContext.Provider value={{ user, login, logout, loading, isAdmin }}>
            {!loading && children}
        </AuthContext.Provider>
    );
};
