import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runBounded } from './process.mjs';
import { DoctorError } from './errors.mjs';

const ENV_NAMES = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'];
const PROXY_ENV_NAMES = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'];

function safeBaseEnv(parent = process.env) {
  const env = {};
  for (const name of ENV_NAMES) {
    if (Object.hasOwn(parent, name)) env[name] = parent[name];
  }
  return env;
}

function configReadEnv(parent = process.env) {
  const env = safeBaseEnv(parent);
  for (const [name, value] of Object.entries(parent)) {
    if (/^GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(name)) env[name] = value;
  }
  return env;
}

async function runGit(args, { cwd, env, signal, maxStdoutBytes = 65536 } = {}) {
  const result = await runBounded('git', args, {
    cwd,
    env,
    signal,
    timeoutMs: 8000,
    maxStdoutBytes,
    maxStderrBytes: 8192,
  });
  if (result.cleanupFailed) throw new DoctorError('config_read_failed');
  if (result.status === 'timeout' || result.status === 'output_limit') throw new DoctorError('config_output_limit');
  if (result.status === 'cancelled') throw new DoctorError('cancelled');
  if (result.status !== 'exited') throw new DoctorError('config_read_failed');
  return result;
}

async function getUrlValue(name, url, context) {
  const result = await runGit(['config', '--null', '--get-urlmatch', name, url], context);
  if (result.code === 1) return { found: false, value: undefined };
  if (result.code !== 0) throw new DoctorError('config_read_failed');
  const bytes = result.stdout;
  const value = bytes.length > 0 && bytes[bytes.length - 1] === 0 ? bytes.subarray(0, -1).toString('utf8') : bytes.toString('utf8');
  return { found: true, value };
}

async function hasUrlValue(name, url, context) {
  const result = await runGit(['config', '--null', '--get-urlmatch', name, url], context);
  if (result.code === 1) return false;
  if (result.code !== 0) throw new DoctorError('config_read_failed');
  return true;
}

function validateTextValue(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new DoctorError('config_read_failed');
  return value;
}

function normalizeHttpVersion(value) {
  if (!value.found) return 'default';
  const normalized = validateTextValue(value.value).toUpperCase();
  if (normalized === 'HTTP/1.1' || normalized === 'HTTP/2') return normalized;
  throw new DoctorError('unsupported_http_version');
}

function absoluteConfigPath(value, callerCwd, home) {
  const clean = validateTextValue(value);
  if (clean === '') return '';
  if (clean.startsWith('~') && clean !== '~' && !clean.startsWith('~/')) throw new DoctorError('config_read_failed');
  if (clean.includes('%')) throw new DoctorError('config_read_failed');
  let expanded = clean;
  if (expanded === '~') expanded = home;
  else if (expanded.startsWith('~/')) expanded = path.join(home, expanded.slice(2));
  return path.resolve(callerCwd, expanded);
}

function parseProxy(value) {
  const raw = validateTextValue(value);
  if (!raw || /[?#%\s]/.test(raw)) throw new DoctorError('proxy_unsupported');
  const authority = raw.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]+)/)?.[1] ?? '';
  if (authority.includes('@')) throw new DoctorError('proxy_unsupported');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DoctorError('proxy_unsupported');
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new DoctorError('proxy_unsupported');
  }

  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return {
    url: `${parsed.protocol}//${parsed.host}/`,
    endpoint: { scheme: parsed.protocol.slice(0, -1), host: parsed.hostname, port },
  };
}

function selectEnvironmentProxy(parent) {
  for (const name of PROXY_ENV_NAMES) {
    if (Object.hasOwn(parent, name)) return { found: true, name, value: parent[name] };
  }
  return { found: false, name: undefined, value: undefined };
}

function selectNoProxy(parent) {
  if (Object.hasOwn(parent, 'no_proxy')) return { found: true, value: parent.no_proxy };
  if (Object.hasOwn(parent, 'NO_PROXY')) return { found: true, value: parent.NO_PROXY };
  return { found: false, value: undefined };
}

export async function loadTransportSnapshot(targetUrl, options = {}) {
  const parent = options.env ?? process.env;
  const callerCwd = options.cwd ?? process.cwd();
  const homeValue = Object.hasOwn(parent, 'HOME') ? parent.HOME : os.homedir();
  if (!homeValue || !path.isAbsolute(homeValue)) throw new DoctorError('home_unavailable');
  const batchController = new AbortController();
  const abortBatch = () => batchController.abort();
  options.signal?.addEventListener('abort', abortBatch, { once: true });
  if (options.signal?.aborted) batchController.abort();
  const context = { cwd: callerCwd, env: configReadEnv(parent), signal: batchController.signal };

  const keys = [
    'http.version',
    'http.proxy',
    'http.sslCAInfo',
    'http.sslCAPath',
    'http.sslBackend',
    'http.proxySSLCAInfo',
  ];
  const tasks = [
    ...keys.map(name => getUrlValue(name, targetUrl, context)),
    hasUrlValue('credential.helper', targetUrl, context),
    hasUrlValue('http.extraHeader', targetUrl, context),
    runGit(['config', '--null', '--get-regexp', '^url\\..*\\.insteadOf$'], context),
  ];
  let values;
  try {
    values = await Promise.all(tasks);
  } catch (error) {
    batchController.abort();
    await Promise.allSettled(tasks);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortBatch);
  }
  const [version, proxyConfig, caInfo, caPath, sslBackend, proxyCaInfo, helperPresent, headerPresent, rewriteResult] = values;

  if (rewriteResult.code !== 0 && rewriteResult.code !== 1) throw new DoctorError('config_read_failed');

  const currentEnvProxy = selectEnvironmentProxy(parent);
  const noProxy = selectNoProxy(parent);
  if (noProxy.found && (typeof noProxy.value !== 'string' || noProxy.value.length > 32768 || /[\u0000\r\n]/.test(noProxy.value))) {
    throw new DoctorError('proxy_unsupported');
  }

  let proxy;
  if (proxyConfig.found) {
    const raw = validateTextValue(proxyConfig.value);
    if (raw === '') {
      proxy = { source: 'git-config', configured: true, enabled: false, endpoint: null, url: '' };
    } else {
      const parsed = parseProxy(raw);
      proxy = { source: 'git-config', configured: true, enabled: true, endpoint: parsed.endpoint, url: parsed.url };
    }
  } else if (currentEnvProxy.found) {
    if (typeof currentEnvProxy.value !== 'string') throw new DoctorError('proxy_unsupported');
    if (currentEnvProxy.value === '') {
      proxy = { source: 'environment', configured: true, enabled: false, endpoint: null, url: '' };
    } else {
      const parsed = parseProxy(currentEnvProxy.value);
      proxy = { source: 'environment', configured: true, enabled: true, endpoint: parsed.endpoint, url: parsed.url };
    }
  } else {
    proxy = { source: 'none', configured: false, enabled: false, endpoint: null, url: '' };
  }

  const caInfoPath = caInfo.found ? absoluteConfigPath(caInfo.value, callerCwd, homeValue) : undefined;
  const caPathPath = caPath.found ? absoluteConfigPath(caPath.value, callerCwd, homeValue) : undefined;
  const proxyCaInfoPath = proxyCaInfo.found ? absoluteConfigPath(proxyCaInfo.value, callerCwd, homeValue) : undefined;
  const backend = sslBackend.found ? validateTextValue(sslBackend.value) : undefined;
  if (backend !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(backend)) throw new DoctorError('config_read_failed');

  return Object.freeze({
    httpVersion: normalizeHttpVersion(version),
    proxy,
    noProxyPresent: noProxy.found,
    noProxyValue: noProxy.value,
    caInfoPath,
    caPathPath,
    sslBackend: backend,
    proxyCaInfoPath,
    settingsPresence: Object.freeze({
      originCaFile: caInfo.found,
      originCaDirectory: caPath.found,
      tlsBackend: sslBackend.found,
      proxyCaFile: proxyCaInfo.found,
      credentialHelper: helperPresent,
      extraHeader: headerPresent,
      urlRewrite: rewriteResult.code === 0,
    }),
  });
}

export function buildProbeEnvironment(snapshot, options = {}) {
  const parent = options.parentEnv ?? process.env;
  const env = safeBaseEnv(parent);
  const neutralCwd = options.neutralCwd ?? os.tmpdir();

  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CEILING_DIRECTORIES = neutralCwd;
  env.GIT_DISCOVERY_ACROSS_FILESYSTEM = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_TRACE_CURL = '1';
  env.GIT_TRACE_CURL_NO_DATA = '1';
  env.GIT_TRACE_REDACT = '1';
  if (snapshot.noProxyPresent) env.no_proxy = snapshot.noProxyValue;

  const entries = [
    ['credential.helper', ''],
    ['http.emptyAuth', 'false'],
    ['http.extraHeader', ''],
    ['http.extraHeader', 'Authorization:'],
    ['http.followRedirects', 'false'],
    ['http.proxy', snapshot.proxy.url],
    ['http.proxyAuthMethod', 'basic'],
    ['http.proxySSLVerify', 'true'],
    ['http.sslVerify', 'true'],
  ];

  if (snapshot.httpVersion !== 'default') entries.push(['http.version', snapshot.httpVersion]);
  if (snapshot.caInfoPath !== undefined) entries.push(['http.sslCAInfo', snapshot.caInfoPath]);
  if (snapshot.caPathPath !== undefined) entries.push(['http.sslCAPath', snapshot.caPathPath]);
  if (snapshot.sslBackend !== undefined) entries.push(['http.sslBackend', snapshot.sslBackend]);
  if (snapshot.proxyCaInfoPath !== undefined) entries.push(['http.proxySSLCAInfo', snapshot.proxyCaInfoPath]);
  if (options.forceHttp1) {
    const found = entries.findIndex(([key]) => key === 'http.version');
    if (found >= 0) entries[found][1] = 'HTTP/1.1';
    else entries.push(['http.version', 'HTTP/1.1']);
  }
  if (options.protocolVersion === 0) entries.push(['protocol.version', '0']);

  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  return env;
}

export async function assertNoNetrc(parent = process.env) {
  const home = Object.hasOwn(parent, 'HOME') ? parent.HOME : os.homedir();
  if (!home || !path.isAbsolute(home)) throw new DoctorError('home_unavailable');

  for (const name of ['.netrc', '_netrc']) {
    try {
      await fs.lstat(path.join(home, name));
      throw new DoctorError('netrc_present');
    } catch (error) {
      if (error instanceof DoctorError) throw error;
      if (error?.code !== 'ENOENT') throw new DoctorError('netrc_check_failed');
    }
  }
}

export async function readGitVersion(options = {}) {
  const result = await runGit(['--version'], {
    cwd: options.cwd ?? process.cwd(),
    env: safeBaseEnv(options.env ?? process.env),
    signal: options.signal,
    maxStdoutBytes: 1024,
  });
  if (result.code !== 0) throw new DoctorError('config_read_failed');
  const version = result.stdout.toString('utf8').match(/^git version ([0-9]+\.[0-9]+(?:\.[0-9]+)?)/)?.[1];
  if (!version) throw new DoctorError('config_read_failed');
  return version;
}
