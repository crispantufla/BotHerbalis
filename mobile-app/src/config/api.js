/**
 * Shared API Configuration
 * Centralizes the API_URL so all views use the same base URL.
 * Uses VITE_API_URL env var for production deployments.
 */
export const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3000');
