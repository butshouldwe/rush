#!/usr/bin/env node
import { cliMain } from './cliMain.js';
process.exitCode = await cliMain(process.argv.slice(2));
