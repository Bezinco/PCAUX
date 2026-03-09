// types/index.ts
// Central type definitions for the PCAux frontend

export interface ApiResponse<T> {
  data: T;
  error?: string;
  requestId?: string;
}

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

export interface Order {
  id: string;
  diamond_id: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  filled_quantity: number;
  status: 'open' | 'partial' | 'filled' | 'cancelled';
}

export const OrderSide = {
  BUY: 'buy',
  SELL: 'sell'
} as const;

export type OrderSide = typeof OrderSide[keyof typeof OrderSide];

export const isDiamond = (obj: any): obj is Diamond => {
  return obj && typeof obj.id === 'string' && typeof obj.estimated_carat === 'number';
};
