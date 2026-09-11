import { z } from 'zod';

export const healthResponse = z.object({
  status: z.literal('ok'),
  service: z.enum(['api', 'worker']),
  env: z.string(),
  version: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponse>;
