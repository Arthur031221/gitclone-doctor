import { runBounded } from './process.mjs';
import { assertNoNetrc, buildProbeEnvironment } from './config.mjs';
import { DoctorError } from './errors.mjs';

function normalizeProtocol(token) {
  if (token === '2' || token === '2.0') return 'HTTP/2';
  return `HTTP/${token}`;
}

export function parseTraceHeaders(stderr) {
  const originStatuses = [];
  const proxyConnectStatuses = [];
  const responseProtocols = [];
  const proxyConnectProtocols = [];
  let inConnect = false;

  for (const line of stderr.toString('utf8').split(/\r?\n/)) {
    if (/=> Send header:\s+CONNECT\s/i.test(line)) inConnect = true;
    const match = line.match(/<= Recv header:\s+HTTP\/(2(?:\.0)?|1\.[01])\s+(\d{3})(?:\s|$)/);
    if (!match) continue;

    const protocol = normalizeProtocol(match[1]);
    const status = Number(match[2]);
    if (inConnect) {
      proxyConnectProtocols.push(protocol);
      proxyConnectStatuses.push(status);
      if (status >= 200 && status < 300) inConnect = false;
    } else {
      responseProtocols.push(protocol);
      originStatuses.push(status);
    }
  }

  return {
    responseProtocols: [...new Set(responseProtocols)],
    proxyConnectProtocols: [...new Set(proxyConnectProtocols)],
    originStatuses,
    proxyConnectStatuses,
  };
}

function outcomeFor(result, trace) {
  if (result.cleanupFailed || result.status === 'cleanup_failed') return 'cleanup_failed';
  if (result.status === 'timeout') return 'timeout';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'output_limit') return 'output_limit';
  if (result.status === 'spawn_error') return 'git_unavailable';
  if (trace.proxyConnectStatuses.includes(407) || trace.originStatuses.includes(407)) return 'proxy_auth_required';
  if (trace.originStatuses.some(status => status >= 300 && status < 400)) return 'redirect_refused';

  const stderr = result.stderr.toString('utf8');
  if (/certificate verify failed|certificate verification failed|SSL certificate problem|unable to get local issuer|peer certificate/i.test(stderr)) {
    return 'certificate_error';
  }
  if (result.code === 0) return 'passed';
  if (trace.originStatuses.some(status => status >= 400)) return 'http_error';
  if (/Could not resolve|couldn't resolve|Failed to connect|Connection refused|Network is unreachable|Could not resolve proxy|Couldn't connect/i.test(stderr)) {
    return 'transport_error';
  }
  return 'git_error';
}

export async function runGitProbe(options) {
  await assertNoNetrc(options.parentEnv ?? process.env);
  const env = buildProbeEnvironment(options.snapshot, {
    parentEnv: options.parentEnv,
    neutralCwd: options.neutralCwd,
    forceHttp1: options.forceHttp1,
    protocolVersion: options.protocolVersion,
  });

  const result = await runBounded('git', ['ls-remote', options.url, 'HEAD'], {
    cwd: options.neutralCwd,
    env,
    timeoutMs: options.timeoutMs ?? 12000,
    maxStdoutBytes: 8192,
    maxStderrBytes: 65536,
    signal: options.signal,
  });
  if (result.cleanupFailed || result.status === 'cleanup_failed') throw new DoctorError('cleanup_failed');
  if (result.status === 'cancelled') throw new DoctorError('cancelled');
  const trace = parseTraceHeaders(result.stderr);
  const outcome = outcomeFor(result, trace);

  return Object.freeze({
    ok: outcome === 'passed',
    outcome,
    requestedHttpVersion: options.forceHttp1 ? 'HTTP/1.1' : options.snapshot.httpVersion,
    responseProtocols: trace.responseProtocols,
    proxyConnectProtocols: trace.proxyConnectProtocols,
    originStatuses: trace.originStatuses,
    proxyConnectStatuses: trace.proxyConnectStatuses,
  });
}
