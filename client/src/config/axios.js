import axios from 'axios';
import { API_URL } from './api';

const api = axios.create({
    baseURL: API_URL,
    headers: {
        'Content-Type': 'application/json',
        'x-api-key': import.meta.env.VITE_API_KEY || 'herbalis_secret_key_123'
    }
});

export default api;
