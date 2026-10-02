#!/usr/bin/env node
import { main } from '../lib/cli.mjs';

process.exitCode = await main();
