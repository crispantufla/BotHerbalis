import React, { useState, useEffect, useCallback } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import api from '../../config/axios';
import { Card, Button, Badge, useToast } from '../ui';

// Cuántas personas entraron por cada anuncio de Meta (y personas nuevas sin
// anuncio) y cuántas terminaron en pedido. GET /api/promo/ad-stats.

const RANGES = [[7, '7 días'], [30, '30 días'], [90, '90 días']];
const KIND_TONE = { video: 'purple', imagen: 'info', 'sin anuncio': 'neutral', '?': 'neutral' };
const fmtDay = (iso) => iso ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) : '—';

export default function AdStats() {
    const toast = useToast();
    const [days, setDays] = useState(30);
    const [ads, setAds] = useState([]);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await api.get('/api/promo/ad-stats', { params: { days } });
            setAds(r.data.ads || []);
        } catch (e) {
            toast.error('No pude cargar las estadísticas: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    }, [days, toast]);

    useEffect(() => { load(); }, [load]);

    const tot = ads.reduce((a, r) => ({ leads: a.leads + r.leads, today: a.today + r.today, orders: a.orders + r.orders }), { leads: 0, today: 0, orders: 0 });
    const max = Math.max(1, ...ads.map((r) => r.leads));

    return (
        <Card padding="md">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <BarChart3 className="w-5 h-5 text-accent-600 dark:text-accent-400" />
                    <div>
                        <h3 className="font-bold text-slate-900 dark:text-slate-100">Contactos por anuncio</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                            {tot.leads} contactos en {days} días · {tot.today} hoy · {tot.orders} con pedido
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-1.5">
                    {RANGES.map(([d, l]) => (
                        <button key={d} type="button" onClick={() => setDays(d)}
                            className={`text-xs px-2.5 py-1 rounded-full border ${days === d ? 'bg-accent-600 text-white border-accent-600' : 'border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300'}`}>
                            {l}
                        </button>
                    ))}
                    <Button size="sm" variant="secondary" leftIcon={RefreshCw} onClick={load} loading={loading}>Actualizar</Button>
                </div>
            </div>

            {ads.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">{loading ? 'Cargando…' : 'Todavía no hay contactos registrados en este período.'}</p>
            ) : (
                <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                                <th className="pb-2 pr-3 font-medium">Anuncio</th>
                                <th className="pb-2 pr-3 font-medium text-right">Contactos</th>
                                <th className="pb-2 pr-3 font-medium text-right">Hoy</th>
                                <th className="pb-2 pr-3 font-medium text-right">7 días</th>
                                <th className="pb-2 pr-3 font-medium text-right">Pedidos</th>
                                <th className="pb-2 font-medium text-right">Conversión</th>
                            </tr>
                        </thead>
                        <tbody>
                            {ads.map((r) => (
                                <tr key={r.sourceId} className="border-t border-slate-100 dark:border-slate-800">
                                    <td className="py-2 pr-3">
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium text-slate-800 dark:text-slate-200">{r.title}</span>
                                            <Badge tone={KIND_TONE[r.kind] || 'neutral'} size="sm">{r.kind}</Badge>
                                        </div>
                                        <div className="mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                                            <div className="h-full bg-accent-500" style={{ width: `${(r.leads / max) * 100}%` }} />
                                        </div>
                                        <div className="text-[11px] text-slate-400 mt-0.5">primer contacto {fmtDay(r.firstAt)} · último {fmtDay(r.lastAt)}</div>
                                    </td>
                                    <td className="py-2 pr-3 text-right font-semibold tabular-nums">{r.leads}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{r.today}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{r.last7}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{r.orders}</td>
                                    <td className="py-2 text-right tabular-nums">{r.conversion}%</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="mt-2 text-[11px] text-slate-400">
                        Cuenta personas (una vez por anuncio), incluidos los anuncios que el bot no atiende. "Sin anuncio" = personas nuevas para el número que escribieron sin pasar por un anuncio. Pedidos = los que el bot registró después del contacto.
                    </p>
                </div>
            )}
        </Card>
    );
}
