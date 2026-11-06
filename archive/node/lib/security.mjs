import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  scrypt as scryptCallback,
} from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
const scrypt = promisify(scryptCallback);
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}
export function ensure(ok, status, code, message) {
  if (!ok) throw new ApiError(status, code, message);
}
export const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
export const token = (prefix) => prefix + randomBytes(28).toString('hex');
export function equal(a, b) {
  const x = Buffer.from(String(a || '')),
    y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
export const signature = (secret, timestamp, body) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
export const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
export async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
export async function passwordMatches(password, stored) {
  const salt = stored.split(':')[0];
  return equal(await passwordHash(password, salt), stored);
}
export function privateAddress(address) {
  let a = address.toLowerCase().split('%')[0];
  if (a.startsWith('::ffff:')) {
    const tail = a.slice(7);
    if (isIP(tail) === 4) return privateAddress(tail);
    const parts = tail.split(':');
    if (parts.length === 2) {
      const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
      return privateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    return true;
  }
  if (isIP(a) === 6)
    return (
      !/^[23][0-9a-f]{3}:/.test(a) ||
      a.startsWith('2001:db8:') ||
      a.startsWith('2002:') ||
      a.startsWith('2001:0:')
    );
  if (isIP(a) !== 4) return true;
  const [x, y] = a.split('.').map(Number);
  return (
    x === 0 ||
    x === 10 ||
    x === 127 ||
    x >= 224 ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && (y === 168 || y === 0 || y === 2)) ||
    (x === 100 && y >= 64 && y <= 127) ||
    (x === 198 && (y === 18 || y === 19 || y === 51)) ||
    (x === 203 && y === 0)
  );
}
export function validateDestination(value, { allowLocal = false, returnUrl = false } = {}) {
  if (!value) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new ApiError(422, 'INVALID_URL', 'Supply an absolute webhook/return URL.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  ensure(
    !u.username && !u.password && !u.hash && u.href.length <= 1000,
    422,
    'INVALID_URL',
    'URL credentials, fragments, or an oversized URL are not allowed.',
  );
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (local) {
    ensure(
      allowLocal && u.protocol === 'http:',
      422,
      'LOCAL_URL_DISABLED',
      'Local HTTP URLs are allowed only in local development mode.',
    );
    return u.href;
  }
  ensure(
    u.protocol === 'https:' && (!u.port || u.port === '443'),
    422,
    'HTTPS_REQUIRED',
    'Public destinations must use HTTPS on port 443.',
  );
  if (isIP(host))
    ensure(
      !privateAddress(host),
      422,
      'PRIVATE_DESTINATION',
      'Private and reserved network destinations are blocked.',
    );
  if (!returnUrl) ensure(host.includes('.'), 422, 'INVALID_HOST', 'Use a public hostname.');
  return u.href;
}
// Resolve every delivery and pin its validated address to the connection. Redirects are never followed.
export async function deliverHttp(
  destination,
  raw,
  headers,
  { allowLocal = false, timeout = 4000 } = {},
) {
  const u = new URL(validateDestination(destination, { allowLocal })),
    host = u.hostname.replace(/^\[|\]$/g, '');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  ensure(
    addresses.length && (local ? allowLocal : addresses.every((x) => !privateAddress(x.address))),
    422,
    'PRIVATE_DESTINATION',
    'Webhook DNS resolved to a blocked address.',
  );
  const chosen = addresses[0],
    transport = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      u,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(raw) },
        lookup: (hostname, options, cb) =>
          options.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family),
      },
      (res) => {
        let bytes = 0,
          chunks = [];
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes <= 4096) chunks.push(chunk);
          if (bytes > 65536) res.destroy(new Error('Webhook response too large'));
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 1000),
          }),
        );
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('Webhook delivery timed out')), timeout);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(raw);
  });
}
