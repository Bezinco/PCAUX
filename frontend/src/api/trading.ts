import api from './client';

export interface Order {
  id: string;
  diamond_id: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  filled_quantity: number;
  status: 'open' | 'partial' | 'filled' | 'cancelled';
}

export const tradingApi = {
  placeOrder: (diamondId: string, order: {
    side: string;
    price: number;
    quantity: number;
    order_type?: string;
  }) => api.post(`/diamonds/${diamondId}/orders`, order),
  
  cancelOrder: (orderId: string) => 
    api.post(`/orders/${orderId}/cancel`),
  
  getMyOrders: () => 
    api.get('/my/orders'),
  
  getMyTrades: () => 
    api.get('/my/trades'),
  
  getIPO: (diamondId: string) => 
    api.get(`/diamonds/${diamondId}/ipo`),
  
  buyPCUs: (diamondId: string, quantity: number) => 
    api.post(`/ipos/${diamondId}/buy`, { quantity })
};

export default tradingApi;
