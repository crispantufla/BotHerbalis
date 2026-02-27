import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './context/SocketContext';
import { ToastProvider } from './components/ui/Toast';
import { Toaster } from 'sonner';
import NotificationSystem from './components/notifications/NotificationSystem';
import CorporateDashboardV2 from './pages/designs/v2/CorporateDashboardV2';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';

// Protected Route Component
const ProtectedRoute = ({ children }) => {
    const { user, loading } = useAuth();
    if (loading) return <div className="h-screen flex items-center justify-center bg-slate-50"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>;
    if (!user) return <Navigate to="/login" replace />;
    return children;
};

function App() {
    return (
        <ToastProvider>
            <AuthProvider>
                <SocketProvider>
                    {/* Sonner toast container — dark theme, top-right */}
                    <Toaster
                        position="top-right"
                        toastOptions={{
                            style: {
                                background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
                                border: '1px solid rgba(148, 163, 184, 0.2)',
                                borderRadius: '12px',
                                color: '#f1f5f9',
                                fontSize: '13px',
                            },
                        }}
                        richColors
                        expand
                        closeButton
                    />
                    {/* Global notification listener */}
                    <NotificationSystem />
                    <Router>
                        <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
                            <Routes>
                                {/* Public Route */}
                                <Route path="/login" element={<Login />} />

                                {/* Protected Route - Corporate Enterprise V2 (Main Dashboard) */}
                                <Route path="/*" element={
                                    <ProtectedRoute>
                                        <CorporateDashboardV2 />
                                    </ProtectedRoute>
                                } />


                                {/* Catch all - Redirect to Home */}
                                <Route path="*" element={<Navigate to="/" replace />} />
                            </Routes>
                        </div>
                    </Router>
                </SocketProvider>
            </AuthProvider>
        </ToastProvider>
    );
}

export default App;
