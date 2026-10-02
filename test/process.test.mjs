import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runBounded } from '../lib/process.mjs';

const env = { PATH: process.env.PATH, HOME: process.env.HOME };

async function processIsGone(pid) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0);
      try {
        const stat = await import('node:fs/promises').then(fs => fs.readFile(`/proc/${pid}/stat`, 'utf8'));
        const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
        if (state === 'Z') return true;
      } catch {
        if (process.platform !== 'linux') return true;
      }
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
      throw error;
    }
    await delay(20);
  }
  return false;
}

test('runs an argument vector without a shell and captures bounded output', async () => {
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'literal;value'], {
    cwd: process.cwd(), env, timeoutMs: 2000,
  });
  assert.equal(result.status, 'exited');
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString(), 'literal;value');
});

test('terminates the process group when output exceeds the limit', async () => {
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], {
    cwd: process.cwd(), env, timeoutMs: 3000, maxStdoutBytes: 256,
  });
  assert.equal(result.status, 'output_limit');
  assert.equal(result.stdout.length, 256);
  assert.equal(result.cleanupFailed, false);
});

test('kills descendants after timeout even when the group leader exits', async () => {
  const code = [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"] , { stdio: "ignore" });',
    'process.stdout.write(String(child.pid));',
    'setInterval(() => {}, 1000);',
  ].join('');
  const result = await runBounded(process.execPath, ['-e', code], {
    cwd: process.cwd(), env, timeoutMs: 150, killGraceMs: 100, cleanupTimeoutMs: 1200,
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.cleanupFailed, false);
  const descendantPid = Number(result.stdout.toString());
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  assert.equal(await processIsGone(descendantPid), true);
});

test('cancels and reaps a process group on signal', async () => {
  const controller = new AbortController();
  const code = [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"] , { stdio: "ignore" });',
    'process.stdout.write(String(child.pid));',
    'setInterval(() => {}, 1000);',
  ].join('');
  const pending = runBounded(process.execPath, ['-e', code], {
    cwd: process.cwd(), env, timeoutMs: 3000, killGraceMs: 100, cleanupTimeoutMs: 1200, signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cleanupFailed, false);
  const descendantPid = Number(result.stdout.toString());
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  assert.equal(await processIsGone(descendantPid), true);
});
