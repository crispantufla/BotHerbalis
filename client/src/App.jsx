import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './context/SocketContext';
import { ToastProvider } from './components/ui/Toast';
import CorporateDashboard from './pages/designs/CorporateDashboard';
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
                    <Router>
                        <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
                            <Routes>
                                {/* Public Route */}
                                <Route path="/login" element={<Login />} />

                                {/* Protected Route - Corporate Enterprise V1 */}
                                <Route path="/" element={
                                    <ProtectedRoute>
                                        <CorporateDashboard />
                                    </ProtectedRoute>
                                } />

                                {/* Protected Route - Corporate Enterprise V2 */}
                                <Route path="/v2/*" element={
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
