/**
 * Settings, plus the space export/import handoff.
 *
 * That handoff matters more than it looks: this version stores everything in
 * one browser on one device, so an export file is currently the only way to get
 * the plan onto a second phone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AISLE_LABELS, type MeasurementDialect } from '@/domain/types';
import type { Id } from '@/domain/primitives';
import { useSpaceStore } from '@/store/useSpaceStore';
import { useSyncStore } from '@/store/useSyncStore';
import { downloadSpaceFile, exportSpace, importSpaceFile, readSpaceFile } from '@/sync/spaceFile';
import { Icon } from '@/shell/Icon';
import { Spinner } from '@/shell/Spinner';
import { useToast } from '@/shell/Toast';
import './SettingsScreen.css';

const DIALECTS: { value: MeasurementDialect; label: string }[] = [
  { value: 'metric-uk', label: 'UK (15ml tbsp)' },
  { value: 'metric-au', label: 'Australia (20ml tbsp)' },
  { value: 'us', label: 'US (240ml cup)' },
];

function formatTime(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'never' : date.toLocaleTimeString();
}

/**
 * "Sync across devices" — the real backend handoff. Renders nothing when the
 * build has no sync backend configured (VITE_SYNC_URL unset), exactly like the
 * recipe-fetcher feature: unconfigured means invisible, not broken.
 */
function SyncSection({ spaceId }: { spaceId: Id }) {
  const toast = useToast();
  const available = useSyncStore((s) => s.available);
  const enabled = useSyncStore((s) => s.enabled);
  const status = useSyncStore((s) => s.status);
  const syncing = useSyncStore((s) => s.syncing);
  const enable = useSyncStore((s) => s.enable);
  const join = useSyncStore((s) => s.join);
  const disable = useSyncStore((s) => s.disable);
  const syncNow = useSyncStore((s) => s.syncNow);
  const getJoinCode = useSyncStore((s) => s.getJoinCode);
  const refresh = useSyncStore((s) => s.refresh);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);

  const [busy, setBusy] = useState(false);
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [showJoin, setShowJoin] = useState(false);
  const [codeInput, setCodeInput] = useState('');

  useEffect(() => {
    void refresh();
    void refreshStatus();
  }, [refresh, refreshStatus]);

  const handleEnable = useCallback(async () => {
    setBusy(true);
    try {
      const result = await enable(spaceId);
      setJoinCode(result.joinCode);
      toast.show({ message: 'Sync enabled', variant: 'success' });
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Could not enable sync', variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [enable, spaceId, toast]);

  const handleShowCode = useCallback(async () => {
    setJoinCode(await getJoinCode());
  }, [getJoinCode]);

  const handleCopy = useCallback(async () => {
    if (!joinCode) return;
    try {
      await navigator.clipboard.writeText(joinCode);
      toast.show({ message: 'Join code copied', variant: 'success' });
    } catch {
      toast.show({ message: 'Copy failed — select and copy the code manually', variant: 'error' });
    }
  }, [joinCode, toast]);

  const handleJoin = useCallback(async () => {
    const code = codeInput.trim();
    if (!code) return;
    setBusy(true);
    try {
      await join(code);
      toast.show({ message: 'Joined — reloading', variant: 'success' });
      window.location.reload();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Could not join', variant: 'error' });
      setBusy(false);
    }
  }, [codeInput, join, toast]);

  const handleSyncNow = useCallback(async () => {
    setBusy(true);
    try {
      await syncNow();
      const { lastError } = useSyncStore.getState();
      toast.show(
        lastError
          ? { message: lastError, variant: 'error' }
          : { message: 'Synced', variant: 'success' },
      );
    } finally {
      setBusy(false);
    }
  }, [syncNow, toast]);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    try {
      await disable();
      setJoinCode(null);
      setShowJoin(false);
      toast.show({ message: 'Disconnected from sync', variant: 'success' });
    } finally {
      setBusy(false);
    }
  }, [disable, toast]);

  // Unconfigured build: no controls at all.
  if (!available) return null;

  return (
    <section className="settings__section">
      <h2 className="settings__section-title">Sync across devices</h2>

      {enabled ? (
        <>
          <p className="settings__hint">
            This device is syncing. Changes reach the other phone within a few seconds while both
            are online; offline edits merge automatically on reconnect — newer edits always win.
          </p>
          <p className="settings__status">
            {syncing ? 'Syncing…' : `Last pull ${formatTime(status?.lastPullOkAt ?? null)}`}
            {status ? ` · ${status.pendingCount} pending` : ''}
          </p>
          {joinCode ? (
            <>
              <p className="settings__hint">
                On the other phone, open Settings → Sync across devices → Join a space, and paste
                this. Anyone with this code can read and write this space, so share it directly.
              </p>
              <code className="settings__code">{joinCode}</code>
            </>
          ) : null}
          <div className="settings__buttons">
            <button type="button" className="btn btn--secondary" onClick={() => void handleSyncNow()} disabled={busy}>
              Sync now
            </button>
            {joinCode ? (
              <button type="button" className="btn btn--secondary" onClick={() => void handleCopy()} disabled={busy}>
                Copy code
              </button>
            ) : (
              <button type="button" className="btn btn--secondary" onClick={() => void handleShowCode()} disabled={busy}>
                Show join code
              </button>
            )}
            <button type="button" className="btn btn--secondary" onClick={() => void handleDisconnect()} disabled={busy}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="settings__hint">
            Sync this space to a second phone. Enable it here, then paste the join code into the
            other device. Everything still lives on each device — sync keeps the two copies merged.
          </p>
          {joinCode ? (
            <>
              <p className="settings__hint">
                On the other phone: Settings → Sync across devices → Join a space, then paste this
                code. Anyone with it can read and write this space.
              </p>
              <code className="settings__code">{joinCode}</code>
            </>
          ) : null}
          <div className="settings__buttons">
            <button type="button" className="btn btn--primary" onClick={() => void handleEnable()} disabled={busy}>
              Enable sync
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setShowJoin((v) => !v)}
              disabled={busy}
            >
              Join a space
            </button>
          </div>
          {joinCode ? (
            <div className="settings__buttons" style={{ marginTop: 'var(--space-2)' }}>
              <button type="button" className="btn btn--secondary" onClick={() => void handleCopy()} disabled={busy}>
                Copy code
              </button>
            </div>
          ) : null}
          {showJoin ? (
            <div className="settings__join">
              <textarea
                className="settings__textarea"
                placeholder="Paste the join code from the other phone"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                rows={3}
              />
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleJoin()}
                disabled={busy || codeInput.trim() === ''}
              >
                Join
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default function SettingsScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const space = useSpaceStore((s) => s.space);
  const initSpace = useSpaceStore((s) => s.init);
  const updateSettings = useSpaceStore((s) => s.updateSettings);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void initSpace();
  }, [initSpace]);

  const handleExport = useCallback(async () => {
    if (!space) return;
    setBusy(true);
    try {
      downloadSpaceFile(await exportSpace(space.id));
      toast.show({ message: 'Exported', variant: 'success' });
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Export failed',
        variant: 'error',
      });
    } finally {
      setBusy(false);
    }
  }, [space, toast]);

  const handleImport = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        const parsed = await readSpaceFile(file);
        const result = await importSpaceFile(parsed);
        toast.show({
          message: `Merged ${result.applied} change${result.applied === 1 ? '' : 's'}`,
          variant: 'success',
        });
        // Reload so the merged state is what's on screen.
        window.location.reload();
      } catch (err) {
        toast.show({
          message: err instanceof Error ? err.message : 'Import failed',
          variant: 'error',
        });
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  if (!space) {
    return (
      <div className="settings__loading">
        <Spinner size={32} />
      </div>
    );
  }

  const s = space.settings;

  return (
    <div className="settings">
      <header className="settings__header">
        <button
          type="button"
          className="settings__back tap-target"
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <Icon name="chevron" size={20} rotate={90} />
        </button>
        <h1 className="settings__title">Settings</h1>
      </header>

      <section className="settings__section">
        <h2 className="settings__section-title">Household</h2>
        <label className="settings__row">
          <span>People</span>
          <input
            type="number"
            min={1}
            max={12}
            value={s.householdSize}
            onChange={(e) =>
              void updateSettings({ householdSize: Math.max(1, Number(e.target.value) || 1) })
            }
          />
        </label>
        <label className="settings__row">
          <span>Week starts</span>
          <select
            value={s.weekStartsOn}
            onChange={(e) => void updateSettings({ weekStartsOn: Number(e.target.value) as 0 | 1 })}
          >
            <option value={1}>Monday</option>
            <option value={0}>Sunday</option>
          </select>
        </label>
        <label className="settings__row">
          <span>Default view</span>
          <select
            value={s.defaultPlanRange}
            onChange={(e) =>
              void updateSettings({ defaultPlanRange: Number(e.target.value) as 7 | 14 })
            }
          >
            <option value={7}>Week</option>
            <option value={14}>Fortnight</option>
          </select>
        </label>
        <label className="settings__row">
          <span>Measurements</span>
          <select
            value={s.dialect}
            onChange={(e) =>
              void updateSettings({ dialect: e.target.value as MeasurementDialect })
            }
          >
            {DIALECTS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="settings__section">
        <h2 className="settings__section-title">Shopping list order</h2>
        <p className="settings__hint">
          Drag isn't wired up yet — this is the order aisles appear in.
        </p>
        <ol className="settings__aisles">
          {s.aisleOrder
            // Several categories share one aisle label; collapse the repeats so
            // this reads as the list of aisles the shopper actually sees.
            .filter((a, i, arr) => i === 0 || AISLE_LABELS[a] !== AISLE_LABELS[arr[i - 1]!])
            .map((a) => (
              <li key={a}>{AISLE_LABELS[a]}</li>
            ))}
        </ol>
      </section>

      <SyncSection spaceId={space.id} />

      <section className="settings__section">
        <h2 className="settings__section-title">Move to another device</h2>
        <p className="settings__hint">
          Everything is stored in this browser only. Export a file here and import it on the other
          phone to hand the plan over. Importing merges rather than overwrites — newer edits win, so
          importing an old file can't clobber newer changes.
        </p>
        <div className="settings__buttons">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void handleExport()}
            disabled={busy}
          >
            Export space
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            Import space
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImport(file);
          }}
        />
      </section>
    </div>
  );
}
