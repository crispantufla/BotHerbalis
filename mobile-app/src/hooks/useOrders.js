import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../config/axios';
import { useSocket } from '../context/SocketContext';
import { useEffect } from 'react';

export const useOrders = (page = 1, limit = 50) => {
    const queryClient = useQueryClient();
    const { socket } = useSocket();

    // Fetch Orders
    const query = useQuery({
        queryKey: ['orders', page, limit],
        queryFn: async () => {
            const res = await api.get(`/api/orders?page=${page}&limit=${limit}`);
            if (res.data.data) {
                return {
                    orders: res.data.data,
                    pagination: res.data.pagination
                };
            }
            // Fallback legacy structure
            return {
                orders: res.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
                pagination: { page: 1, totalPages: 1, total: res.data.length }
            };
        },
        keepPreviousData: true,
        staleTime: 60000 // Cache for 1 minute before refetching in background
    });

    // Realtime invalidate via Sockets
    useEffect(() => {
        if (!socket) return;
        const invalidate = () => queryClient.invalidateQueries(['orders']);
        socket.on('new_order', invalidate);
        socket.on('order_update', invalidate);
        socket.on('alerts_updated', invalidate);
        return () => {
            socket.off('new_order', invalidate);
            socket.off('order_update', invalidate);
            socket.off('alerts_updated', invalidate);
        };
    }, [socket, queryClient]);

    // Mutate: Edit Details
    const updateDetailsMutation = useMutation({
        mutationFn: async ({ id, data }) => {
            const res = await api.put(`/api/orders/${id}`, data);
            return res.data;
        },
        onSuccess: () => queryClient.invalidateQueries(['orders'])
    });

    // Mutate: Change Status
    const updateStatusMutation = useMutation({
        mutationFn: async ({ id, status, tracking }) => {
            const res = await api.post(`/api/orders/${id}/status`, { status, tracking });
            return res.data;
        },
        onSuccess: () => queryClient.invalidateQueries(['orders'])
    });

    // Mutate: Delete Order
    const deleteOrderMutation = useMutation({
        mutationFn: async (id) => {
            await api.delete(`/api/orders/${id}`);
        },
        onSuccess: () => queryClient.invalidateQueries(['orders'])
    });

    return {
        ...query,
        orders: query.data?.orders || [],
        pagination: query.data?.pagination || { page, totalPages: 1, total: 0 },
        updateDetails: updateDetailsMutation.mutateAsync,
        updateStatus: updateStatusMutation.mutateAsync,
        deleteOrder: deleteOrderMutation.mutateAsync,
        isMutating: updateDetailsMutation.isPending || updateStatusMutation.isPending || deleteOrderMutation.isPending
    };
};
