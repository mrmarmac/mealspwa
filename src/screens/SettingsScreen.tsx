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
import { useSpaceStore } from '@/store/useSpaceStore';
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
          {s.aisleOrder.map((a) => (
            <li key={a}>{AISLE_LABELS[a]}</li>
          ))}
        </ol>
      </section>

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
