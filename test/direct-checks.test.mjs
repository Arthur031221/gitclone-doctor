import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { runDirectChecks } from '../lib/direct-checks.mjs';

test('resolved IPv4 addresses reach verified TLS and the socket is closed', async t => {
  let destroyed = false;
  t.mock.method(dns.Resolver.prototype, 'resolve4', async host => {
    assert.equal(host, 'github.com');
    return ['192.0.2.10'];
  });
  t.mock.method(tls, 'connect', options => {
    assert.equal(options.host, '192.0.2.10');
    assert.equal(options.servername, 'github.com');
    assert.equal(options.rejectUnauthorized, true);
    const socket = new EventEmitter();
    socket.authorized = true;
    socket.destroy = () => { destroyed = true; };
    queueMicrotask(() => socket.emit('secureConnect'));
    return socket;
  });
  const checks = await runDirectChecks();
  assert.equal(checks.dns.status, 'passed');
  assert.equal(checks.tls.status, 'passed');
  assert.equal(checks.tls.certificateVerification, true);
  assert.equal(destroyed, true);
});
