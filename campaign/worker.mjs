import { parentPort, workerData } from 'node:worker_threads';
import { runCampaign } from './runtime.mjs';

try {
  const result = await runCampaign(workerData, progress => parentPort.postMessage({ type: 'progress', progress }));
  parentPort.postMessage({ type: 'result', result });
} catch (error) {
  parentPort.postMessage({ type: 'failure', message: error.message, stack: error.stack });
}
// The parent terminates this worker, including all DB flush timers, after a terminal message.
