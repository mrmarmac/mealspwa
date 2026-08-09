/**
 * The plan board — the app's default route and its return loop.
 *
 * Layout is empty-slot-first: a gap is a full-width, obviously-tappable target,
 * because the job on opening the app is "fill the holes", not "admire what's
 * already planned". A placed meal is a compact card; the empty slot next to it
 * is not.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  addDays,
  fromISODate,
  startOfWeek,
  todayISO,
  type ISODate,
} from '@/domain/primitives';
import {
  makeSlotId,
  type MealType,
  type Placement,
  type Recipe,
  type ShoppingSession,
} from '@/domain/types';
import { clampWeekStart, planWeekBounds, retentionCutoff } from '@/domain/planWindow';
import { isEligibleLeftoverSlot } from './planSlots';
import { useSpaceStore } from '@/store/useSpaceStore';
import { useRecipeStore } from '@/store/useRecipeStore';
import { usePlanStore } from '@/store/usePlanStore';
import { useShoppingStore } from '@/store/useShoppingStore';
import { BottomSheet } from '@/shell/BottomSheet';
import { LongPressMenu } from '@/shell/LongPressMenu';
import { Icon } from '@/shell/Icon';
import { Spinner } from '@/shell/Spinner';
import { useToast } from '@/shell/Toast';
import './PlanScreen.css';

const MULTIPLIERS = [0.5, 1, 2, 3];

/** "3 – 9 Aug", for naming which week a list belongs to. */
function formatRange(from: ISODate, to: ISODate): string {
  const opts = { month: 'short', day: 'numeric' } as const;
  return `${fromISODate(from).toLocaleDateString(undefined, opts)} – ${fromISODate(to).toLocaleDateString(undefined, opts)}`;
}

/** Playful rotating labels for the build-list action — a fresh one each time
 *  the screen mounts or the week is cleared. */
const GENERATE_NAMES = ['Combine & Dine', 'Lettuce Shop', 'Craft Cart', 'Stock & Roll'];
function pickGenerateName(): string {
  return GENERATE_NAMES[Math.floor(Math.random() * GENERATE_NAMES.length)]!;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MEAL_LABEL: Record<MealType, string> = { lunch: 'Lunch', dinner: 'Dinner' };

function formatDayHeading(date: ISODate): { day: string; num: string } {
  const d = fromISODate(date);
  return { day: DAY_NAMES[d.getDay()]!, num: String(d.getDate()) };
}

function formatMultiplier(m: number): string {
  return m === 0.5 ? '×½' : `×${m}`;
}

interface SlotTarget {
  date: ISODate;
  mealType: MealType;
}

export default function PlanScreen() {
  const navigate = useNavigate();
  const toast = useToast();

  const space = useSpaceStore((s) => s.space);
  const initSpace = useSpaceStore((s) => s.init);
  const recipes = useRecipeStore((s) => s.recipes);
  const loadRecipes = useRecipeStore((s) => s.load);
  const searchRecipes = useRecipeStore((s) => s.search);
  const placements = usePlanStore((s) => s.placements);
  const planLoading = usePlanStore((s) => s.loading);
  const loadPlan = usePlanStore((s) => s.load);
  const place = usePlanStore((s) => s.place);
  const removePlacement = usePlanStore((s) => s.remove);
  const setMultiplier = usePlanStore((s) => s.setMultiplier);
  const setLeftovers = usePlanStore((s) => s.setLeftovers);
  const clearRange = usePlanStore((s) => s.clearRange);
  const pruneBefore = usePlanStore((s) => s.pruneBefore);
  const startSession = useShoppingStore((s) => s.startSession);
  const peekActiveSession = useShoppingStore((s) => s.peekActiveSession);
  const clearActiveSession = useShoppingStore((s) => s.clearActiveSession);

  const [rangeDays, setRangeDays] = useState<7 | 14>(7);
  const [weekAnchor, setWeekAnchor] = useState<ISODate>(todayISO());
  const [picker, setPicker] = useState<SlotTarget | null>(null);
  const [query, setQuery] = useState('');
  const [leftoverFor, setLeftoverFor] = useState<Placement | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  /** The open list, held while we ask whether to replace it with this week's. */
  const [confirmReplace, setConfirmReplace] = useState<ShoppingSession | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateName, setGenerateName] = useState(pickGenerateName);
  // Days whose Dinner slot should show an extra empty slot, revealed via the
  // day-heading "Add another meal" menu (a slot is no longer auto-offered once
  // one is filled). Consumed when the extra slot gets a meal.
  const [extraDinner, setExtraDinner] = useState<ReadonlySet<ISODate>>(() => new Set());

  useEffect(() => {
    void initSpace();
  }, [initSpace]);

  const weekStart = useMemo(
    () => (space ? startOfWeek(weekAnchor, space.settings.weekStartsOn) : weekAnchor),
    [space, weekAnchor],
  );
  const rangeEnd = useMemo(() => addDays(weekStart, rangeDays - 1), [weekStart, rangeDays]);

  useEffect(() => {
    if (!space) return;
    setRangeDays(space.settings.defaultPlanRange);
  }, [space]);

  useEffect(() => {
    if (!space) return;
    void loadRecipes(space.id);
    void loadPlan(space.id, weekStart, rangeEnd);
  }, [space, weekStart, rangeEnd, loadRecipes, loadPlan]);

  // 2-week retention: drop plan data older than the window on entry.
  useEffect(() => {
    if (!space) return;
    void pruneBefore(space.id, retentionCutoff(todayISO(), space.settings.weekStartsOn));
  }, [space, pruneBefore]);

  const days = useMemo(
    () => Array.from({ length: rangeDays }, (_, i) => addDays(weekStart, i)),
    [weekStart, rangeDays],
  );

  const mealTypes = space?.settings.mealTypes ?? (['lunch', 'dinner'] as MealType[]);

  /** Placements bucketed by slot, so the board is a lookup rather than a scan. */
  const bySlot = useMemo(() => {
    const map = new Map<string, Placement[]>();
    for (const p of placements) {
      if (p.deletedAt !== null) continue;
      const list = map.get(p.slot);
      if (list) list.push(p);
      else map.set(p.slot, [p]);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [placements]);

  const recipeById = useMemo(() => {
    const map = new Map<string, Recipe>();
    for (const r of recipes) map.set(r.id, r);
    return map;
  }, [recipes]);

  const plannedCount = useMemo(
    () => placements.filter((p) => p.deletedAt === null && p.source === 'cook').length,
    [placements],
  );

  const pickerResults = useMemo(() => {
    const list = query.trim() ? searchRecipes(query) : recipes;
    return list.filter((r) => !r.archived);
  }, [query, recipes, searchRecipes]);

  const handlePick = useCallback(
    async (recipe: Recipe) => {
      if (!space || !picker) return;
      const target = picker;
      setPicker(null);
      setQuery('');
      // The extra Dinner slot (if this was one) is now filled — retire it.
      if (target.mealType === 'dinner') {
        setExtraDinner((prev) => {
          if (!prev.has(target.date)) return prev;
          const next = new Set(prev);
          next.delete(target.date);
          return next;
        });
      }
      await place({
        spaceId: space.id,
        date: target.date,
        mealType: target.mealType,
        recipeId: recipe.id,
        recipeNameSnapshot: recipe.name,
        position: bySlot.get(makeSlotId(target.date, target.mealType))?.length ?? 0,
      });
    },
    [space, picker, place, bySlot],
  );

  const buildList = useCallback(
    async (replace: boolean) => {
      if (!space) return;
      setConfirmReplace(null);
      setGenerating(true);
      try {
        await startSession(space.id, weekStart, rangeEnd, replace ? { replace: true } : undefined);
        navigate('/shop');
      } catch (err) {
        toast.show({
          message: err instanceof Error ? err.message : 'Could not build the list',
          variant: 'error',
        });
      } finally {
        setGenerating(false);
      }
    },
    [space, weekStart, rangeEnd, startSession, navigate, toast],
  );

  const handleGenerate = useCallback(async () => {
    if (!space) return;
    // Read straight from the database: this screen never calls `loadActive`,
    // so the store's `session` is null on a cold start even when a list is
    // open, and the check below would silently never fire.
    const open = await peekActiveSession(space.id);
    if (open && (open.fromDate !== weekStart || open.toDate !== rangeEnd)) {
      setConfirmReplace(open);
      return;
    }
    // Same week (or no list yet): never `replace`, so rebuilding after a plan
    // edit keeps every tick the user has already made.
    await buildList(false);
  }, [space, weekStart, rangeEnd, peekActiveSession, buildList]);

  const today = todayISO();

  if (!space) {
    return (
      <div className="plan-loading">
        <Spinner size={32} />
      </div>
    );
  }

  const weekStartsOn = space.settings.weekStartsOn;
  const bounds = planWeekBounds(today, weekStartsOn);
  const atMin = weekStart <= bounds.min;
  const atMax = weekStart >= bounds.max;
  const leftoverMode = leftoverFor !== null;
  const hasPlacements = placements.some((p) => p.deletedAt === null);

  const goToWeek = (nextWeekStart: ISODate) =>
    setWeekAnchor(clampWeekStart(nextWeekStart, today, weekStartsOn));

  const revealExtraDinner = (date: ISODate) =>
    setExtraDinner((prev) => new Set(prev).add(date));

  const placeLeftover = async (date: ISODate, mealType: MealType) => {
    const source = leftoverFor;
    setLeftoverFor(null);
    if (!source) return;
    await setLeftovers(source.id, date, mealType);
    toast.show({ message: 'Leftovers planned', variant: 'success' });
  };

  const handleClear = async () => {
    setConfirmClear(false);
    await clearRange(space.id, weekStart, rangeEnd);
    await clearActiveSession(space.id);
    setGenerateName(pickGenerateName());
    toast.show({ message: 'Week cleared', variant: 'success' });
  };

  return (
    <div className="plan">
      <header className="plan__header">
        <div className="plan__title-row">
          <button
            type="button"
            className="plan__clear tap-target"
            onClick={() => setConfirmClear(true)}
            disabled={!hasPlacements}
            aria-label="Clear this week"
          >
            <Icon name="trash" size={18} />
          </button>
          <div className="plan__today-group">
            {/* Desktop-only week nav flanking the date range; on phones the nav
                lives beside the board instead (see .plan__week-nav). */}
            <button
              type="button"
              className="plan__header-nav plan__header-nav--prev"
              onClick={() => goToWeek(addDays(weekStart, -7))}
              disabled={atMin || leftoverMode}
              aria-label="Previous week"
            >
              <Icon name="chevron" size={20} rotate={90} />
            </button>
            <button
              type="button"
              className="plan__today"
              onClick={() => setWeekAnchor(today)}
              aria-label="Jump to this week"
            >
              {fromISODate(weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              {' – '}
              {fromISODate(rangeEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </button>
            <button
              type="button"
              className="plan__header-nav plan__header-nav--next"
              onClick={() => goToWeek(addDays(weekStart, 7))}
              disabled={atMax || leftoverMode}
              aria-label="Next week"
            >
              <Icon name="chevron" size={20} rotate={270} />
            </button>
          </div>
          <div className="plan__range" role="group" aria-label="Plan range">
            <button
              type="button"
              className={`plan__range-btn ${rangeDays === 7 ? 'is-active' : ''}`}
              onClick={() => setRangeDays(7)}
              aria-pressed={rangeDays === 7}
            >
              Week
            </button>
            <button
              type="button"
              className={`plan__range-btn ${rangeDays === 14 ? 'is-active' : ''}`}
              onClick={() => setRangeDays(14)}
              aria-pressed={rangeDays === 14}
            >
              Fortnight
            </button>
          </div>
        </div>
      </header>

      {leftoverMode && (
        <div className="plan__leftover-banner" role="status">
          <span>Tap a slot to send leftovers there</span>
          <button
            type="button"
            className="plan__leftover-cancel"
            onClick={() => setLeftoverFor(null)}
          >
            Cancel
          </button>
        </div>
      )}

      <div className="plan__body">
        <button
          type="button"
          className="plan__week-nav plan__week-nav--prev"
          onClick={() => goToWeek(addDays(weekStart, -7))}
          disabled={atMin || leftoverMode}
          aria-label="Previous week"
        >
          <Icon name="chevron" size={22} rotate={90} />
        </button>

        {planLoading && placements.length === 0 ? (
          <div className="plan-loading plan__board">
            <Spinner size={28} />
          </div>
        ) : (
          <div className={`plan__board ${leftoverMode ? 'is-placing-leftover' : ''}`}>
            {days.map((date) => (
            <section
              key={date}
              className={`plan__day ${date === today ? 'is-today' : ''}`}
              aria-label={fromISODate(date).toDateString()}
            >
              <LongPressMenu
                disabled={leftoverMode}
                items={[
                  {
                    key: 'add-another',
                    label: 'Add another meal',
                    icon: 'plus',
                    onSelect: () => revealExtraDinner(date),
                  },
                ]}
              >
                {(trigger) => (
                  <div className="plan__day-heading" {...trigger}>
                    <span className="plan__day-name">{formatDayHeading(date).day}</span>
                    <span className="plan__day-num">{formatDayHeading(date).num}</span>
                  </div>
                )}
              </LongPressMenu>
              <div className="plan__day-slots">
                {mealTypes.map((mealType) => {
                  const slot = makeSlotId(date, mealType);
                  const items = bySlot.get(slot) ?? [];
                  const eligible =
                    leftoverFor !== null && isEligibleLeftoverSlot(leftoverFor, date, mealType);
                  // Offer an empty add-slot when the slot is still empty, or when
                  // the day-heading menu has revealed an extra Dinner slot. No
                  // auto "Another" once a slot is filled.
                  const showEmpty =
                    items.length === 0 || (mealType === 'dinner' && extraDinner.has(date));
                  return (
                    <div key={mealType} className="plan__slot">
                      {items.map((p) => (
                        <MealCard
                          key={p.id}
                          placement={p}
                          recipe={p.recipeId ? recipeById.get(p.recipeId) : undefined}
                          disabled={leftoverMode}
                          onOpen={() =>
                            p.recipeId &&
                            navigate(`/recipes/${p.recipeId}`, { state: { from: '/plan' } })
                          }
                          onMultiplier={(m) => void setMultiplier(p.id, m)}
                          onLeftovers={() => setLeftoverFor(p)}
                          onRemove={() => void removePlacement(p.id)}
                        />
                      ))}
                      {leftoverMode ? (
                        eligible ? (
                          <button
                            type="button"
                            className="plan__place-leftover tap-target"
                            onClick={() => void placeLeftover(date, mealType)}
                          >
                            <Icon name="leftovers" size={16} />
                            <span>Place here</span>
                          </button>
                        ) : (
                          <span className="plan__slot-blocked" aria-hidden="true" />
                        )
                      ) : showEmpty ? (
                        <button
                          type="button"
                          className="plan__empty tap-target"
                          onClick={() => setPicker({ date, mealType })}
                        >
                          <Icon name="plus" size={18} />
                          <span>{MEAL_LABEL[mealType]}</span>
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          </div>
        )}

        <button
          type="button"
          className="plan__week-nav plan__week-nav--next"
          onClick={() => goToWeek(addDays(weekStart, 7))}
          disabled={atMax || leftoverMode}
          aria-label="Next week"
        >
          <Icon name="chevron" size={22} rotate={270} />
        </button>
      </div>

      <div className="plan__generate">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void handleGenerate()}
          disabled={plannedCount === 0 || generating}
        >
          {generating ? (
            <Spinner size={18} label="Building list" />
          ) : (
            <>
              <Icon name="basket" size={20} />
              {plannedCount === 0 ? (
                <>
                  <span className="plan__generate-label plan__generate-label--long">
                    Plan a meal to build a list
                  </span>
                  <span className="plan__generate-label plan__generate-label--short">
                    Plan meal to build list
                  </span>
                </>
              ) : (
                generateName
              )}
            </>
          )}
        </button>
      </div>

      {/* Recipe picker */}
      <BottomSheet
        open={picker !== null}
        onClose={() => {
          setPicker(null);
          setQuery('');
        }}
        title={
          picker
            ? `${MEAL_LABEL[picker.mealType]} · ${fromISODate(picker.date).toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'short',
              })}`
            : undefined
        }
        snapPoints={[0.5, 0.92]}
      >
        <div className="picker">
          <label className="picker__search">
            <Icon name="search" size={18} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your recipes"
              aria-label="Search recipes"
              autoComplete="off"
            />
          </label>
          {pickerResults.length === 0 ? (
            <div className="picker__empty">
              <p>{recipes.length === 0 ? 'No recipes yet.' : 'Nothing matches that.'}</p>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => {
                  setPicker(null);
                  navigate('/capture');
                }}
              >
                Add a recipe
              </button>
            </div>
          ) : (
            <ul className="picker__list">
              {pickerResults.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="list-row picker__row"
                    onClick={() => void handlePick(r)}
                  >
                    <span className="picker__row-name">{r.name}</span>
                    <span className="picker__row-meta">
                      {r.ingredients.filter((l) => !l.isHeader).length} ingredients
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </BottomSheet>

      {/* Replace-the-open-list confirmation. Only ever shown when the open list
          is for a different week — rebuilding the same week just reuses it. */}
      <BottomSheet open={confirmReplace !== null} onClose={() => setConfirmReplace(null)} hideClose>
        {confirmReplace && (
          <div className="plan__confirm">
            <p>
              A shopping list is already open for {formatRange(confirmReplace.fromDate, confirmReplace.toDate)}.
              Building one for {formatRange(weekStart, rangeEnd)} replaces it, and anything
              ticked on the open list is lost.
            </p>
            <button
              type="button"
              className="btn btn--primary btn--block"
              onClick={() => void buildList(true)}
            >
              Replace the list
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--block"
              onClick={() => setConfirmReplace(null)}
            >
              Keep it
            </button>
          </div>
        )}
      </BottomSheet>

      {/* Clear-week confirmation */}
      <BottomSheet open={confirmClear} onClose={() => setConfirmClear(false)} hideClose>
        <div className="plan__confirm">
          <p>This resets the plan and the shopping list.</p>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => void handleClear()}
          >
            Clear week
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
    </div>
  );
}

interface MealCardProps {
  placement: Placement;
  recipe: Recipe | undefined;
  /** While placing leftovers the board is a target picker, so existing cards
   *  are shown but inert (no open, no long-press menu). */
  disabled?: boolean;
  onOpen: () => void;
  onMultiplier: (m: number) => void;
  onLeftovers: () => void;
  onRemove: () => void;
}

function MealCard({
  placement,
  recipe,
  disabled = false,
  onOpen,
  onMultiplier,
  onLeftovers,
  onRemove,
}: MealCardProps) {
  const isLeftover = placement.source === 'leftover';
  const name = recipe?.name ?? placement.recipeNameSnapshot ?? placement.freeText ?? 'Meal';

  const cardContent = (
    <>
      {isLeftover && <Icon name="leftovers" size={16} />}
      <span className="meal-card__name">{isLeftover ? `Leftovers: ${name}` : name}</span>
      {!isLeftover && placement.multiplier !== 1 && (
        <span className="chip chip--neutral meal-card__mult">
          {formatMultiplier(placement.multiplier)}
        </span>
      )}
      {/* Deleted from the library but still planned — the plan is the truth. */}
      {!isLeftover && placement.recipeId && !recipe && (
        <span className="chip chip--neutral">removed</span>
      )}
    </>
  );

  if (disabled) {
    return (
      <div className={`meal-card meal-card--inert ${isLeftover ? 'meal-card--leftover' : ''}`}>
        {cardContent}
      </div>
    );
  }

  // Only offer "Go to recipe card" when there's actually a recipe behind this
  // placement (a free-text meal has none).
  const goToRecipe = placement.recipeId
    ? [{ key: 'open', label: 'Go to recipe card', icon: 'book' as const, onSelect: onOpen }]
    : [];

  const items = isLeftover
    ? [
        ...goToRecipe,
        { key: 'remove', label: 'Remove', icon: 'trash' as const, onSelect: onRemove, destructive: true },
      ]
    : [
        ...goToRecipe,
        ...MULTIPLIERS.map((m) => ({
          key: `x${m}`,
          label: `Cook ${formatMultiplier(m)}`,
          icon: 'multiply' as const,
          onSelect: () => onMultiplier(m),
          disabled: placement.multiplier === m,
        })),
        { key: 'leftovers', label: 'Makes leftovers…', icon: 'leftovers' as const, onSelect: onLeftovers },
        { key: 'remove', label: 'Remove', icon: 'trash' as const, onSelect: onRemove, destructive: true },
      ];

  // A tap/click opens this menu instead of navigating; "Go to recipe card"
  // above is now the way through to the recipe. Right-click / short tap do
  // nothing (see LongPressMenu's openOnClick).
  return (
    <LongPressMenu items={items} openOnClick>
      {(trigger) => (
        <button
          type="button"
          className={`meal-card ${isLeftover ? 'meal-card--leftover' : ''}`}
          {...trigger}
        >
          {cardContent}
        </button>
      )}
    </LongPressMenu>
  );
}
