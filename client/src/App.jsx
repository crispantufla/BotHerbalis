import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './context/SocketContext';
import { ToastProvider } from './components/ui/Toast';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SellerProvider } from './context/SellerContext';
import CorporateDashboard from './pages/designs/CorporateDashboard';
import Login from './pages/Login';
import WaWebStandalone from './pages/WaWebStandalone';

// Protected Route Component
const ProtectedRoute = ({ children }) => {
    const { user, loading } = useAuth();
    if (loading) return <div className="h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900"><div className="w-8 h-8 border-4 border-blue-600 dark:border-indigo-500 border-t-transparent dark:border-t-transparent rounded-full animate-spin"></div></div>;
    if (!user) return <Navigate to="/login" replace />;
    return children;
};

function App() {
    return (
        <ThemeProvider>
            <ToastProvider>
                <AuthProvider>
                    <SocketProvider>
                        <SellerProvider>
                            <Router>
                                <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-sans transition-colors duration-300">
                                    <Routes>
                                        {/* Public Route */}
                                        <Route path="/login" element={<Login />} />

                                        {/* Standalone full-window WhatsApp Web viewer (no sidebar/header) */}
                                        <Route path="/wa-web" element={
                                            <ProtectedRoute>
                                                <WaWebStandalone />
                                            </ProtectedRoute>
                                        } />

                                        {/* Protected Route - Corporate Enterprise V2 (Main Dashboard) */}
                                        <Route path="/*" element={
                                            <ProtectedRoute>
                                                <CorporateDashboard />
                                            </ProtectedRoute>
                                        } />

                                        {/* Catch all - Redirect to Home */}
                                        <Route path="*" element={<Navigate to="/" replace />} />
                                    </Routes>
                                </div>
                            </Router>
                        </SellerProvider>
                    </SocketProvider>
                </AuthProvider>
            </ToastProvider>
        </ThemeProvider>
    );
}

export default App;
