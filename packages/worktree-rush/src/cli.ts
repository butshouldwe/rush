#!/usr/bin/env node
import { cliMain } from './cliMain.js';
process.exitCode = cliMain(process.argv.slice(2));
