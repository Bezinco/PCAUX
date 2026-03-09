import { useQuery } from '@tanstack/react-query';
import api from '../api/client';

export function useQualityKings(tier?: string) {
  return useQuery({
    queryKey: ['quality-kings', tier],
    queryFn: () => api.get('/quality-kings', { params: { tier } }).then(r => r.data),
    staleTime: 300000 // 5 minutes
  });
}

export function useJewelerProfile(jewelerId: string) {
  return useQuery({
    queryKey: ['jeweler', jewelerId],
    queryFn: () => api.get(`/quality-kings/${jewelerId}`).then(r => r.data),
    enabled: !!jewelerId
  });
}

export function useMyQualityKing() {
  return useQuery({
    queryKey: ['my-quality-king'],
    queryFn: () => api.get('/jeweler/my-quality-king').then(r => r.data),
    enabled: () => !!localStorage.getItem('token')
  });
}
