import { main } from '../lib/cli.mjs';

process.exitCode = await main(['--demo', ...process.argv.slice(2)]);
