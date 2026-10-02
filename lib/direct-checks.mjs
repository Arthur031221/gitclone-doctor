import dns from 'node:dns/promises';
import tls from 'node:tls';

const DNS_TIMEOUT_MS = 3000;
const TLS_TIMEOUT_MS = 3500;

function withDeadline(promise, milliseconds, expire, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      expire();
      finish(reject, Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));
    };
    const timer = setTimeout(() => {
      expire();
      finish(reject, Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }));
    }, milliseconds);
    promise.then(value => {
      finish(resolve, value);
    }, error => {
      finish(reject, error);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function runDirectChecks(host = 'github.com', options = {}) {
  const signal = options.signal;
  if (signal?.aborted) return { dns: { status: 'cancelled', route: 'direct' }, tls: { status: 'not_run', route: 'direct' } };
  const resolver = new dns.Resolver();
  let addresses;
  let dnsStatus = 'failed';
  try {
    const records = await withDeadline(resolver.resolve4(host), DNS_TIMEOUT_MS, () => resolver.cancel(), signal);
    addresses = records;
    dnsStatus = addresses.length > 0 ? 'passed' : 'failed';
  } catch (error) {
    dnsStatus = error?.code === 'ABORT_ERR' ? 'cancelled' : error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed';
  }

  if (dnsStatus === 'cancelled') return { dns: { status: dnsStatus, route: 'direct' }, tls: { status: 'not_run', route: 'direct' } };

  if (!addresses?.length) {
    return {
      dns: { status: dnsStatus, route: 'direct' },
      tls: { status: 'not_run', route: 'direct' },
    };
  }

  let tlsStatus = 'failed';
  const deadline = Date.now() + TLS_TIMEOUT_MS;
  for (const address of addresses) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      tlsStatus = 'timeout';
      break;
    }
    try {
      await connectVerified(address, host, remaining, signal);
      tlsStatus = 'passed';
      break;
    } catch (error) {
      if (error?.code === 'ETIMEDOUT') tlsStatus = 'timeout';
      else if (/CERT|TLS_CERT/.test(error?.code ?? '')) {
        tlsStatus = 'certificate_error';
      } else if (tlsStatus !== 'certificate_error') {
        tlsStatus = 'failed';
      }
    }
  }

  return {
    dns: { status: dnsStatus, route: 'direct' },
    tls: { status: tlsStatus, route: 'direct', certificateVerification: tlsStatus === 'passed' },
  };
}

function connectVerified(address, servername, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect({
      host: address,
      port: 443,
      servername,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => finish(Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' })), timeoutMs);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    socket.once('secureConnect', () => {
      if (socket.authorized) finish();
      else finish(Object.assign(new Error('verification'), { code: socket.authorizationError || 'CERTIFICATE_VERIFY_FAILED' }));
    });
    socket.once('error', finish);
  });
}
