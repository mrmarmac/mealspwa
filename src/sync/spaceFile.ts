/**
 * Space export/import: a portable snapshot of one space's data, used both as
 * a manual backup/restore and as the transport for moving a space to a new
 * device before real sync exists. Import goes through the exact same
 * `resolve()` LWW merge as live sync (via `applyRemoteEntity`), and observes
 * every incoming HLC into the local clock first — so importing a stale
 * export can never clobber a newer local edit, and the local clock never
 * regresses behind data it has now seen.
 */
import { ensureClock } from '@/db/clock';
import { applyRemoteEntity, repos as defaultRepos, type Repos } from '@/db/repo';
import type { Id, ISODateTime } from '@/domain/primitives';
import type { Syncable } from '@/domain/types';

export const SPACE_FILE_FORMAT_VERSION = 1;

export interface SpaceFile {
  formatVersion: 1;
  exportedAt: ISODateTime;
  spaceId: Id;
  /** Every non-blob entity belonging to the space, tombstones included, so
   *  an import can propagate deletes exactly like sync would. Blobs (recipe
   *  photos) are excluded in v1 — they're large and content-addressed, and
   *  re-attaching them per device is preferable to bloating the export. */
  entities: Syncable[];
}

export interface ImportResult {
  applied: number;
  skipped: number;
}

/** Gather every live-and-tombstoned entity for `spaceId` across all synced
 *  stores. Reads `includeDeleted` so tombstones round-trip. */
export async function exportSpace(spaceId: Id, target: Repos = defaultRepos): Promise<SpaceFile> {
  const byStore = await Promise.all([
    target.space.getAll({ includeDeleted: true }),
    target.recipe.getAll({ includeDeleted: true }),
    target.placement.getAll({ includeDeleted: true }),
    target.shoppingSession.getAll({ includeDeleted: true }),
    target.shoppingTick.getAll({ includeDeleted: true }),
    target.manualItem.getAll({ includeDeleted: true }),
    target.itemMeta.getAll({ includeDeleted: true }),
    target.packSize.getAll({ includeDeleted: true }),
  ]);

  const entities: Syncable[] = byStore.flat().filter((e) => e.spaceId === spaceId);

  return {
    formatVersion: SPACE_FILE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    spaceId,
    entities,
  };
}

export async function importSpaceFile(
  file: SpaceFile,
  target: Repos = defaultRepos,
): Promise<ImportResult> {
  if (file.formatVersion !== SPACE_FILE_FORMAT_VERSION) {
    throw new Error(`Unsupported space file formatVersion: ${String(file.formatVersion)}`);
  }

  // Pull the clock forward past everything in the file BEFORE writing any of
  // it, so a subsequent local edit made right after import is guaranteed to
  // sort after every imported timestamp.
  const clock = await ensureClock();
  for (const entity of file.entities) {
    clock.observe(entity.updatedAt);
  }

  let applied = 0;
  let skipped = 0;
  for (const entity of file.entities) {
    const wasApplied = await applyRemoteEntity(target, entity);
    if (wasApplied) applied += 1;
    else skipped += 1;
  }

  return { applied, skipped };
}

// ---------------------------------------------------------------------------
// Browser I/O helpers
// ---------------------------------------------------------------------------

/** Trigger a browser download of a space file as `<space-id>.json`. No-op
 *  outside a browser (e.g. under a test runner) beyond constructing the
 *  Blob, since there is no `document` to attach the link to. */
export function downloadSpaceFile(file: SpaceFile, filenamePrefix = 'meals-space'): void {
  const json = JSON.stringify(file, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${filenamePrefix}-${file.spaceId}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isSyncable(v: unknown): v is Syncable {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return (
    typeof rec['id'] === 'string' &&
    typeof rec['kind'] === 'string' &&
    typeof rec['spaceId'] === 'string' &&
    typeof rec['updatedAt'] === 'string' &&
    (rec['deletedAt'] === null || typeof rec['deletedAt'] === 'string')
  );
}

function isSpaceFile(v: unknown): v is SpaceFile {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return (
    rec['formatVersion'] === SPACE_FILE_FORMAT_VERSION &&
    typeof rec['exportedAt'] === 'string' &&
    typeof rec['spaceId'] === 'string' &&
    Array.isArray(rec['entities']) &&
    rec['entities'].every(isSyncable)
  );
}

/** Read a `File` (from an `<input type="file">` or drag-drop) as a
 *  `SpaceFile`, validating its shape. */
export async function readSpaceFile(file: File): Promise<SpaceFile> {
  const text = await file.text();
  const parsed: unknown = JSON.parse(text);
  if (!isSpaceFile(parsed)) {
    throw new Error('Not a valid meals space export file.');
  }
  return parsed;
}
