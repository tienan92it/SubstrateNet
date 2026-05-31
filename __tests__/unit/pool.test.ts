import { describe, it, expect } from 'vitest';
import { mapPool } from '../../src/util/pool';

describe('mapPool', () => {
  it('preserves order and maps all items', async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually parallelized
  });

  it('handles empty input and limit >= length', async () => {
    expect(await mapPool([], 4, async (x) => x)).toEqual([]);
    expect(await mapPool([1, 2], 10, async (n) => n + 1)).toEqual([2, 3]);
  });
});
