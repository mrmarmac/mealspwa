/**
 * The shopping list.
 *
 * This is the screen the whole app is judged on, so it is built around one
 * rule: never show a number without being able to explain it. Every row opens
 * to its provenance (which recipes, which days, which raw lines), anything
 * inferred rather than read is marked, and a row that could not be summed
 * honestly says so instead of guessing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fromISODate } from '@/domain/primitives';
import {
  AISLE_LABELS,
  type ContainerUnit,
  type MassUnit,
  type ShoppingLine,
  type VolumeUnit,
} from '@/domain/types';
import { useSpaceStore } from '@/store/useSpaceStore';
import { useShoppingStore } from '@/store/useShoppingStore';
import { BottomSheet } from '@/shell/BottomSheet';
import { EmptyState } from '@/shell/EmptyState';
import { Icon } from '@/shell/Icon';
import { Spinner } from '@/shell/Spinner';
import { useToast } from '@/shell/Toast';
import './ShopScreen.css';

/** Offered when we need a pack size, in the sizes UK shelves actually carry. */
const COMMON_PACK_SIZES: { size: number; unit: MassUnit | VolumeUnit }[] = [
  { size: 200, unit: 'g' },
  { size: 400, unit: 'g' },
  { size: 400, unit: 'ml' },
  { size: 500, unit: 'g' },
  { size: 570, unit: 'g' },
  { size: 660, unit: 'g' },
];

export default function ShopScreen() {
  const navigate = useNavigate();
  const toast = useToast();

  const space = useSpaceStore((s) => s.space);
  const initSpace = useSpaceStore((s) => s.init);
  const session = useShoppingStore((s) => s.session);
  const list = useShoppingStore((s) => s.derivedList);
  const loading = useShoppingStore((s) => s.loading);
  const loadActive = useShoppingStore((s) => s.loadActive);
  const clearActiveSession = useShoppingStore((s) => s.clearActiveSession);
  const toggleTick = useShoppingStore((s) => s.toggleTick);
  const addManualItem = useShoppingStore((s) => s.addManualItem);
  const removeLine = useShoppingStore((s) => s.removeLine);
  const restoreLine = useShoppingStore((s) => s.restoreLine);
  const setPackSize = useShoppingStore((s) => s.setPackSize);

  const [detail, setDetail] = useState<ShoppingLine | null>(null);
  const [packPrompt, setPackPrompt] = useState<ShoppingLine | null>(null);
  const [manualText, setManualText] = useState('');
  const [showStaples, setShowStaples] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    void initSpace();
  }, [initSpace]);

  useEffect(() => {
    if (space) void loadActive(space.id);
  }, [space, loadActive]);

  const handleClear = useCallback(async () => {
    if (!space) return;
    setConfirmClear(false);
    await clearActiveSession(space.id);
    toast.show({ message: 'List cleared', variant: 'success' });
  }, [space, clearActiveSession, toast]);

  /** No confirmation here: the button already sits two taps deep behind the
   *  row's chevron, and the undo toast is a better safety net than a sheet. */
  const handleRemove = useCallback(
    async (line: ShoppingLine) => {
      // Closed before the await, because `detail` is a snapshot of the line —
      // once the list recomputes, the sheet would be describing a row that no
      // longer exists. Same reason `handlePackSize` clears its prompt first.
      setDetail(null);
      await removeLine(line.lineKey);
      toast.show({
        message: `Removed ${line.displayName}`,
        action: { label: 'Undo', onClick: () => void restoreLine(line.lineKey) },
        // A toast carrying an action stays put by default. That is right for
        // the update prompt, wrong for this one — it would sit over the list
        // for the rest of the shop.
        duration: 6000,
      });
    },
    [removeLine, restoreLine, toast],
  );

  const handleAddManual = useCallback(async () => {
    const text = manualText.trim();
    if (!text || !session) return;
    setManualText('');
    await addManualItem(text, session.id);
  }, [manualText, session, addManualItem]);

  /** The pack size the user picks is remembered for every future list. */
  const handlePackSize = useCallback(
    async (line: ShoppingLine, size: number, unit: MassUnit | VolumeUnit) => {
      if (!space) return;
      const container = line.components.find((c) => c.packSize)?.packSize?.container
        ?? (line.totals.find((t) => t.unitKind === 'count')?.unit as ContainerUnit | undefined)
        ?? ('can' as ContainerUnit);
      setPackPrompt(null);
      await setPackSize(space.id, line.lineKey, container, size, unit, false);
      toast.show({ message: `Remembered: ${size}${unit} per ${container}`, variant: 'success' });
    },
    [space, setPackSize, toast],
  );

  const groups = useMemo(() => list?.groups.filter((g) => g.lines.length > 0) ?? [], [list]);
  const staples = useMemo(() => groups.find((g) => g.category === 'staples'), [groups]);
  // Several fine-grained categories map to one shopper-facing aisle name (see
  // AISLE_LABELS), so fold consecutive groups that share a label into a single
  // section — the list stays ordered by DEFAULT_AISLE_ORDER, which keeps those
  // categories adjacent. Lines are re-sorted by name across the merge so a
  // folded aisle reads as one alphabetised list, not two concatenated ones.
  const aisles = useMemo(() => {
    const merged: { key: string; label: string; lines: ShoppingLine[] }[] = [];
    for (const g of groups) {
      if (g.category === 'staples') continue;
      const label = AISLE_LABELS[g.category];
      const last = merged[merged.length - 1];
      if (last && last.label === label) last.lines.push(...g.lines);
      else merged.push({ key: g.category, label, lines: [...g.lines] });
    }
    for (const a of merged) {
      a.lines.sort(
        (x, y) => x.displayName.localeCompare(y.displayName) || x.lineKey.localeCompare(y.lineKey),
      );
    }
    return merged;
  }, [groups]);

  if (!space || (loading && !list)) {
    return (
      <div className="shop__loading">
        <Spinner size={32} />
      </div>
    );
  }

  if (!session || !list) {
    return (
      <div className="shop">
        <EmptyState
          icon="basket"
          title="No list yet"
          description="Plan your meals, then build the list from the plan board."
          action={
            <div className="shop__empty-actions">
              {/* The list is always built from the week you are looking at on
                  the plan board, so that is the only place it can start. */}
              <button type="button" className="btn btn--primary" onClick={() => navigate('/plan')}>
                Go to plan
              </button>
              {/* Settings has no tab of its own; this is its entry point, and it
                  lives only in the empty state so it disappears once a list is
                  built. */}
              <button
                type="button"
                className="shop__settings tap-target"
                onClick={() => navigate('/settings')}
                aria-label="Settings"
              >
                <Icon name="settings" size={20} />
              </button>
            </div>
          }
        />
      </div>
    );
  }

  const remaining = list.counts.total - list.counts.ticked;

  return (
    <div className="shop">
      <header className="shop__header">
        <div className="shop__title-row">
          <h1 className="shop__title">Shop</h1>
          <span className="shop__count">
            {remaining === 0 ? 'All done' : `${remaining} left`}
          </span>
          {/* Clears the list only. The week's plan is untouched, so the same
              list can be rebuilt from the plan board. */}
          <button
            type="button"
            className="shop__clear tap-target"
            onClick={() => setConfirmClear(true)}
            aria-label="Clear this list"
          >
            <Icon name="trash" size={20} />
          </button>
        </div>
        <p className="shop__range">
          {fromISODate(session.fromDate).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
          })}
          {' – '}
          {fromISODate(session.toDate).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
          })}
          {list.counts.needsReview > 0 && (
            <> · <span className="shop__review-count">{list.counts.needsReview} to check</span></>
          )}
        </p>
      </header>

      {aisles.map((group) => (
        <section key={group.key} className="shop__group">
          <h2 className="shop__group-title">{group.label}</h2>
          <ul className="shop__lines">
            {group.lines.map((line) => (
              <ShopRow
                key={line.lineKey}
                line={line}
                onToggle={() => void toggleTick(line.lineKey)}
                onDetail={() => setDetail(line)}
                onFixPack={() => setPackPrompt(line)}
              />
            ))}
          </ul>
        </section>
      ))}

      {/* Things you probably already own, kept out of the way but never hidden. */}
      {staples && (
        <section className="shop__group">
          <button
            type="button"
            className="shop__staples-toggle tap-target"
            onClick={() => setShowStaples((v) => !v)}
            aria-expanded={showStaples}
          >
            <Icon name="chevron" size={18} rotate={showStaples ? 0 : 270} />
            {AISLE_LABELS.staples} ({staples.lines.length})
          </button>
          {showStaples && (
            <ul className="shop__lines">
              {staples.lines.map((line) => (
                <ShopRow
                  key={line.lineKey}
                  line={line}
                  onToggle={() => void toggleTick(line.lineKey)}
                  onDetail={() => setDetail(line)}
                  onFixPack={() => setPackPrompt(line)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="shop__add">
        <input
          type="text"
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAddManual();
          }}
          placeholder="Add something else (e.g. 2 pints milk)"
          aria-label="Add an item to the list"
        />
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void handleAddManual()}
          disabled={!manualText.trim()}
        >
          Add
        </button>
      </div>

      {/* Provenance: where every number came from. */}
      <BottomSheet
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.displayName}
      >
        {detail && (
          <div className="provenance">
            <p className="provenance__total">{detail.displayQuantity}</p>
            {detail.hasAssumption && (
              <p className="provenance__note">
                Some of this is estimated from an assumed pack size.{' '}
                <button
                  type="button"
                  className="provenance__link"
                  onClick={() => {
                    setPackPrompt(detail);
                    setDetail(null);
                  }}
                >
                  Set the real size
                </button>
              </p>
            )}
            {detail.needsReview && (
              <p className="provenance__note">
                These couldn't be added together, so they're listed separately.
              </p>
            )}
            <ul className="provenance__list">
              {detail.components.map((c, i) => (
                <li key={`${c.placementId}-${c.lineKey}-${i}`} className="provenance__item">
                  <div className="provenance__raw">{c.rawText}</div>
                  <div className="provenance__meta">
                    {c.recipeName}
                    {/* A hand-added item has no meal behind it. The date and
                        mealType it carries are placeholders invented by
                        `collectComponents` to satisfy the non-null fields, so
                        printing them would attach it to a slot it never had. */}
                    {c.source !== 'manual' && (
                      <>
                        {' · '}
                        {fromISODate(c.date).toLocaleDateString(undefined, {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                        })}
                        {' '}
                        {c.mealType}
                      </>
                    )}
                    {c.scale === 0 && ' · leftovers, adds nothing'}
                    {c.scale !== 0 && c.scale !== 1 && ` · ×${c.scale}`}
                  </div>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="provenance__remove tap-target"
              onClick={() => void handleRemove(detail)}
            >
              <Icon name="trash" size={18} />
              Remove from list
            </button>
          </div>
        )}
      </BottomSheet>

      {/* Clearing the list leaves the plan alone, so it can be rebuilt. */}
      <BottomSheet open={confirmClear} onClose={() => setConfirmClear(false)} hideClose>
        <div className="shop__confirm">
          <p>
            This clears the shopping list, including everything you have ticked. Your
            meal plan stays as it is, so you can build the list again from the plan
            board.
          </p>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => void handleClear()}
          >
            Clear list
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--block"
            onClick={() => setConfirmClear(false)}
          >
            Keep it
          </button>
        </div>
      </BottomSheet>

      {/* Teaching the app a pack size makes every future list better. */}
      <BottomSheet
        open={packPrompt !== null}
        onClose={() => setPackPrompt(null)}
        title={packPrompt ? `What size are your ${packPrompt.displayName}?` : undefined}
      >
        {packPrompt && (
          <div className="pack-prompt">
            <p className="pack-prompt__hint">
              We'll remember this and use it every time from now on.
            </p>
            <div className="pack-prompt__options">
              {COMMON_PACK_SIZES.map(({ size, unit }) => (
                <button
                  key={`${size}${unit}`}
                  type="button"
                  className="chip chip--neutral pack-prompt__option"
                  onClick={() => void handlePackSize(packPrompt, size, unit)}
                >
                  {size}
                  {unit}
                </button>
              ))}
            </div>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}

interface ShopRowProps {
  line: ShoppingLine;
  onToggle: () => void;
  onDetail: () => void;
  onFixPack: () => void;
}

function ShopRow({ line, onToggle, onDetail, onFixPack }: ShopRowProps) {
  return (
    <li className={`shop__row ${line.ticked ? 'is-ticked' : ''}`}>
      {/* The tick is the whole row's left half: one thumb, in an aisle, moving. */}
      <button
        type="button"
        className="shop__tick"
        onClick={onToggle}
        aria-pressed={line.ticked}
        aria-label={`${line.ticked ? 'Untick' : 'Tick'} ${line.displayName}`}
      >
        <span className="shop__checkbox" aria-hidden="true">
          {line.ticked && <Icon name="check" size={16} />}
        </span>
        <span className="shop__row-text">
          <span className="shop__row-name">{line.displayName}</span>
          {line.displayQuantity && (
            <span className="shop__row-qty">{line.displayQuantity}</span>
          )}
        </span>
      </button>

      <span className="shop__row-flags">
        {line.reopened && (
          <button type="button" className="chip chip--warning" onClick={onDetail}>
            more needed
          </button>
        )}
        {line.needsReview && (
          <button type="button" className="chip chip--warning" onClick={onFixPack}>
            check
          </button>
        )}
        {line.isOptional && <span className="chip chip--neutral">optional</span>}
        <button
          type="button"
          className="shop__info tap-target"
          onClick={onDetail}
          aria-label={`More for ${line.displayName}`}
        >
          <Icon name="chevron" size={16} rotate={270} />
        </button>
      </span>
    </li>
  );
}
