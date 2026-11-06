// cPanel/Passenger loads app.js using require(); the gateway itself remains an ES module.
const { isAbsolute } = require('node:path');

async function start() {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  const dataFile = process.env.DATA_FILE;

  if (
    !publicBaseUrl ||
    !publicBaseUrl.startsWith('https://') ||
    new URL(publicBaseUrl).origin !== publicBaseUrl
  ) {
    throw new Error('Set PUBLIC_BASE_URL to the HTTPS gateway origin, without a path.');
  }
  if (!dataFile || !isAbsolute(dataFile)) {
    throw new Error(
      'Set DATA_FILE to an absolute, persistent path outside the public document root.',
    );
  }

  const { createGateway } = await import('../gateway.mjs');
  const gateway = await createGateway({ dataFile, publicBaseUrl, allowLocalWebhooks: false });
  // Passenger supplies the socket through reverse port binding. Never start the private LAN listener here.
  await gateway.listen(Number(process.env.PORT || 4179), '127.0.0.1');

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await gateway.close();
      process.exit(0);
    });
  }
  console.log(`Lumen Gateway ready at ${publicBaseUrl}`);
}

start().catch((error) => {
  console.error(`Gateway startup failed: ${error.message}`);
  process.exitCode = 1;
});
