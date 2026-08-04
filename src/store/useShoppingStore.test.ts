import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from '@/db/testUtils';
import { getShoppingSessionsBySpaceAndStatus } from '@/db/repo';
import { useShoppingStore } from './useShoppingStore';

const spaceId = 'space-1';

describe('useShoppingStore.clearActiveSession', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    // Reset the singleton store between tests.
    useShoppingStore.setState({
      session: null,
      ticks: [],
      manualItems: [],
      itemMeta: [],
      packSizes: [],
      derivedList: null,
      loading: false,
      error: null,
    });
  });

  it('marks the active session done and resets store state', async () => {
    await useShoppingStore.getState().startSession(spaceId, '2026-08-03', '2026-08-09');
    expect(useShoppingStore.getState().session).not.toBeNull();

    await useShoppingStore.getState().clearActiveSession(spaceId);

    // Store is cleared.
    expect(useShoppingStore.getState().session).toBeNull();
    expect(useShoppingStore.getState().derivedList).toBeNull();

    // No active session remains; the old one is now 'done'.
    expect(await getShoppingSessionsBySpaceAndStatus(spaceId, 'active')).toHaveLength(0);
    expect(await getShoppingSessionsBySpaceAndStatus(spaceId, 'done')).toHaveLength(1);
  });

  it('lets the next startSession build a fresh session with the new dates', async () => {
    await useShoppingStore.getState().startSession(spaceId, '2026-08-03', '2026-08-09');
    await useShoppingStore.getState().clearActiveSession(spaceId);

    const next = await useShoppingStore.getState().startSession(spaceId, '2026-08-10', '2026-08-16');
    expect(next.fromDate).toBe('2026-08-10');
    expect(next.toDate).toBe('2026-08-16');
    expect(await getShoppingSessionsBySpaceAndStatus(spaceId, 'active')).toHaveLength(1);
  });
});
