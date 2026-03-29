import React from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';

const Layout = () => {
    const location = useLocation();

    const navItems = [
        { path: '/', label: 'Dashboard', icon: '📊' },
        { path: '/chats', label: 'Chats', icon: '💬' },
        { path: '/ventas', label: 'Ventas', icon: '💰' },
        { path: '/script', label: 'Editor Guión', icon: '📝' },
        { path: '/settings', label: 'Configuración', icon: '⚙️' },
    ];

    return (
        <div className="flex h-screen bg-gray-100">
            {/* Sidebar */}
            <aside className="w-64 bg-white shadow-md">
                <div className="p-4 border-b">
                    <h1 className="text-xl font-bold text-green-600">Bot Whatsapp</h1>
                </div>
                <nav className="p-4 space-y-2">
                    {navItems.map((item) => (
                        <Link
                            key={item.path}
                            to={item.path}
                            className={`flex items-center p-3 rounded-lg transition-colors ${location.pathname === item.path
                                ? 'bg-green-100 text-green-700 font-medium'
                                : 'text-gray-600 hover:bg-gray-50'
                                }`}
                        >
                            <span className="mr-3">{item.icon}</span>
                            {item.label}
                        </Link>
                    ))}
                </nav>
            </aside>

            {/* Main Content */}
            <main className="flex-1 overflow-auto p-8">
                <Outlet />
            </main>
        </div>
    );
};

export default Layout;
