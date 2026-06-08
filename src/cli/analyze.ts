import type { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { analyzeProject } from '../pipeline/analyze-code.js';
import { warnDeprecated } from './deprecate.js';

export function registerAnalyze(program: Command): void {
  program
    .command('analyze')
    .description('Code-grounded analysis (L0 -> summaries, architectural layers, tags) via the FileAnalyzer agent')
    .argument('[path]', 'Project root path', '.')
    .option('--full', 'Re-analyze every file, ignoring content hashes', false)
    .action(async (path: string, opts: { full: boolean }) => {
      warnDeprecated('analyze', 'update');
      const root = resolve(path);
      const cfg = loadConfig(root);
      const stats = await analyzeProject(root, cfg, { full: opts.full });
      console.log('Analysis complete:');
      console.log(`  Files analyzed:  ${stats.filesAnalyzed}`);
      console.log(`  Files skipped:   ${stats.filesSkipped} (unchanged)`);
      console.log(`  Failed:          ${stats.failed}`);
      const layers = Object.entries(stats.byLayer).sort((a, b) => b[1] - a[1]);
      if (layers.length) {
        console.log('  By layer:');
        for (const [layer, n] of layers) console.log(`    ${layer.padEnd(9)} ${n}`);
      }
    });
}
