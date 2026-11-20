// First import of src/main.ts — see observability.ts for why it must come before Nest.
import { startObservability } from './observability';

startObservability('api');
