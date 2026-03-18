import React, { useState, useCallback, useEffect } from 'react';
import {
    ReactFlow,
    MiniMap,
    Controls,
    Background,
    useNodesState,
    useEdgesState,
    addEdge,
    MarkerType
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const ScriptMapView = ({ script, onUpdate }) => {
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);
    const [selectedNode, setSelectedNode] = useState(null);

    // Transform knowledge.json into nodes and edges
    useEffect(() => {
        if (!script || !script.flow) return;

        const flowEntries = Object.entries(script.flow);

        // 1. CREATE NODES
        const initialNodes = flowEntries.map(([key, value], index) => {
            const savedPos = script.metadata?.positions?.[key];
            // Hierarchical layout: Each "step" (phase) gets a row
            const stepOrder = ['greeting', 'waiting_weight', 'waiting_preference', 'waiting_price_confirmation', 'waiting_plan_choice', 'waiting_ok', 'waiting_data', 'completed'];
            const stepIndex = stepOrder.indexOf(value.step || '');
            const row = stepIndex !== -1 ? stepIndex : Math.floor(index / 3);
            const col = flowEntries.filter(([_, v]) => v.step === value.step).findIndex(([k]) => k === key);

            const position = savedPos || { x: 300 * col + 100, y: 150 * row + 50 };

            return {
                id: key,
                data: { label: key, ...value },
                position,
                style: {
                    background: '#fff',
                    color: '#333',
                    border: '1px solid #ddd',
                    borderRadius: '8px',
                    padding: '10px',
                    width: 200,
                    fontSize: '12px',
                    fontWeight: 'bold',
                    textAlign: 'center',
                    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'
                },
            };
        });

        // Add a terminal "Completed" node if needed
        const hasCompleted = flowEntries.some(([_, v]) => v.nextStep === 'completed');
        if (hasCompleted) {
            const savedPos = script.metadata?.positions?.['completed_node'];
            initialNodes.push({
                id: 'completed_node',
                data: { label: '🏁 FINALIZADO', response: 'Fin del flujo.' },
                position: savedPos || { x: 300, y: 150 * 8 },
                style: { background: '#f0fdf4', color: '#166534', border: '2px solid #bbf7d0', borderRadius: '8px', padding: '10px', width: 200, fontWeight: 'bold', textAlign: 'center' }
            });
        }

        // 2. CREATE EDGES (Logic fixed: match nextStep with target.step OR target node key)
        const initialEdges = [];
        flowEntries.forEach(([key, value]) => {
            if (value.nextStep) {
                if (value.nextStep === 'completed') {
                    initialEdges.push({
                        id: `e-${key}-completed`,
                        source: key,
                        target: 'completed_node',
                        animated: true,
                        markerEnd: { type: MarkerType.ArrowClosed, color: '#22c55e' },
                        style: { stroke: '#22c55e', strokeWidth: 2 }
                    });
                } else {
                    // Find nodes whose .step matches our .nextStep OR whose name matches our .nextStep
                    const targets = flowEntries.filter(([tKey, tVal]) =>
                        tVal.step === value.nextStep || tKey === value.nextStep
                    );

                    targets.forEach(([targetKey]) => {
                        initialEdges.push({
                            id: `e-${key}-${targetKey}`,
                            source: key,
                            target: targetKey,
                            animated: true,
                            markerEnd: { type: MarkerType.ArrowClosed, color: '#3b82f6' },
                            style: { stroke: '#3b82f6', strokeWidth: 2 },
                        });
                    });
                }
            }
        });

        setNodes(initialNodes);
        setEdges(initialEdges);
    }, [script]);

    const onConnect = useCallback(
        (params) => {
            const newEdges = addEdge(params, edges);
            setEdges(newEdges);

            // Update the script logic: change nextStep of the source node
            const updatedFlow = { ...script.flow };
            if (updatedFlow[params.source]) {
                updatedFlow[params.source].nextStep = params.target;
                onUpdate({ ...script, flow: updatedFlow });
            }
        },
        [edges, script, onUpdate]
    );

    const onNodeDragStop = useCallback(
        (_, node) => {
            const updatedMetadata = {
                ...script.metadata,
                positions: {
                    ...(script.metadata?.positions || {}),
                    [node.id]: node.position
                }
            };
            onUpdate({ ...script, metadata: updatedMetadata });
        },
        [script, onUpdate]
    );

    const onNodeClick = (_, node) => {
        setSelectedNode(node);
    };

    const handleNodeUpdate = (field, value) => {
        if (!selectedNode) return;
        const updatedFlow = { ...script.flow };
        updatedFlow[selectedNode.id][field] = value;
        onUpdate({ ...script, flow: updatedFlow });

        // Update local state to reflect change in sidebar/modal
        setSelectedNode(prev => ({
            ...prev,
            data: { ...prev.data, [field]: value }
        }));
    };

    return (
        <div className="flex h-[600px] bg-white rounded-lg overflow-hidden border">
            <div className="flex-1 relative">
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    onNodeClick={onNodeClick}
                    onNodeDragStop={onNodeDragStop}
                    fitView
                >
                    <Background color="#f8fafc" variant="dots" />
                    <Controls />
                    <MiniMap zoomable pannable intensity={0.1} />
                </ReactFlow>
            </div>

            {/* QUICK EDITOR SIDEBAR */}
            {selectedNode && (
                <div className="w-80 border-l p-4 bg-gray-50 flex flex-col gap-4 overflow-y-auto">
                    <div className="flex justify-between items-center">
                        <h3 className="font-bold text-gray-700 capitalize">{selectedNode.id.replace(/_/g, ' ')}</h3>
                        <button onClick={() => setSelectedNode(null)} className="text-gray-400">✕</button>
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Respuesta del Bot</label>
                        <textarea
                            className="w-full p-2 text-sm border rounded bg-white h-40 focus:ring-2 focus:ring-blue-500 outline-none"
                            value={selectedNode.data.response || ''}
                            onChange={(e) => handleNodeUpdate('response', e.target.value)}
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Siguiente Paso (ID)</label>
                        <input
                            type="text"
                            className="w-full p-2 text-sm border rounded bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                            value={selectedNode.data.nextStep || ''}
                            onChange={(e) => handleNodeUpdate('nextStep', e.target.value)}
                        />
                        <p className="text-[10px] text-gray-400 mt-1">Conectar nodos en el mapa actualiza esto automáticamente.</p>
                    </div>

                    {selectedNode.data.match && (
                        <div>
                            <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Keywords (coma)</label>
                            <input
                                type="text"
                                className="w-full p-2 text-sm border rounded bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                                value={(selectedNode.data.match || []).join(', ')}
                                onChange={(e) => handleNodeUpdate('match', e.target.value.split(',').map(s => s.trim()))}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ScriptMapView;
