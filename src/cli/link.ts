import type { Command } from 'commander';
import { resolve } from 'path';

export function registerLink(program: Command): void {
  program
    .command('link')
    .description('Rebuild cross-project links (L4)')
    .argument('[path]', 'Project root path', '.')
    .option('--rebuild', 'Full recompute instead of incremental', false)
    .action(async (path: string, opts: { rebuild: boolean }) => {
      const root = resolve(path);
      const { rebuildLinks } = await import('../link/cross-project.js');
      const stats = await rebuildLinks(root, { full: opts.rebuild });
      console.log(`Cross-project link rebuild:`);
      console.log(`  Concepts exported: ${stats.exported}`);
      console.log(`  Mechanical links:  ${stats.mechanical}`);
      console.log(`  Agent links:       ${stats.semantic}`);
      console.log(`  Skills (global):   ${stats.skills} (${stats.crossProjectSkills} cross-project)`);
      console.log(`  Business domains:  ${stats.businessDomains}`);
      console.log(`  Tech domains:      ${stats.techDomains}`);
    });
}
