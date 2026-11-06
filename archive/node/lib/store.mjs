import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export function emptyState() {
  return {
    version: 2,
    merchants: [],
    credentials: [],
    sessions: [],
    payments: [],
    receipts: [],
    refunds: [],
    events: [],
    idempotency: [],
    audit: [],
  };
}
export async function createStore(path) {
  let data = emptyState();
  if (path) {
    try {
      data = JSON.parse(await readFile(path, 'utf8'));
      if (data.version !== 2) throw new Error('Unsupported data version.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  let tail = Promise.resolve();
  async function persist(next) {
    if (!path) return;
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  return {
    get data() {
      return data;
    },
    async change(action) {
      const task = tail.then(async () => {
        const next = structuredClone(data),
          result = await action(next);
        await persist(next);
        data = next;
        return result;
      });
      tail = task.catch(() => {});
      return task;
    },
    async drain() {
      await tail;
    },
  };
}
