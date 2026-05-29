#!/usr/bin/env node
import { Command } from 'commander';
import { registerInit } from './init.js';
import { registerSync } from './sync.js';
import { registerIngest } from './ingest.js';
import { registerStatus } from './status.js';
import { registerAgents } from './agents.js';
import { registerServe } from './serve.js';
import { registerCanvas } from './canvas.js';
import { registerLink } from './link.js';
import { registerTriage } from './triage.js';
import { registerVerify } from './verify.js';
import { registerEnrich } from './enrich.js';

const program = new Command();

program
  .name('codegps')
  .description('Local, layered knowledge graph across projects and AI conversations')
  .version('0.1.0');

registerInit(program);
registerSync(program);
registerIngest(program);
registerStatus(program);
registerAgents(program);
registerServe(program);
registerCanvas(program);
registerLink(program);
registerTriage(program);
registerVerify(program);
registerEnrich(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
