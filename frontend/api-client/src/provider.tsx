'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { ApiError, AuthRequiredError, type ApiClient } from './client';

const ApiContext = React.createContext<ApiClient | null>(null);

/**
 * One QueryClient per app, with retry rules that know the error envelope: a 4xx is the
 * client's fault and is never retried, a network failure or 5xx gets two more tries with
 * backoff. `staleTime` 30 s stops every navigation from refetching the workspace.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof AuthRequiredError) return false;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: { retry: false },
    },
  });
}

export function ApiProvider({ client, queryClient, children }: { client: ApiClient; queryClient: QueryClient; children: React.ReactNode }) {
  return (
    <ApiContext.Provider value={client}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ApiContext.Provider>
  );
}

export function useApi(): ApiClient {
  const api = React.useContext(ApiContext);
  if (!api) throw new Error('useApi() must be used inside <ApiProvider>');
  return api;
}
