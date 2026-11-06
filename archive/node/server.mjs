import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createGateway } from './gateway.mjs';
// Compatibility for the original local booking/payment lab and its regression suite.
export { createSimulator, signWebhook } from './legacy-server.mjs';
export { createGateway } from './gateway.mjs';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(fileURLToPath(import.meta.url));
  const app = await createGateway({
    dataFile: process.env.DATA_FILE || resolve(root, '.data/gateway.json'),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || undefined,
    allowLocalWebhooks: process.env.ALLOW_LOCAL_WEBHOOKS !== 'false',
    scanHost: process.env.SCAN_HOST || undefined,
    scanBaseUrl: process.env.SCAN_BASE_URL || undefined,
  });
  console.log(
    `Lumen Gateway Sandbox: ${await app.listen(Number(process.env.PORT || 4179), process.env.HOST || '127.0.0.1')}`,
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
