import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, parseModelRef, configModelFingerprint } from '../../src/config';

describe('config', () => {
  it('default config has a flash-first triage agent with a local fallback', () => {
    expect(DEFAULT_CONFIG.agents.triage).toBeDefined();
    expect(DEFAULT_CONFIG.agents.triage.model.startsWith('openrouter:')).toBe(true);
    // Falls back to local Ollama so offline (no API key) runs still work.
    expect(JSON.stringify(DEFAULT_CONFIG.agents.triage.fallback)).toContain('default:');
  });

  it('parseModelRef splits on first colon, preserving model name with colons', () => {
    expect(parseModelRef('default:llama3.1:8b')).toEqual({ backend: 'default', model: 'llama3.1:8b' });
  });

  it('parseModelRef rejects bare model name', () => {
    expect(() => parseModelRef('llama3.1')).toThrow();
  });

  it('model fingerprint is stable for the same config and changes on model swap', () => {
    const a = configModelFingerprint(DEFAULT_CONFIG);
    const same = configModelFingerprint(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    expect(a).toBe(same);
    const changed = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    changed.agents.triage.model = 'default:llama3.1:8b';
    expect(configModelFingerprint(changed)).not.toBe(a);
  });
});
