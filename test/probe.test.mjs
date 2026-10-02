import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTraceHeaders } from '../lib/probe.mjs';
import { main } from '../lib/cli.mjs';

test('parses only response protocol and numeric status, separating proxy CONNECT', () => {
  const trace = [
    '09:00:00.000000 => Send header: CONNECT github.com:443 HTTP/1.1',
    '09:00:00.000000 <= Recv header: HTTP/1.1 200 Connection established',
    '09:00:00.000001 <= Recv header: proxy-authenticate: Basic realm="private-secret"',
    '09:00:00.000002 <= Recv header: HTTP/2 403',
    '09:00:00.000003 <= Recv header: location: https://private.invalid/path',
  ].join('\n');
  const parsed = parseTraceHeaders(Buffer.from(trace));
  assert.deepEqual(parsed, {
    responseProtocols: ['HTTP/2'],
    proxyConnectProtocols: ['HTTP/1.1'],
    originStatuses: [403],
    proxyConnectStatuses: [200],
  });
});

test('returns a stable JSON setup error and exit code for a rejected target', async () => {
  let stdout = '';
  let stderr = '';
  const code = await main(['https://user:password@github.com/git/git?token=secret', '--json'], {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  });
  assert.equal(code, 2);
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.error.code, 'invalid_target');
  assert.equal(stdout.includes('password'), false);
  assert.equal(stdout.includes('secret'), false);
});

test('prints help without probing and reports invalid option combinations as setup errors', async () => {
  let help = '';
  assert.equal(await main(['--help'], { stdout: { write(value) { help += value; } }, stderr: { write() {} } }), 0);
  assert.match(help, /anonymous GitHub ref discovery/);

  let json = '';
  const code = await main(['--demo', 'git/git', '--json'], {
    stdout: { write(value) { json += value; } },
    stderr: { write() {} },
  });
  assert.equal(code, 2);
  assert.equal(JSON.parse(json).error.code, 'invalid_arguments');
});
