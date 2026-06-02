import { describe, it, expect } from 'vitest';
import { slugForPath } from '../../src/ingest/cursor.js';
import { matchSlugToPaths } from '../../src/setup/slug.js';

describe('setup discovery slug matching', () => {
  it('slugForPath matches Cursor encoding', () => {
    expect(slugForPath('/Users/me/Workspace/kafi/k_one')).toBe('Users-me-Workspace-kafi-k-one');
    expect(slugForPath('/Users/me/Workspace/SubstrateNet')).toBe('Users-me-Workspace-SubstrateNet');
  });

  it('matchSlugToPaths finds candidates', () => {
    const candidates = [
      '/Users/me/Workspace/SubstrateNet',
      '/Users/me/Workspace/other',
    ];
    const matches = matchSlugToPaths('Users-me-Workspace-SubstrateNet', candidates);
    expect(matches).toEqual(['/Users/me/Workspace/SubstrateNet']);
  });

  it('matchSlugToPaths returns empty when no match', () => {
    expect(matchSlugToPaths('unknown-slug', ['/tmp/foo'])).toEqual([]);
  });
});
