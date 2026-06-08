import { describe, it, expect } from 'vitest';
import {
  runProfileFromSetup,
  resolveQualityProfile,
  resolveAnalyzeProfile,
  resolveEnrichProfile,
  shouldReprocessWindows,
  qualityProfileFromEnv,
} from '../../src/pipeline/profile';

describe('pipeline profile', () => {
  it('maps setup flags to runner profiles', () => {
    expect(runProfileFromSetup({})).toBe('default');
    expect(runProfileFromSetup({ profile: 'lean' })).toBe('fast');
    expect(runProfileFromSetup({ profile: 'deep' })).toBe('deep');
    expect(runProfileFromSetup({ reprocess: true })).toBe('full');
  });

  it('maps runner profiles to quality tiers', () => {
    expect(resolveQualityProfile('fast')).toBe('lean');
    expect(resolveQualityProfile('default')).toBe('standard');
    expect(resolveQualityProfile('deep')).toBe('deep');
    expect(resolveQualityProfile('full')).toBe('deep');
  });

  it('only full reprocesses windows', () => {
    expect(shouldReprocessWindows('deep')).toBe(false);
    expect(shouldReprocessWindows('full')).toBe(true);
  });

  it('routes analyze and enrich consistently', () => {
    expect(resolveAnalyzeProfile('default')).toBe('standard');
    expect(resolveAnalyzeProfile('deep')).toBe('deep');
    expect(resolveEnrichProfile('default')).toBe('standard');
    expect(resolveEnrichProfile('deep')).toBe('deep');
    expect(resolveEnrichProfile('full')).toBe('deep');
  });

  it('reads SUBNET_PROFILE from env', () => {
    const prev = process.env.SUBNET_PROFILE;
    process.env.SUBNET_PROFILE = 'lean';
    expect(qualityProfileFromEnv()).toBe('lean');
    process.env.SUBNET_PROFILE = prev;
  });
});
