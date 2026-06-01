import type { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';
import { runEnrichment } from '../pipeline/enrich.js';

export function registerEnrich(program: Command): void {
  program
    .command('enrich')
    .description('Enrich business-domain knowledge: structural entities + relationships + gaps (L2.5)')
    .argument('[path]', 'Project root path', '.')
    .option('--no-agent', 'Structural + deterministic gaps only (no LLM)')
    .action(async (path: string, opts: { agent?: boolean }) => {
      const root = resolve(path);
      const cfg = loadConfig(root);
      const codeDb = openCodeDb(root);
      const knowDb = openKnowledgeDb(root);
      try {
        const stats = await runEnrichment(root, knowDb, codeDb, cfg, { noAgent: opts.agent === false });
        console.log(`Enrichment complete:`);
        console.log(`  Dependencies / tools:     ${stats.dependencies} / ${stats.tools}`);
        console.log(`  Technical skills:         ${stats.technicalSkills}`);
        console.log(`  Structural entities:      ${stats.structuralEntities} (+ ${stats.externalEntities} external)`);
        console.log(`  Structural relationships: ${stats.structuralRelationships}`);
        console.log(`  Reconciled (corroborated): ${stats.reconciledEntities}`);
        console.log(`  Agent relationships:      ${stats.agentRelationships}`);
        console.log(`  Industry:                 ${stats.industry ?? '(unclassified)'}`);
        console.log(`  Industry-standard items:  ${stats.industryConcepts} (${stats.externalUpgrades} web-cited)`);
        console.log(`  Portfolio highlights:     ${stats.domainHighlights}`);
        console.log(`  Gaps (agent / detected):  ${stats.agentGaps} / ${stats.detectedGaps}`);
      } finally {
        codeDb.close();
        knowDb.close();
      }
    });
}
