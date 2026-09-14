import React from 'react';
import { Button, Input, Select, Modal, useToast } from '../../ui';
import { buildConfirmMessage } from './scriptTemplates';

const EMPTY = { product: '', plan: '60', total: '' };

// Modal para completar producto, plan y total cuando la charla no los tiene y se
// quiere insertar una confirmación de pedido. `state` es { template, data } o null.
export default function ConfirmFillModal({ state, prices, onChange, onClose, onInsert }) {
    const { toast } = useToast();
    const template = state?.template || '';
    const data = state?.data || EMPTY;

    return (
        <Modal
            open={!!state}
            onClose={onClose}
            title="Completar confirmación"
            subtitle="No se detectó toda la info del pedido en la conversación"
            size="lg"
        >
            <Modal.Body>
                <div className="space-y-4">
                    <Select
                        label="Producto"
                        value={data.product}
                        onChange={e => onChange({ product: e.target.value })}
                    >
                        <option value="">— Elegir producto —</option>
                        <option value="Cápsulas de Nuez de la India">Cápsulas de Nuez de la India</option>
                        <option value="Semillas de Nuez de la India">Semillas de Nuez de la India</option>
                        <option value="Gotas de Nuez de la India">Gotas de Nuez de la India</option>
                    </Select>
                    <Select
                        label="Plan"
                        value={data.plan}
                        onChange={e => onChange({ plan: e.target.value })}
                    >
                        <option value="60">60 días</option>
                        <option value="120">120 días</option>
                    </Select>
                    <Input
                        label="Total a pagar"
                        type="text"
                        value={data.total}
                        onChange={e => onChange({ total: e.target.value })}
                        placeholder="0"
                        leftIcon={() => <span className="text-slate-400 font-medium">$</span>}
                    />

                    {(data.product || data.total) && (
                        <div>
                            <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Vista previa</p>
                            <pre className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-control p-3 text-[11px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed max-h-44 overflow-y-auto font-sans">
                                {buildConfirmMessage(template, data, prices)}
                            </pre>
                        </div>
                    )}
                </div>
            </Modal.Body>

            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>
                    Cancelar
                </Button>
                <Button
                    onClick={() => {
                        if (!data.product) { toast.warning('Elegí el producto'); return; }
                        if (!data.total) { toast.warning('Ingresá el total'); return; }
                        onInsert(buildConfirmMessage(template, data, prices));
                    }}
                >
                    Insertar mensaje
                </Button>
            </Modal.Footer>
        </Modal>
    );
}
