#!/usr/bin/env node
import { main } from "../dist/src/cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`rr: ${message}\n`);
    process.exitCode = 1;
  },
);
