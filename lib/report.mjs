import { classifyResults } from './verdict.mjs';

function safeProbe(probe) {
  return {
    ok: probe.ok,
    outcome: probe.outcome,
    requested_http_version: probe.requestedHttpVersion,
    response_protocols: probe.responseProtocols,
    proxy_connect_protocols: probe.proxyConnectProtocols ?? [],
    origin_statuses: probe.originStatuses,
    proxy_connect_statuses: probe.proxyConnectStatuses,
  };
}

function safeProxy(snapshot) {
  return {
    configured: snapshot.proxy.configured,
    enabled: snapshot.proxy.enabled,
    source: snapshot.proxy.source,
    endpoint: snapshot.proxy.endpoint,
    no_proxy_present: snapshot.noProxyPresent,
  };
}

export function buildReport(options) {
  const probes = {
    targetSelected: options.probes.targetSelected,
    targetHttp1: options.probes.targetHttp1,
    controlSelected: options.probes.controlSelected,
    controlHttp1: options.probes.controlHttp1,
  };
  const verdict = classifyResults(probes, options.snapshot.httpVersion);
  const report = {
    schema_version: 1,
    kind: 'gitclone-doctor.report',
    scope: options.fixture ? 'local_fixture' : 'public_github',
    target: { repository: options.targetName },
    runtime: {
      git_version: options.gitVersion,
      node_version: options.nodeVersion,
    },
    transport_snapshot: {
      requested_http_version: options.snapshot.httpVersion,
      control_uses_target_snapshot: true,
      proxy: safeProxy(options.snapshot),
      settings_presence: {
        origin_ca_file: options.snapshot.settingsPresence.originCaFile,
        origin_ca_directory: options.snapshot.settingsPresence.originCaDirectory,
        tls_backend: options.snapshot.settingsPresence.tlsBackend,
        proxy_ca_file: options.snapshot.settingsPresence.proxyCaFile,
        credential_helper: options.snapshot.settingsPresence.credentialHelper,
        extra_header: options.snapshot.settingsPresence.extraHeader,
        url_rewrite: options.snapshot.settingsPresence.urlRewrite,
        netrc_files_present: false,
      },
    },
    probes: {
      target_selected: safeProbe(probes.targetSelected),
      target_http1: safeProbe(probes.targetHttp1),
      control_selected_snapshot: safeProbe(probes.controlSelected),
      control_http1: safeProbe(probes.controlHttp1),
    },
    direct_checks: options.directChecks ?? {
      dns: { status: 'not_run', route: 'direct' },
      tls: { status: 'not_run', route: 'direct' },
    },
    verdict: { code: verdict.code, message: verdict.message },
    exit_code: options.fixture ? 0 : verdict.exitCode,
  };

  if (options.fixture) {
    report.fixture = {
      label: 'controlled local smart-HTTP fixture',
      verified: true,
    };
  }
  return report;
}

function httpSummary(probe, color) {
  const protocols = probe.response_protocols.length > 0 ? probe.response_protocols.join(', ') : 'none observed';
  const statuses = probe.origin_statuses.length > 0 ? `HTTP ${probe.origin_statuses.join(', ')}` : 'no origin status';
  const proxy = probe.proxy_connect_statuses.length > 0
    ? `; proxy CONNECT HTTP ${probe.proxy_connect_statuses.join(', ')}`
    : '';
  const status = probe.ok ? 'PASS' : 'FAIL';
  const label = color ? `\u001b[${probe.ok ? 32 : 31}m${status}\u001b[0m` : status;
  const result = probe.ok ? label : `${label} (${probe.outcome})`;
  return `${result}; requested ${probe.requested_http_version}; observed ${protocols}; ${statuses}${proxy}`;
}

function proxySummary(proxy) {
  if (!proxy.configured) return 'none selected';
  if (!proxy.enabled) return `${proxy.source}, explicitly empty`;
  const endpoint = proxy.endpoint;
  return `${proxy.source}, ${endpoint.scheme}://${endpoint.host}:${endpoint.port}`;
}

export function formatReport(report, { color = false } = {}) {
  const fixture = report.scope === 'local_fixture';
  const lines = [
    'gitclone-doctor',
    fixture ? 'LOCAL FIXTURE: controlled smart-HTTP comparison; no public GitHub request.' : `Repository: ${report.target.repository}`,
    `Runtime: Git ${report.runtime.git_version}, Node ${report.runtime.node_version}`,
  ];

  if (!fixture) {
    const snapshot = report.transport_snapshot;
    const settings = snapshot.settings_presence;
    lines.push(`Proxy: ${proxySummary(snapshot.proxy)}; no_proxy present: ${snapshot.proxy.no_proxy_present ? 'yes' : 'no'}`);
    lines.push(`Selected HTTP version: ${snapshot.requested_http_version}; control uses the same target-selected snapshot.`);
    lines.push(`Configured transport details: custom CA ${settings.origin_ca_file || settings.origin_ca_directory ? 'present' : 'absent'}, credential helper ${settings.credential_helper ? 'present' : 'absent'}, extra header ${settings.extra_header ? 'present' : 'absent'}, URL rewrite ${settings.url_rewrite ? 'present' : 'absent'}.`);
  }

  const checks = report.probes;
  lines.push('');
  lines.push('Git requests:');
  lines.push(`  target, selected settings: ${httpSummary(checks.target_selected, color)}`);
  lines.push(`  target, HTTP/1.1:          ${httpSummary(checks.target_http1, color)}`);
  lines.push(`  control, target snapshot:  ${httpSummary(checks.control_selected_snapshot, color)}`);
  lines.push(`  control, HTTP/1.1:         ${httpSummary(checks.control_http1, color)}`);

  if (!fixture) {
    lines.push('');
    lines.push(`Direct DNS check (bypasses proxy): ${report.direct_checks.dns.status}.`);
    lines.push(`Direct verified TLS check (bypasses proxy): ${report.direct_checks.tls.status}.`);
  }

  lines.push('');
  lines.push(`Verdict: ${report.verdict.message}`);
  if (report.verdict.code === 'http1_retry_passed' && !fixture) {
    lines.push(`Next step: git -c http.version=HTTP/1.1 clone ${canonicalCloneUrl(report.target.repository)}`);
  }
  lines.push('Scope: this checks anonymous ref discovery. It does not verify pack transfer, LFS, or submodules.');
  return `${lines.join('\n')}\n`;
}

function canonicalCloneUrl(repository) {
  return `https://github.com/${repository}.git`;
}
