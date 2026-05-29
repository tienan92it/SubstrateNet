import type { Command } from 'commander';
import { resolve } from 'path';
import { ingestProject } from '../ingest/orchestrator.js';

export function registerIngest(program: Command): void {
  program
    .command('ingest')
    .description('Ingest conversation data (L1) and run agent pipeline (L1.5→L3)')
    .argument('[path]', 'Project root path', '.')
    .option('--agent <id>', 'Limit to one agent: cursor | claude-code | codex | copilot')
    .option('--no-triage', 'Skip Triage Agent (debug)')
    .option('--no-extract', 'Skip extractor agents (debug)')
    .option('--no-enrich', 'Skip domain enrichment pass (L2.5)')
    .action(async (path: string, opts: { agent?: string; triage?: boolean; extract?: boolean; enrich?: boolean }) => {
      const root = resolve(path);
      const stats = await ingestProject(root, {
        agentFilter: opts.agent as any,
        runTriage: opts.triage !== false,
        runExtract: opts.extract !== false,
        runEnrich: opts.enrich !== false,
      });
      console.log(`Ingest complete:`);
      console.log(`  Sessions seen:    ${stats.sessionsSeen} (new: ${stats.sessionsNew})`);
      console.log(`  Turns ingested:   ${stats.turnsIngested}`);
      console.log(`  Windows created:  ${stats.windowsCreated}`);
      console.log(`  Triaged:          ${stats.triaged} (kept ${stats.kept}, dropped ${stats.dropped})`);
      console.log(`  Facts produced:   ${stats.factsProduced}`);
      console.log(`  Concepts:         ${stats.conceptsCreated} created, ${stats.conceptsAttached} attached`);
      console.log(`  Domain entities:  ${stats.domainEntities}`);
      console.log(`  Relationships:    ${stats.domainRelationships}`);
      console.log(`  Knowledge gaps:   ${stats.knowledgeGaps}`);
    });
}
