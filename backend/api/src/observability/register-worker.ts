// First import of src/worker.ts — see observability.ts for why it must come before Nest.
import { startObservability } from './observability';

startObservability('worker');
