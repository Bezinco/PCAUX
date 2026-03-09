import api from './client';

export interface Diamond {
  id: string;
  jeweler_id: string;
  jeweler_name: string;
  jeweler_tier: string;
  estimated_carat: number;
  estimated_color: string;
  estimated_clarity: string;
  estimated_cut: string;
  final_carat?: number;
  final_color?: string;
  final_clarity?: string;
  final_cut?: string;
  shape: string;
  images: Record<string, string>;
  status: string;
  ipo_price?: number;
  total_pcus?: number;
  sold_pcus?: number;
  total_multiplier?: number;
}

export const diamondsApi = {
  list: (params?: { status?: string; jeweler_id?: string }) => 
    api.get('/diamonds', { params }),
  
  get: (id: string) => 
    api.get(`/diamonds/${id}`),
  
  getGrade: (id: string) => 
    api.get(`/diamonds/${id}/grade`),
  
  getOrderBook: (id: string) => 
    api.get(`/diamonds/${id}/orderbook`),
  
  getCandles: (id: string, interval = '1h') => 
    api.get(`/diamonds/${id}/candles`, { params: { interval }})
};

export default diamondsApi;
