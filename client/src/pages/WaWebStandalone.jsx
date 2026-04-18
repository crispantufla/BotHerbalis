import React from 'react';
import { useSearchParams } from 'react-router-dom';
import WhatsappViewerView from '../components/corporate/WhatsappViewerView';

/**
 * Full-window WhatsApp Web viewer — no dashboard chrome, no sidebar.
 * Reads sellerId from ?sellerId=... query param (for admins).
 * Sellers fall back to their own sellerId via WhatsappViewerView's default.
 */
export default function WaWebStandalone() {
    const [params] = useSearchParams();
    const sellerIdOverride = params.get('sellerId');
    return <WhatsappViewerView standalone sellerIdOverride={sellerIdOverride} />;
}
