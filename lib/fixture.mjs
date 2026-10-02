import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runBounded } from './process.mjs';
import { DoctorError } from './errors.mjs';
import { runGitProbe } from './probe.mjs';
import { readGitVersion } from './config.mjs';
import { buildReport } from './report.mjs';

function pktLine(payload) {
  const length = Buffer.byteLength(payload) + 4;
  return `${length.toString(16).padStart(4, '0')}${payload}`;
}

function advertisement() {
  const objectId = '0123456789abcdef0123456789abcdef01234567';
  const head = `${objectId} HEAD\0symref=HEAD:refs/heads/main\n`;
  const main = `${objectId} refs/heads/main\n`;
  return Buffer.from(`${pktLine('# service=git-upload-pack\n')}0000${pktLine(head)}${pktLine(main)}0000`);
}

async function generateCertificate(directory, signal) {
  const keyPath = path.join(directory, 'fixture.key');
  const certPath = path.join(directory, 'fixture.crt');
  const configPath = path.join(directory, 'fixture.cnf');
  const config = [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3_req',
    'prompt = no',
    '[dn]',
    'CN = 127.0.0.1',
    '[v3_req]',
    'basicConstraints = critical,CA:TRUE',
    'keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign',
    'subjectAltName = @alt_names',
    '[alt_names]',
    'IP.1 = 127.0.0.1',
    'DNS.1 = localhost',
    '',
  ].join('\n');
  await fs.writeFile(configPath, config, { mode: 0o600 });
  const result = await runBounded('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-batch',
    '-keyout', keyPath,
    '-out', certPath,
    '-config', configPath,
  ], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeoutMs: 20000,
    maxStdoutBytes: 2048,
    maxStderrBytes: 4096,
    signal,
  });

  if (result.status === 'spawn_error') throw new DoctorError('openssl_unavailable');
  if (result.status === 'cancelled') throw new DoctorError('cancelled');
  if (result.cleanupFailed || result.status === 'cleanup_failed') throw new DoctorError('cleanup_failed');
  if (result.status !== 'exited' || result.code !== 0) throw new DoctorError('demo_fixture_failed');
  return { key: await fs.readFile(keyPath), cert: await fs.readFile(certPath), certPath };
}

async function startFixtureServer(credentials) {
  const server = http2.createSecureServer({
    key: credentials.key,
    cert: credentials.cert,
    allowHTTP1: true,
  });
  const requests = [];
  const sessions = new Set();
  const sockets = new Set();
  const body = advertisement();

  server.on('session', session => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('request', (request, response) => {
    const protocol = request.httpVersionMajor === 2 ? 'HTTP/2' : 'HTTP/1.1';
    const requestPath = (request.url ?? '').split('?')[0];
    requests.push({ protocol, path: requestPath, method: request.method });

    if (requestPath === '/target/repo.git/info/refs' && protocol === 'HTTP/2') {
      response.writeHead(403, { 'content-type': 'text/plain', 'content-length': '0' });
      response.end();
      return;
    }

    if ((requestPath === '/target/repo.git/info/refs' || requestPath === '/control/repo.git/info/refs') && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'content-length': String(body.length),
      });
      response.end(body);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain', 'content-length': '0' });
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new DoctorError('demo_fixture_failed');

  return {
    port: address.port,
    requests,
    async close() {
      const closedEvent = new Promise(resolve => server.close(error => resolve(!error)));
      for (const session of sessions) session.destroy();
      for (const socket of sockets) socket.destroy();
      let closed = await waitForClose(closedEvent, 1000);
      if (!closed) {
        server.closeAllConnections?.();
        for (const session of sessions) session.destroy();
        for (const socket of sockets) socket.destroy();
        closed = await waitForClose(closedEvent, 500);
      }
      if (!closed) throw new DoctorError('cleanup_failed');
    },
  };
}

function waitForClose(closedEvent, milliseconds) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish(false), milliseconds);
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    closedEvent.then(finish);
  });
}

function includesStatus(probe, status) {
  return probe.originStatuses.includes(status);
}

function verifyFixture(probes, requests) {
  const hasRequest = (pathname, protocol) => requests.some(request => request.path === pathname && request.protocol === protocol);
  const h2Observed = probes.targetSelected.responseProtocols.includes('HTTP/2')
    && probes.controlSelected.responseProtocols.includes('HTTP/2')
    && hasRequest('/target/repo.git/info/refs', 'HTTP/2')
    && hasRequest('/control/repo.git/info/refs', 'HTTP/2');
  if (!h2Observed) throw new DoctorError('fixture_h2_unavailable');

  const expected = !probes.targetSelected.ok
    && includesStatus(probes.targetSelected, 403)
    && probes.targetHttp1.ok
    && probes.targetHttp1.responseProtocols.includes('HTTP/1.1')
    && probes.controlSelected.ok
    && probes.controlSelected.responseProtocols.includes('HTTP/2')
    && probes.controlHttp1.ok
    && probes.controlHttp1.responseProtocols.includes('HTTP/1.1')
    && hasRequest('/target/repo.git/info/refs', 'HTTP/1.1')
    && hasRequest('/control/repo.git/info/refs', 'HTTP/1.1');
  if (!expected) throw new DoctorError('fixture_protocol_mismatch');
}

export async function runLocalFixture(options = {}) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new DoctorError('platform_unsupported');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new DoctorError('unsupported_node_version');

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitclone-doctor-demo-'));
  let server;
  try {
    const credentials = await generateCertificate(directory, options.signal);
    server = await startFixtureServer(credentials);

    const snapshot = Object.freeze({
      httpVersion: 'HTTP/2',
      proxy: { source: 'none', configured: false, enabled: false, endpoint: null, url: '' },
      noProxyPresent: false,
      noProxyValue: undefined,
      caInfoPath: credentials.certPath,
      caPathPath: undefined,
      sslBackend: undefined,
      proxyCaInfoPath: undefined,
      settingsPresence: {
        originCaFile: true,
        originCaDirectory: false,
        tlsBackend: false,
        proxyCaFile: false,
        credentialHelper: false,
        extraHeader: false,
        urlRewrite: false,
      },
    });
    const neutralCwd = directory;
    const targetUrl = `https://127.0.0.1:${server.port}/target/repo.git`;
    const controlUrl = `https://127.0.0.1:${server.port}/control/repo.git`;
    const gitVersion = await readGitVersion({ signal: options.signal, cwd: neutralCwd });

    const targetSelected = await runGitProbe({
      snapshot, url: targetUrl, neutralCwd, signal: options.signal, protocolVersion: 0,
    });
    const targetHttp1 = await runGitProbe({
      snapshot, url: targetUrl, neutralCwd, signal: options.signal, forceHttp1: true, protocolVersion: 0,
    });
    const controlSelected = await runGitProbe({
      snapshot, url: controlUrl, neutralCwd, signal: options.signal, protocolVersion: 0,
    });
    const controlHttp1 = await runGitProbe({
      snapshot, url: controlUrl, neutralCwd, signal: options.signal, forceHttp1: true, protocolVersion: 0,
    });

    verifyFixture({ targetSelected, targetHttp1, controlSelected, controlHttp1 }, server.requests);
    const report = buildReport({
      targetName: 'fixture/target',
      snapshot,
      probes: { targetSelected, targetHttp1, controlSelected, controlHttp1 },
      gitVersion,
      nodeVersion: process.versions.node,
      fixture: true,
    });

    return { report, verified: true };
  } finally {
    try {
      if (server) await server.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
