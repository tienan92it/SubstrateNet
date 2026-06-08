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
import { registerProfile } from './profile.js';
import { registerClean } from './clean.js';
import { registerAnalyze } from './analyze.js';
import { registerDashboard } from './dashboard.js';
import { registerSetup } from './setup.js';
import { registerUpdate } from './update.js';
import { registerDoctor } from './doctor.js';
import { registerGlobal } from './global.js';
import { registerWatch } from './watch.js';
import { loadConfig } from '../config.js';
import { validateConfig } from '../config/validate.js';

const program = new Command();

program
  .name('subnet')
  .description('Local, layered knowledge graph across projects and AI conversations')
  .version('0.2.0');

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
registerProfile(program);
registerClean(program);
registerAnalyze(program);
registerDashboard(program);
registerSetup(program);
registerUpdate(program);
registerDoctor(program);
registerGlobal(program);
registerWatch(program);

// Keep the top-level surface small: the per-stage / maintenance commands still
// work but are hidden from help and the menu (reachable directly, e.g. for
// scripts and debugging). The essentials stay visible.
const ADVANCED = new Set([
  'init', 'sync', 'ingest', 'status', 'agents', 'canvas', 'link', 'triage',
  'verify', 'enrich', 'profile', 'skills', 'learn', 'clean', 'analyze', 'dashboard',
]);
for (const cmd of program.commands) {
  if (ADVANCED.has(cmd.name())) (cmd as unknown as { _hidden: boolean })._hidden = true;
}

program.addHelpText('after', '\nRun `subnet` with no arguments for an interactive menu.\n');

// Default action: launch the interactive menu in a TTY, else print help so
// scripts/CI get deterministic output.
program.action(async () => {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { runInteractiveMenu } = await import('../tui/menu.js');
    await runInteractiveMenu();
  } else {
    program.help();
  }
});

// Best-effort startup check: surface fatal config errors (bad model refs,
// unknown backends) once, without flooding on warnings.
try {
  const findings = validateConfig(loadConfig());
  for (const f of findings) {
    if (f.level === 'error') process.stderr.write(`\x1b[31mconfig error:\x1b[0m ${f.message}\n`);
  }
} catch { /* config may be absent on first run */ }

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
