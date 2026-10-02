import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResults } from '../lib/verdict.mjs';

function probes(targetSelected, targetHttp1, controlSelected, controlHttp1) {
  return {
    targetSelected: { ok: targetSelected },
    targetHttp1: { ok: targetHttp1 },
    controlSelected: { ok: controlSelected },
    controlHttp1: { ok: controlHttp1 },
  };
}

test('classifies selected transport success', () => {
  assert.deepEqual(classifyResults(probes(true, false, true, true), 'HTTP/2'), {
    code: 'refs_discovered',
    message: 'Anonymous ref discovery passed with the selected target settings.',
    exitCode: 0,
  });
});

test('classifies a successful HTTP/1.1 retry without assigning a cause', () => {
  assert.equal(classifyResults(probes(false, true, true, true), 'HTTP/2').code, 'http1_retry_passed');
  assert.equal(classifyResults(probes(false, true, true, true), 'HTTP/2').exitCode, 1);
});

test('calls differing HTTP/1.1 attempts inconsistent', () => {
  const result = classifyResults(probes(false, true, true, true), 'HTTP/1.1');
  assert.equal(result.code, 'inconsistent_results');
  assert.equal(result.exitCode, 1);
});

test('separates target failures from successful controls without blaming credentials', () => {
  const result = classifyResults(probes(false, false, true, true), 'HTTP/2');
  assert.equal(result.code, 'target_access_or_url');
  assert.match(result.message, /does not establish a credential problem/);
  assert.equal(result.exitCode, 1);
});

test('keeps a shared failure unresolved', () => {
  const result = classifyResults(probes(false, false, false, false), 'default');
  assert.equal(result.code, 'shared_failure');
  assert.equal(result.exitCode, 1);
});

test('labels other mixed results inconclusive', () => {
  const result = classifyResults(probes(false, false, true, false), 'default');
  assert.equal(result.code, 'inconclusive');
  assert.equal(result.exitCode, 1);
});
