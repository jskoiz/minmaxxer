#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
}).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`minmaxxer: ${message}\n`);
  process.exitCode = 3;
});
