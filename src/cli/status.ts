import type { Command } from 'commander';
import { resolve } from 'path';
import { openCodeDb, openKnowledgeDb } from '../db/connection.js';

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show counts per layer')
    .argument('[path]', 'Project root path', '.')
    .action(async (path: string) => {
      const root = resolve(path);
      const code = openCodeDb(root);
      const know = openKnowledgeDb(root);
      try {
        const codeStats = {
          files: count(code, 'files'),
          nodes: count(code, 'nodes'),
          edges: count(code, 'edges'),
        };
        const knowStats = {
          sessions: count(know, 'sessions'),
          turns: count(know, 'turns'),
          windows: count(know, 'turn_windows'),
          triaged: count(know, 'triage_labels'),
          kept: count(know, "triage_labels WHERE kept=1"),
          dropped: count(know, "triage_labels WHERE kept=0"),
          facts: count(know, 'k_nodes'),
          concepts: count(know, 'concepts'),
          agentRuns: count(know, 'agent_runs'),
          entities: count(know, "k_nodes WHERE kind='entity'"),
          relationships: count(know, "k_edges WHERE kind IN ('relates_to','owned_by','part_of','depends_on','has_state','transitions_to','governed_by')"),
          gaps: count(know, "k_nodes WHERE kind='knowledge_gap'"),
        };

        console.log('CodeGps status');
        console.log('  Project:', root);
        console.log('  L0 code:');
        console.log(`    files:   ${codeStats.files}`);
        console.log(`    nodes:   ${codeStats.nodes}`);
        console.log(`    edges:   ${codeStats.edges}`);
        console.log('  L1 conversations:');
        console.log(`    sessions: ${knowStats.sessions}`);
        console.log(`    turns:    ${knowStats.turns}`);
        console.log('  L1.5 triage:');
        console.log(`    windows:  ${knowStats.windows}`);
        console.log(`    triaged:  ${knowStats.triaged}  (kept=${knowStats.kept}, dropped=${knowStats.dropped})`);
        console.log('  L2 facts:    ', knowStats.facts);
        console.log('  L2.5 domain:');
        console.log(`    entities:      ${knowStats.entities}`);
        console.log(`    relationships: ${knowStats.relationships}`);
        console.log(`    knowledge gaps: ${knowStats.gaps}`);
        console.log('  L3 concepts: ', knowStats.concepts);
        console.log('  Agent runs:  ', knowStats.agentRuns);
      } finally {
        code.close();
        know.close();
      }
    });
}

function count(db: any, fromClause: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${fromClause}`).get();
  return row?.n ?? 0;
}
