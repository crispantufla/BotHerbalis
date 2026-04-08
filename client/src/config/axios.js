import axios from 'axios';
import { API_URL } from './api';

const api = axios.create({
    baseURL: API_URL,
    headers: {
        'Content-Type': 'application/json',
    }
});

// Inject JWT token and seller context into every request
api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    } else {
        // Legacy fallback for API_KEY during migration
        const apiKey = import.meta.env.VITE_API_KEY;
        if (apiKey) config.headers['x-api-key'] = apiKey;
    }

    // Inject selected seller for admin multi-tenant context
    const sellerId = localStorage.getItem('selectedSellerId');
    if (sellerId) config.headers['x-seller-id'] = sellerId;

    return config;
});

// Redirect to login on 401
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            if (window.location.pathname !== '/login') {
                window.location.href = '/login';
            }
        }
        return Promise.reject(error);
    }
);

export default api;
