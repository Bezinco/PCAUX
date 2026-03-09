import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tradingApi, Order } from '../api/trading';
import { toast } from 'react-hot-toast';

export function usePlaceOrder(diamondId: string) {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (order: { side: string; price: number; quantity: number; order_type?: string }) =>
      tradingApi.placeOrder(diamondId, order).then(r => r.data),
    onSuccess: () => {
      toast.success('Order placed');
      queryClient.invalidateQueries(['orderbook', diamondId]);
      queryClient.invalidateQueries(['my-orders']);
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || 'Order failed');
    }
  });
}

export function useCancelOrder() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (orderId: string) => tradingApi.cancelOrder(orderId).then(r => r.data),
    onSuccess: () => {
      toast.success('Order cancelled');
      queryClient.invalidateQueries(['my-orders']);
    }
  });
}

export function useMyOrders() {
  return useQuery({
    queryKey: ['my-orders'],
    queryFn: () => tradingApi.getMyOrders().then(r => r.data),
    refetchInterval: 10000
  });
}

export function useBuyPCUs(ipoId: string) {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (quantity: number) => tradingApi.buyPCUs(ipoId, quantity).then(r => r.data),
    onSuccess: () => {
      toast.success('PCUs purchased');
      queryClient.invalidateQueries(['ipo', ipoId]);
      queryClient.invalidateQueries(['my-holdings']);
    }
  });
}
