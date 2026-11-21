// External network is denied. Integration tests can use loopback HTTP and temporary Unix sockets.
// Tests may replace fetch with their mocks.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, sep } from 'node:path';
const blocked = () => { throw new Error('External network access is disabled for DSH-bot unit tests; provide a mock.'); };
const local = host => host === '127.0.0.1' || host === '::1' || host === '[::1]';
const temp = realpathSync(tmpdir()) + sep;
const temporarySocket = path => {
  if (typeof path !== 'string' || !isAbsolute(path)) return false;
  try { return (realpathSync(dirname(path)) + sep).startsWith(temp); } catch { return false; }
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  let url;
  try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch { return blocked(); }
  if (!['http:', 'https:'].includes(url.protocol) || !local(url.hostname)) return blocked();
  return nativeFetch(input, { ...options, redirect: 'manual' });
};
for (const mod of [http, https]) for (const key of ['request', 'get']) {
  const original = mod[key];
  mod[key] = function (...args) {
    const arg = args[0];
    if (mod === http && temporarySocket(arg?.socketPath)) return original.apply(this, args);
    let host;
    try { host = typeof arg === 'string' || arg instanceof URL ? new URL(arg).hostname : arg?.hostname || arg?.host; } catch { return blocked(); }
    if (!local(host)) return blocked();
    return original.apply(this, args);
  };
}
for (const [mod, keys] of [[net, ['connect', 'createConnection']], [tls, ['connect']]]) for (const key of keys) {
  const original = mod[key];
  mod[key] = function (...args) {
    const arg = args[0];
    // Node selects an AF_UNIX pipe whenever options.path is set, even with HTTP agent host/port defaults.
    if (mod === net && temporarySocket(arg?.path)) return original.apply(this, args);
    const host = typeof arg === 'object' ? arg?.host : args[1];
    if (!local(host)) return blocked();
    return original.apply(this, args);
  };
}
