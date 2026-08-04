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
import { makeSlotId, type MealType, type Placement, type Recipe } from '@/domain/types';
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
  const startSession = useShoppingStore((s) => s.startSession);

  const [rangeDays, setRangeDays] = useState<7 | 14>(7);
  const [weekAnchor, setWeekAnchor] = useState<ISODate>(todayISO());
  const [picker, setPicker] = useState<SlotTarget | null>(null);
  const [query, setQuery] = useState('');
  const [leftoverFor, setLeftoverFor] = useState<Placement | null>(null);
  const [generating, setGenerating] = useState(false);

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

  const handleGenerate = useCallback(async () => {
    if (!space) return;
    setGenerating(true);
    try {
      await startSession(space.id, weekStart, rangeEnd);
      navigate('/shop');
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not build the list',
        variant: 'error',
      });
    } finally {
      setGenerating(false);
    }
  }, [space, weekStart, rangeEnd, startSession, navigate, toast]);

  const today = todayISO();

  if (!space) {
    return (
      <div className="plan-loading">
        <Spinner size={32} />
      </div>
    );
  }

  return (
    <div className="plan">
      <header className="plan__header">
        <div className="plan__title-row">
          <h1 className="plan__title">Plan</h1>
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
        <nav className="plan__nav" aria-label="Change week">
          <button
            type="button"
            className="plan__nav-btn tap-target"
            onClick={() => setWeekAnchor(addDays(weekStart, -7))}
            aria-label="Previous week"
          >
            <Icon name="chevron" size={20} rotate={90} />
          </button>
          <button type="button" className="plan__nav-today" onClick={() => setWeekAnchor(today)}>
            {fromISODate(weekStart).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}
            {' – '}
            {fromISODate(rangeEnd).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}
          </button>
          <button
            type="button"
            className="plan__nav-btn tap-target"
            onClick={() => setWeekAnchor(addDays(weekStart, 7))}
            aria-label="Next week"
          >
            <Icon name="chevron" size={20} rotate={270} />
          </button>
        </nav>
      </header>

      {planLoading && placements.length === 0 ? (
        <div className="plan-loading">
          <Spinner size={28} />
        </div>
      ) : (
        <div className="plan__board">
          {days.map((date) => (
            <section
              key={date}
              className={`plan__day ${date === today ? 'is-today' : ''}`}
              aria-label={fromISODate(date).toDateString()}
            >
              <div className="plan__day-heading">
                <span className="plan__day-name">{formatDayHeading(date).day}</span>
                <span className="plan__day-num">{formatDayHeading(date).num}</span>
              </div>
              <div className="plan__day-slots">
                {mealTypes.map((mealType) => {
                  const slot = makeSlotId(date, mealType);
                  const items = bySlot.get(slot) ?? [];
                  return (
                    <div key={mealType} className="plan__slot">
                      <span className="plan__slot-label">{MEAL_LABEL[mealType]}</span>
                      {items.map((p) => (
                        <MealCard
                          key={p.id}
                          placement={p}
                          recipe={p.recipeId ? recipeById.get(p.recipeId) : undefined}
                          onOpen={() => p.recipeId && navigate(`/recipes/${p.recipeId}`)}
                          onMultiplier={(m) => void setMultiplier(p.id, m)}
                          onLeftovers={() => setLeftoverFor(p)}
                          onRemove={() => void removePlacement(p.id)}
                        />
                      ))}
                      <button
                        type="button"
                        className="plan__empty tap-target"
                        onClick={() => setPicker({ date, mealType })}
                      >
                        <Icon name="plus" size={18} />
                        <span>
                          {items.length > 0 ? 'Add another' : `Add ${MEAL_LABEL[mealType].toLowerCase()}`}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="sticky-cta">
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={() => void handleGenerate()}
          disabled={plannedCount === 0 || generating}
        >
          {generating ? (
            <Spinner size={18} label="Building list" />
          ) : (
            <>
              <Icon name="basket" size={20} />
              {plannedCount === 0
                ? 'Plan a meal to build a list'
                : `Generate shopping list (${plannedCount})`}
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

      {/* Leftovers target picker */}
      <BottomSheet
        open={leftoverFor !== null}
        onClose={() => setLeftoverFor(null)}
        title="Leftovers go to…"
      >
        <div className="leftover-picker">
          <p className="leftover-picker__hint">
            The slot you pick fills itself, and adds nothing to the shopping list.
          </p>
          <ul className="leftover-picker__list">
            {days
              .flatMap((date) => mealTypes.map((mealType) => ({ date, mealType })))
              .filter(({ date, mealType }) => {
                if (!leftoverFor) return false;
                if (date < leftoverFor.date) return false;
                if (date === leftoverFor.date && mealType === leftoverFor.mealType) return false;
                return true;
              })
              .map(({ date, mealType }) => (
                <li key={`${date}#${mealType}`}>
                  <button
                    type="button"
                    className="list-row"
                    onClick={async () => {
                      const source = leftoverFor;
                      setLeftoverFor(null);
                      if (!source) return;
                      await setLeftovers(source.id, date, mealType);
                      toast.show({ message: 'Leftovers planned', variant: 'success' });
                    }}
                  >
                    <span>
                      {fromISODate(date).toLocaleDateString(undefined, {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                    <span className="leftover-picker__meal">{MEAL_LABEL[mealType]}</span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      </BottomSheet>
    </div>
  );
}

interface MealCardProps {
  placement: Placement;
  recipe: Recipe | undefined;
  onOpen: () => void;
  onMultiplier: (m: number) => void;
  onLeftovers: () => void;
  onRemove: () => void;
}

function MealCard({ placement, recipe, onOpen, onMultiplier, onLeftovers, onRemove }: MealCardProps) {
  const isLeftover = placement.source === 'leftover';
  const name = recipe?.name ?? placement.recipeNameSnapshot ?? placement.freeText ?? 'Meal';

  const items = isLeftover
    ? [{ key: 'remove', label: 'Remove', icon: 'trash' as const, onSelect: onRemove, destructive: true }]
    : [
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

  return (
    <LongPressMenu items={items}>
      {(trigger) => (
        <button
          type="button"
          className={`meal-card ${isLeftover ? 'meal-card--leftover' : ''}`}
          onClick={onOpen}
          {...trigger}
        >
          {isLeftover && <Icon name="leftovers" size={16} />}
          <span className="meal-card__name">
            {isLeftover ? `Leftovers: ${name}` : name}
          </span>
          {!isLeftover && placement.multiplier !== 1 && (
            <span className="chip chip--neutral meal-card__mult">
              {formatMultiplier(placement.multiplier)}
            </span>
          )}
          {/* Deleted from the library but still planned — the plan is the truth. */}
          {!isLeftover && placement.recipeId && !recipe && (
            <span className="chip chip--neutral">removed</span>
          )}
        </button>
      )}
    </LongPressMenu>
  );
}
