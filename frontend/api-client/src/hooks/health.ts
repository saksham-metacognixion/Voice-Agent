import { healthResponse } from '@portal/schemas';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../client';

export function useHealth(api: ApiClient) {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.get('/health', healthResponse),
    staleTime: 30_000,
  });
}
