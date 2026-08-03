import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestDatabase } from './testUtils';
import { _resetClockForTests, ensureClock } from './clock';
import { encodeHLC } from '@/domain/hlc';

describe('clock', () => {
  beforeEach(() => resetTestDatabase());
  afterEach(() => vi.restoreAllMocks());

  it('now() is strictly increasing on consecutive calls', async () => {
    const clock = await ensureClock();
    const a = clock.now();
    const b = clock.now();
    expect(b > a).toBe(true);
  });

  it('stays monotonic even when the wall clock jumps backwards', async () => {
    const clock = await ensureClock();
    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(2_000_000);
    const before = clock.now();

    nowSpy.mockReturnValue(1_000_000); // wall clock goes backwards
    const after = clock.now();

    expect(after > before).toBe(true);
  });

  it('observe() rejects a timestamp more than an hour in the future', async () => {
    const clock = await ensureClock();
    const stateBefore = clock.state();

    const farFutureMs = Date.now() + 2 * 60 * 60 * 1000;
    const bogus = encodeHLC(farFutureMs, 0, 'attacker-client');
    clock.observe(bogus);

    expect(clock.state()).toEqual(stateBefore);
  });

  it('observe() does pull the clock forward for a timestamp within the skew window', async () => {
    const clock = await ensureClock();
    const nearFutureMs = Date.now() + 5 * 60 * 1000; // 5 minutes, within 1h skew
    const incoming = encodeHLC(nearFutureMs, 3, 'peer-client');
    clock.observe(incoming);

    expect(clock.state().epochMs).toBeGreaterThanOrEqual(nearFutureMs);
    const next = clock.now();
    expect(next > incoming).toBe(true);
  });

  it('persists clientId and HLC state across a simulated reload', async () => {
    const clock1 = await ensureClock();
    const clientId1 = clock1.clientId;
    const t1 = clock1.now();

    // Let the debounced meta-store write flush before "reloading".
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Simulate a reload: drop the in-memory singleton only (NOT the
    // database — resetTestDatabase() would wipe storage too).
    _resetClockForTests();
    const clock2 = await ensureClock();

    expect(clock2.clientId).toBe(clientId1);
    const t2 = clock2.now();
    expect(t2 > t1).toBe(true);
  });

  it('concurrent ensureClock() calls share one initialisation', async () => {
    const [a, b] = await Promise.all([ensureClock(), ensureClock()]);
    expect(a).toBe(b);
    expect(a.clientId).toBe(b.clientId);
  });
});
