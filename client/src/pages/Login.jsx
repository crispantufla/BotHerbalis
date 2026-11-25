import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

const Login = () => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const { login } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        const success = await login(username, password);
        if (success) {
            navigate('/');
        }
        setLoading(false);
    };

    return (
        <div className="min-h-app flex items-center justify-center bg-accent-600 dark:bg-slate-900 p-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-8 animate-fade-in border border-white/20 dark:border-slate-700">
                <div className="text-center mb-8">
                    <div className="w-16 h-16 bg-gradient-to-tr from-blue-600 to-accent-600 rounded-xl mx-auto flex items-center justify-center mb-4 shadow-lg shadow-accent-500/30" aria-hidden="true">
                        <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    </div>
                    <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">Herbalis Bot</h1>
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Panel de Control & Dashboard</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-6">
                    <div>
                        <label htmlFor="login-username" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">Usuario</label>
                        <div className="relative">
                            <span className="absolute left-3 top-3 text-slate-400 dark:text-slate-500 pointer-events-none" aria-hidden="true">
                                <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                            </span>
                            <input
                                id="login-username"
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="w-full pl-10 pr-4 py-2.5 text-base bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-accent-500 focus:border-accent-500 transition-colors outline-none text-slate-700 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                                placeholder="tu usuario"
                                required
                                autoComplete="username"
                            />
                        </div>
                    </div>

                    <div>
                        <label htmlFor="login-password" className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">Contraseña</label>
                        <div className="relative">
                            <span className="absolute left-3 top-3 text-slate-400 dark:text-slate-500 pointer-events-none" aria-hidden="true">
                                <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                            </span>
                            <input
                                id="login-password"
                                type={showPassword ? 'text' : 'password'}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full pl-10 pr-12 py-2.5 text-base bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-accent-500 focus:border-accent-500 transition-colors outline-none text-slate-700 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
                                placeholder="••••••••"
                                required
                                autoComplete="current-password"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(v => !v)}
                                className="absolute right-0.5 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 transition-colors"
                                aria-label="Mostrar contraseña"
                                aria-pressed={showPassword}
                            >
                                {showPassword ? (
                                    <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                                ) : (
                                    <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                )}
                            </button>
                        </div>
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-gradient-to-r from-blue-600 to-accent-600 text-white font-bold py-3 rounded-lg shadow-lg hover:shadow-xl hover:translate-y-[-1px] transition-[box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent-500 dark:focus-visible:ring-offset-slate-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {loading ? (
                            <>
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                                Ingresando...
                            </>
                        ) : (
                            <>Ingresar al Panel</>
                        )}
                    </button>
                </form>

                <div className="mt-8 text-center">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        &copy; 2025 Herbalis. Acceso restringido.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default Login;
