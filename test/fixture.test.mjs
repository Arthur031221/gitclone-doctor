import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.mjs';

test('CLI runs actual Git over local HTTP/2 and HTTP/1.1 smart-HTTP and reports JSON', async () => {
  let stdout = '';
  let stderr = '';
  const exitCode = await main(['--demo', '--json'], {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  });
  const report = JSON.parse(stdout);
  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(report.scope, 'local_fixture');
  assert.equal(report.fixture.verified, true);
  assert.equal(report.probes.target_selected.outcome, 'http_error');
  assert.deepEqual(report.probes.target_selected.response_protocols, ['HTTP/2']);
  assert.deepEqual(report.probes.target_selected.origin_statuses, [403]);
  assert.equal(report.probes.target_http1.ok, true);
  assert.deepEqual(report.probes.target_http1.response_protocols, ['HTTP/1.1']);
  assert.equal(report.probes.control_selected_snapshot.ok, true);
  assert.equal(report.probes.control_http1.ok, true);
  assert.equal(report.verdict.code, 'http1_retry_passed');
  assert.equal(report.exit_code, 0);
  assert.deepEqual(report.direct_checks.dns, { status: 'not_run', route: 'direct' });
  assert.equal(stdout.includes('raw stderr'), false);
  assert.equal(stdout.includes('authorization'), false);
});
