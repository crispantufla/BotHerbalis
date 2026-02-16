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
        // Check initial auth state
        const storedUser = localStorage.getItem('user');
        if (storedUser) {
            try {
                setUser(JSON.parse(storedUser));
            } catch (e) {
                console.error("Failed to parse user", e);
                localStorage.removeItem('user');
            }
        }
        setLoading(false);
    }, []);

    const login = async (username, password) => {
        try {
            const res = await api.post('/api/login', { username, password });
            if (res.data.success) {
                setUser(res.data.user);
                localStorage.setItem('user', JSON.stringify(res.data.user)); // Simple Persistence
                // Optionally store token if needed for API calls (current axios config uses hardcoded)
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
        // api.post('/api/logout'); // Optional
    };

    return (
        <AuthContext.Provider value={{ user, login, logout, loading }}>
            {!loading && children}
        </AuthContext.Provider>
    );
};
