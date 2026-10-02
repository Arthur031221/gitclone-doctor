import { spawn } from 'node:child_process';

function sendSignal(child, signal) {
  if (!child.pid) return true;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

function appendBounded(chunks, chunk, current, maximum) {
  const next = current + chunk.length;
  const remaining = Math.max(0, maximum - current);
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return { bytes: Math.min(next, maximum), exceeded: next > maximum };
}

export function runBounded(command, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 10000,
    maxStdoutBytes = 8192,
    maxStderrBytes = 65536,
    signal,
    killGraceMs = 150,
    cleanupTimeoutMs = 1500,
  } = options;

  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve({ status: 'cancelled', code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), cleanupFailed: false });
      return;
    }

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ status: 'spawn_error', code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), cleanupFailed: false });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let spawnError = false;
    let outputExceeded = false;
    let stopCause = null;
    let stopStarted = false;
    let killDone = false;
    let closeInfo = null;
    let cleanupFailed = false;
    let finished = false;
    let hardKillTimer;
    let cleanupTimer;
    let timeoutTimer;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(hardKillTimer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const complete = status => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({
        status,
        code: closeInfo?.code ?? null,
        signal: closeInfo?.signal ?? null,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        cleanupFailed,
      });
    };

    const maybeComplete = () => {
      if (!closeInfo) return;
      if (stopCause && !killDone) return;
      if (cleanupFailed) complete('cleanup_failed');
      else if (stopCause) complete(stopCause);
      else if (spawnError) complete('spawn_error');
      else complete('exited');
    };

    const stop = cause => {
      if (!stopCause) stopCause = cause;
      if (stopStarted) return;
      stopStarted = true;
      killDone = false;
      if (!sendSignal(child, 'SIGTERM')) cleanupFailed = true;

      // Always kill the process group after the grace period. The group may
      // still contain children even if Git has already closed its own pipes.
      hardKillTimer = setTimeout(() => {
        if (!sendSignal(child, 'SIGKILL')) cleanupFailed = true;
        killDone = true;
        maybeComplete();
      }, killGraceMs);

      cleanupTimer = setTimeout(() => {
        if (!closeInfo) {
          cleanupFailed = true;
          sendSignal(child, 'SIGKILL');
          child.stdout?.destroy();
          child.stderr?.destroy();
          closeInfo = { code: null, signal: null };
          killDone = true;
          maybeComplete();
        }
      }, cleanupTimeoutMs);
    };

    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', () => {
      spawnError = true;
    });
    child.once('close', (code, closeSignal) => {
      closeInfo = { code, signal: closeSignal };
      maybeComplete();
    });

    child.stdout?.on('data', chunk => {
      const result = appendBounded(stdoutChunks, chunk, stdoutBytes, maxStdoutBytes);
      stdoutBytes = result.bytes;
      if (result.exceeded && !outputExceeded) {
        outputExceeded = true;
        stop('output_limit');
      }
    });
    child.stderr?.on('data', chunk => {
      const result = appendBounded(stderrChunks, chunk, stderrBytes, maxStderrBytes);
      stderrBytes = result.bytes;
      if (result.exceeded && !outputExceeded) {
        outputExceeded = true;
        stop('output_limit');
      }
    });

    timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs);
    if (signal?.aborted) onAbort();
  });
}
