import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runBounded } from '../lib/process.mjs';
import { assertNoNetrc, buildProbeEnvironment, loadTransportSnapshot } from '../lib/config.mjs';
import { buildReport } from '../lib/report.mjs';

const targetUrl = 'https://github.com/octo/repo.git';

async function git(args, cwd, env) {
  const result = await runBounded('git', args, { cwd, env, timeoutMs: 3000, maxStdoutBytes: 8192, maxStderrBytes: 8192 });
  assert.equal(result.status, 'exited', 'git config command did not finish');
  assert.equal(result.code, 0, 'git config command failed');
}

async function makeConfigRepo() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gitclone-doctor-config-test-'));
  const cwd = path.join(base, 'repo');
  const home = path.join(base, 'home');
  await fs.mkdir(cwd);
  await fs.mkdir(home);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  await git(['init', '--quiet', cwd], base, env);
  return { base, cwd, home, env };
}

async function addConfig(context, key, value) {
  await git(['-C', context.cwd, 'config', '--local', '--add', key, value], context.base, context.env);
}

test('captures only a target-selected transport snapshot and reports config presence as booleans', async t => {
  const context = await makeConfigRepo();
  t.after(() => fs.rm(context.base, { recursive: true, force: true }));
  await addConfig(context, 'http.version', 'HTTP/2');
  await addConfig(context, 'http.proxy', 'http://proxy.example:3128');
  await addConfig(context, 'http.sslCAInfo', 'relative-certs/ca.pem');
  await addConfig(context, 'http.sslCAPath', 'relative-certs');
  await addConfig(context, 'http.proxySSLCAInfo', 'relative-certs/proxy.pem');
  await addConfig(context, 'http.sslBackend', 'openssl');
  await addConfig(context, 'credential.helper', 'store --file=helper-secret-path');
  await addConfig(context, 'http.extraHeader', 'Authorization: Bearer header-secret-value');
  await addConfig(context, 'url.https://mirror.invalid/repo.git.insteadOf', 'https://github.com/');

  const snapshot = await loadTransportSnapshot(targetUrl, { cwd: context.cwd, env: context.env });
  assert.equal(snapshot.httpVersion, 'HTTP/2');
  assert.equal(snapshot.proxy.source, 'git-config');
  assert.deepEqual(snapshot.proxy.endpoint, { scheme: 'http', host: 'proxy.example', port: '3128' });
  assert.equal(snapshot.caInfoPath, path.join(context.cwd, 'relative-certs/ca.pem'));
  assert.equal(snapshot.caPathPath, path.join(context.cwd, 'relative-certs'));
  assert.equal(snapshot.proxyCaInfoPath, path.join(context.cwd, 'relative-certs/proxy.pem'));
  assert.deepEqual(snapshot.settingsPresence, {
    originCaFile: true,
    originCaDirectory: true,
    tlsBackend: true,
    proxyCaFile: true,
    credentialHelper: true,
    extraHeader: true,
    urlRewrite: true,
  });

  const report = buildReport({
    targetName: 'octo/repo',
    snapshot,
    probes: {
      targetSelected: probe(true), targetHttp1: probe(true),
      controlSelected: probe(true), controlHttp1: probe(true),
    },
    gitVersion: '2.43.0', nodeVersion: '24.21.0',
  });
  const json = JSON.stringify(report);
  for (const secret of ['helper-secret-path', 'header-secret-value', 'relative-certs', 'raw-error-secret', 'trace-secret', 'header-secret']) {
    assert.equal(json.includes(secret), false);
  }
  assert.equal(JSON.stringify(report.transport_snapshot.proxy).includes('proxy.example'), true);
  assert.equal(JSON.stringify(report.transport_snapshot.settings_presence).includes('secret'), false);
});

test('uses the lower-case HTTPS proxy and preserves no_proxy behavior', async t => {
  const context = await makeConfigRepo();
  t.after(() => fs.rm(context.base, { recursive: true, force: true }));
  const env = {
    ...context.env,
    https_proxy: 'https://proxy.example:8443',
    HTTPS_PROXY: 'http://ignored.example:3128',
    no_proxy: 'github.com,localhost',
    NO_PROXY: 'should-not-win.invalid',
  };
  const snapshot = await loadTransportSnapshot(targetUrl, { cwd: context.cwd, env });
  assert.equal(snapshot.proxy.source, 'environment');
  assert.deepEqual(snapshot.proxy.endpoint, { scheme: 'https', host: 'proxy.example', port: '8443' });
  assert.equal(snapshot.noProxyPresent, true);
  assert.equal(snapshot.noProxyValue, 'github.com,localhost');

  const childEnv = buildProbeEnvironment(snapshot, { parentEnv: env, neutralCwd: '/tmp/neutral-cwd' });
  assert.equal(childEnv.no_proxy, 'github.com,localhost');
  assert.equal(Object.hasOwn(childEnv, 'NO_PROXY'), false);
  assert.equal(Object.hasOwn(childEnv, 'https_proxy'), false);
  assert.equal(childEnv.GIT_CONFIG_VALUE_5, 'https://proxy.example:8443/');
});

test('an explicit empty Git proxy disables inherited proxy variables', async t => {
  const context = await makeConfigRepo();
  t.after(() => fs.rm(context.base, { recursive: true, force: true }));
  await addConfig(context, 'http.proxy', '');
  const env = { ...context.env, https_proxy: 'socks5://user:token@proxy.invalid:1080' };
  const snapshot = await loadTransportSnapshot(targetUrl, { cwd: context.cwd, env });
  assert.equal(snapshot.proxy.source, 'git-config');
  assert.equal(snapshot.proxy.configured, true);
  assert.equal(snapshot.proxy.enabled, false);
  const childEnv = buildProbeEnvironment(snapshot, { parentEnv: env });
  assert.equal(Object.values(childEnv).includes('socks5://user:token@proxy.invalid:1080'), false);
});

test('refuses proxy credentials, query values and SOCKS schemes without echoing them', async t => {
  const context = await makeConfigRepo();
  t.after(() => fs.rm(context.base, { recursive: true, force: true }));
  const unsafeValues = [
    'http://user:proxy-secret@proxy.example:8080',
    'https://proxy.example:8443/?token=query-secret',
    'socks5://proxy.example:1080',
  ];
  for (const value of unsafeValues) {
    await git(['-C', context.cwd, 'config', '--local', 'http.proxy', value], context.base, context.env);
    await assert.rejects(loadTransportSnapshot(targetUrl, { cwd: context.cwd, env: context.env }), error => error.code === 'proxy_unsupported');
  }
});

test('rebuilds the probe environment and drops inherited Git credentials and verification overrides', () => {
  const hostile = {
    PATH: process.env.PATH,
    HOME: '/home/kept-exactly',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: 'Authorization: Bearer inherited-secret',
    GIT_CONFIG_PARAMETERS: "'http.proxy=proxy-secret'",
    GIT_SSL_NO_VERIFY: '0',
    GIT_ASKPASS: '/tmp/askpass-secret',
    GIT_TRACE_CURL: '/tmp/trace-file',
    SSLKEYLOGFILE: '/tmp/tls-key-log',
    https_proxy: 'http://user:password@proxy.invalid:8080',
    ALL_PROXY: 'socks5://proxy.invalid:1080',
    no_proxy: 'github.com',
  };
  const snapshot = {
    httpVersion: 'HTTP/2',
    proxy: { url: 'http://proxy.example:3128/', configured: true, enabled: true, source: 'git-config', endpoint: { scheme: 'http', host: 'proxy.example', port: '3128' } },
    noProxyPresent: true,
    noProxyValue: 'github.com',
    caInfoPath: '/tmp/ca.pem',
    caPathPath: undefined,
    sslBackend: undefined,
    proxyCaInfoPath: undefined,
  };
  const env = buildProbeEnvironment(snapshot, { parentEnv: hostile, neutralCwd: '/tmp/neutral-cwd' });
  assert.equal(env.HOME, hostile.HOME);
  assert.equal(env.no_proxy, 'github.com');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_VALUE_2, '');
  assert.equal(env.GIT_CONFIG_VALUE_3, 'Authorization:');
  assert.equal(env.GIT_CONFIG_VALUE_4, 'false');
  assert.equal(env.GIT_CONFIG_VALUE_5, 'http://proxy.example:3128/');
  assert.equal(Object.hasOwn(env, 'GIT_SSL_NO_VERIFY'), false);
  assert.equal(Object.hasOwn(env, 'GIT_ASKPASS'), false);
  assert.equal(Object.hasOwn(env, 'GIT_CONFIG_PARAMETERS'), false);
  assert.equal(Object.hasOwn(env, 'GIT_TRACE_CURL'), true);
  assert.equal(env.GIT_TRACE_CURL, '1');
  assert.equal(Object.hasOwn(env, 'SSLKEYLOGFILE'), false);
  assert.equal(Object.hasOwn(env, 'https_proxy'), false);
  assert.equal(Object.values(env).some(value => String(value).includes('inherited-secret') || String(value).includes('password')), false);
});

test('refuses a present netrc symlink and accepts only a checked absence', async t => {
  const context = await makeConfigRepo();
  t.after(() => fs.rm(context.base, { recursive: true, force: true }));
  await assert.doesNotReject(assertNoNetrc(context.env));
  await fs.symlink('missing-target', path.join(context.home, '.netrc'));
  await assert.rejects(assertNoNetrc(context.env), error => error.code === 'netrc_present');
  await fs.unlink(path.join(context.home, '.netrc'));
  await assert.rejects(assertNoNetrc({ ...context.env, HOME: '' }), error => error.code === 'home_unavailable');
});

function probe(ok) {
  return {
    ok,
    outcome: ok ? 'passed' : 'http_error',
    requestedHttpVersion: 'HTTP/2',
    responseProtocols: ['HTTP/2'],
    originStatuses: [ok ? 200 : 403],
    proxyConnectStatuses: [],
    rawError: 'raw-error-secret',
    trace: 'trace-secret',
    headers: 'header-secret',
  };
}
