import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DoctorError, safeErrorCode } from './errors.mjs';
import { parseTarget } from './target.mjs';
import { loadTransportSnapshot, readGitVersion } from './config.mjs';
import { runGitProbe } from './probe.mjs';
import { runDirectChecks } from './direct-checks.mjs';
import { buildReport, formatReport } from './report.mjs';
import { runLocalFixture } from './fixture.mjs';

const CONTROL_URL = 'https://github.com/git/git.git';

function parseArguments(args) {
  let json = false;
  let demo = false;
  let help = false;
  let targetInput;

  for (const argument of args) {
    if (argument === '--json') json = true;
    else if (argument === '--demo') demo = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else if (argument.startsWith('-') || targetInput !== undefined) throw new DoctorError('invalid_arguments');
    else targetInput = argument;
  }

  if (help) return { help: true, json, demo };
  if (demo && targetInput !== undefined) throw new DoctorError('invalid_arguments');
  if (!demo && targetInput === undefined) throw new DoctorError('invalid_arguments');
  return { json, demo, targetInput };
}

function helpText() {
  return [
    'Usage:',
    '  gitclone-doctor <owner/repo|https://github.com/owner/repo> [--json]',
    '  gitclone-doctor --demo [--json]',
    '',
    'Compare anonymous GitHub ref discovery with the selected transport and HTTP/1.1.',
    'A passing ref check does not verify pack transfer, LFS, or submodules.',
  ].join('\n') + '\n';
}

function writeSetupError(io, code, json) {
  if (json) {
    io.stdout.write(`${JSON.stringify({
      schema_version: 1,
      kind: 'gitclone-doctor.setup_error',
      error: { code },
    }, null, 2)}\n`);
  } else {
    io.stderr.write(`Setup refused: ${code}\n`);
  }
}

async function runDoctor(target, signal) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new DoctorError('platform_unsupported');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new DoctorError('unsupported_node_version');

  const neutralCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gitclone-doctor-'));
  try {
    const gitVersion = await readGitVersion({ cwd: neutralCwd, signal });
    const snapshot = await loadTransportSnapshot(target.url, { cwd: process.cwd(), signal });

    const targetSelected = await runGitProbe({ snapshot, url: target.url, neutralCwd, signal });
    const targetHttp1 = await runGitProbe({ snapshot, url: target.url, neutralCwd, signal, forceHttp1: true });
    const controlSelected = await runGitProbe({ snapshot, url: CONTROL_URL, neutralCwd, signal });
    const controlHttp1 = await runGitProbe({ snapshot, url: CONTROL_URL, neutralCwd, signal, forceHttp1: true });
    if (signal?.aborted) throw new DoctorError('cancelled');

    const directChecks = await runDirectChecks('github.com', { signal });
    if (signal?.aborted || directChecks.dns.status === 'cancelled') throw new DoctorError('cancelled');

    return buildReport({
      targetName: target.name,
      snapshot,
      probes: { targetSelected, targetHttp1, controlSelected, controlHttp1 },
      directChecks,
      gitVersion,
      nodeVersion: process.versions.node,
    });
  } finally {
    await fs.rm(neutralCwd, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2), options = {}) {
  const io = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
  let parsed;
  try {
    parsed = parseArguments(args);
    if (parsed.help) {
      io.stdout.write(helpText());
      return 0;
    }
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new DoctorError('platform_unsupported');
    if (Number(process.versions.node.split('.')[0]) < 20) throw new DoctorError('unsupported_node_version');

    const controller = options.controller ?? new AbortController();
    const handleInterrupt = () => controller.abort();
    if (!options.controller) {
      process.on('SIGINT', handleInterrupt);
      process.on('SIGTERM', handleInterrupt);
    }

    try {
      let report;
      let exitCode;
      if (parsed.demo) {
        const demo = await runLocalFixture({ signal: controller.signal });
        report = demo.report;
        exitCode = 0;
      } else {
        const target = parseTarget(parsed.targetInput);
        report = await runDoctor(target, controller.signal);
        exitCode = report.exit_code;
      }

      io.stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, { color: Boolean(io.stdout.isTTY) }));
      return exitCode;
    } finally {
      if (!options.controller) {
        process.off('SIGINT', handleInterrupt);
        process.off('SIGTERM', handleInterrupt);
      }
    }
  } catch (error) {
    const code = safeErrorCode(error);
    const json = parsed?.json ?? args.includes('--json');
    writeSetupError(io, code, json);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
