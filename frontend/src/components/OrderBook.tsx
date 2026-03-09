import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { diamondsApi } from '../api/diamonds';

interface PriceChartProps {
  diamondId: string;
  interval?: string;
}

export function PriceChart({ diamondId, interval = '1h' }: PriceChartProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['candles', diamondId, interval],
    queryFn: () => diamondsApi.getCandles(diamondId, interval).then(r => r.data.candles)
  });

  if (isLoading) return <div className="h-64 bg-gray-100 animate-pulse rounded" />;

  const chartData = data?.map(c => ({
    time: new Date(c.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    price: parseFloat(c.close),
    volume: parseInt(c.volume)
  })) || [];

  const isUp = chartData.length > 1 && chartData[chartData.length - 1].price >= chartData[0].price;

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={isUp ? "#10b981" : "#ef4444"} stopOpacity={0.3}/>
              <stop offset="95%" stopColor={isUp ? "#10b981" : "#ef4444"} stopOpacity={0}/>
            </linearGradient>
          </defs>
          <XAxis 
            dataKey="time" 
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10 }}
            minTickGap={30}
          />
          <YAxis 
            domain={['auto', 'auto']}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10 }}
            tickFormatter={(v) => `$${v.toFixed(0)}`}
            width={50}
          />
          <Tooltip 
            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
            formatter={(v: number) => [`$${v.toFixed(2)}`, 'Price']}
          />
          <Area 
            type="monotone" 
            dataKey="price" 
            stroke={isUp ? "#10b981" : "#ef4444"} 
            fillOpacity={1} 
            fill="url(#colorPrice)" 
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
