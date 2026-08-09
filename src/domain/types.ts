/**
 * The domain model. This file is the contract every layer imports; treat changes
 * to it as breaking changes across the whole app.
 */
import type { ClientId, HLC, Id, ISODate, ISODateTime } from './primitives';

// ---------------------------------------------------------------------------
// Sync envelope
// ---------------------------------------------------------------------------

export type EntityKind =
  | 'space'
  | 'recipe'
  | 'placement'
  | 'shoppingSession'
  | 'shoppingTick'
  | 'manualItem'
  | 'itemMeta'
  | 'packSize';

/** Every synced row carries this. Conflict resolution reads only `updatedAt`. */
export interface Syncable {
  id: Id;
  kind: EntityKind;
  spaceId: Id;
  createdAt: ISODateTime;
  /** The ordering field. See hlc.ts. */
  updatedAt: HLC;
  lastWriterClientId: ClientId;
  /** Tombstone. null = live. Deletes are ordinary writes, not a special case. */
  deletedAt: HLC | null;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Space
// ---------------------------------------------------------------------------

export type MealType = 'lunch' | 'dinner';

/** A tablespoon is 15 ml in the UK/US and 20 ml in Australia; a cup is 250 ml in
 *  the UK/AU and 240 ml in the US. Getting this wrong is a 33% error on a list. */
export type MeasurementDialect = 'metric-uk' | 'metric-au' | 'us';

export interface SpaceSettings {
  weekStartsOn: 0 | 1;
  /** Ordered — drives the rows of the plan board. */
  mealTypes: MealType[];
  householdSize: number;
  dialect: MeasurementDialect;
  /** Drag-to-reorder, so the list matches the user's actual supermarket loop. */
  aisleOrder: AisleCategory[];
  hidePantryStaples: boolean;
  defaultPlanRange: 7 | 14;
  /** Parser version the library was last reparsed against. */
  parserVersion: number;
}

export interface Space extends Syncable {
  kind: 'space';
  name: string;
  settings: SpaceSettings;
}

// ---------------------------------------------------------------------------
// Units and quantities
// ---------------------------------------------------------------------------

export type UnitKind = 'mass' | 'volume' | 'count' | 'imprecise' | 'none';

export type MassUnit = 'mg' | 'g' | 'kg' | 'oz' | 'lb';
export type VolumeUnit =
  | 'ml' | 'l' | 'tsp' | 'tbsp' | 'cup' | 'floz' | 'pint' | 'quart' | 'gallon';
/** Container nouns are counted, not measured: a tin of chickpeas and a tin of
 *  coconut milk are both "1 tin" but hold different amounts. */
export type ContainerUnit =
  | 'can' | 'jar' | 'packet' | 'bottle' | 'block' | 'tub' | 'box' | 'bag'
  | 'punnet' | 'carton' | 'bunch' | 'head' | 'clove' | 'sprig' | 'stick'
  | 'stalk' | 'slice' | 'sheet' | 'rasher' | 'fillet';
export type CountUnit = 'each' | ContainerUnit;
export type ImpreciseUnit =
  | 'pinch' | 'dash' | 'splash' | 'handful' | 'glug' | 'knob' | 'drizzle';

export type UnitCode = MassUnit | VolumeUnit | CountUnit | ImpreciseUnit;

export interface Quantity {
  /** Non-range quantities have low === high. */
  low: number;
  high: number;
  isRange: boolean;
  /** True when this number came from a conversion or an assumed pack size
   *  rather than from the recipe text. Renders as '≈'. */
  approx: boolean;
  /** '⅓', '1 1/2', '1-2' — kept so we can redisplay faithfully. */
  raw: string;
}

/** '2 x 450g can' => quantity 2, container 'can', size 450 g. */
export interface PackSize {
  size: number;
  unit: MassUnit | VolumeUnit;
  container: ContainerUnit;
  /** True when filled from remembered/seeded defaults, not from the text. */
  assumed: boolean;
  /** '(400g drained weight)' */
  drainedSize: number | null;
}

/** A parenthetical equivalent: '⅓ cup (65g)' gives {65, 'g'}. Preferred over the
 *  primary unit when merging, because it lets us avoid guessing densities. */
export interface AltMeasure {
  quantity: number;
  unit: UnitCode;
  unitKind: UnitKind;
}

export type Qualifier =
  | 'optional'
  | 'to-taste'
  | 'to-serve'
  | 'to-garnish'
  | 'divided'
  | 'per-person'
  | 'plus-more'
  | 'pantry-staple';

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export interface ParsedIngredientLine {
  /** Stable within a recipe: hash of the normalised raw text plus an occurrence
   *  index. Editing the text changes the key, which correctly drops a stale
   *  override rather than silently reapplying it to different content. */
  lineKey: string;
  rawText: string;

  isHeader: boolean;
  /** Inherited from the nearest preceding header ('For the dressing'). */
  section: string | null;

  quantity: Quantity | null;
  unit: UnitCode | null;
  unitKind: UnitKind;
  packSize: PackSize | null;

  /** Display form: 'cherry tomatoes'. */
  item: string;
  /** Merge key: 'cherry tomato'. Exact equality is the ONLY merge rule. */
  itemKey: string;
  itemAliases: string[];
  /** '(pumpkin seed kernels)' — excluded from itemKey. */
  clarifier: string | null;
  note: string | null;
  qualifiers: Qualifier[];
  alternates: AltMeasure[];

  confidence: number;
  confidenceReasons: string[];
  parserVersion: number;
  overridden: boolean;
  /** Never contributes to the shopping list (water, 'to serve' garnishes). */
  excluded: boolean;
}

/** A user correction to a parse. Survives re-parsing under a newer parser. */
export interface IngredientOverride {
  lineKey: string;
  quantity?: { low: number; high: number } | null;
  unit?: UnitCode | null;
  item?: string;
  itemKey?: string;
  note?: string | null;
  qualifiers?: Qualifier[];
  excluded?: boolean;
  editedAt: ISODateTime;
  editedByClientId: ClientId;
}

export interface PhotoRef {
  /** sha256 of the bytes — content-addressed, so binary never conflicts. */
  blobId: Id;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

export interface Recipe extends Syncable {
  kind: 'recipe';
  name: string;
  sourceUrl: string | null;
  sourceDomain: string | null;
  photo: PhotoRef | null;

  /** Source of truth. Never auto-rewritten. */
  ingredientsRaw: string;
  method: string | null;
  baseServings: number | null;

  /** Derived cache of ingredientsRaw; recomputed when it or parserVersion changes. */
  ingredients: ParsedIngredientLine[];
  parserVersion: number;
  /** User truth, applied on top of the derived cache. */
  overrides: IngredientOverride[];
  /** Detected per recipe; falls back to the space default. */
  dialect: MeasurementDialect | null;

  tags: string[];
  timesPlanned: number;
  lastPlannedOn: ISODate | null;
  archived: boolean;
}

/** The fixed vocabulary of recipe tags. Deliberately closed: a short, shared
 *  set keeps filtering meaningful (free-form tags fragment into synonyms). */
export const RECIPE_TAGS = ['pasta', 'bake', 'easy', 'salad', 'soup', 'spicy', 'meat'] as const;
export type RecipeTag = (typeof RECIPE_TAGS)[number];

/** Kept forever after a hard purge so a stale placement can still show a name. */
export interface RecipeStub {
  id: Id;
  name: string;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** Slots are addresses, not entities — an empty slot is never persisted. */
export type SlotId = `${ISODate}#${MealType}`;

export const makeSlotId = (date: ISODate, meal: MealType): SlotId => `${date}#${meal}`;

export function parseSlotId(s: SlotId): { date: ISODate; mealType: MealType } {
  const [date, mealType] = s.split('#') as [ISODate, MealType];
  return { date, mealType };
}

export type PlacementSource = 'cook' | 'leftover';

/** The menu offers 0.5/1/2/3; the model allows anything positive. */
export type Multiplier = number;

export interface Placement extends Syncable {
  kind: 'placement';
  date: ISODate;
  mealType: MealType;
  /** Denormalised `${date}#${mealType}` — the index we actually query by. */
  slot: SlotId;
  position: number;

  recipeId: Id | null;
  /** Snapshot taken at write time so the board still renders if a placement
   *  arrives from a peer before its recipe does. */
  recipeNameSnapshot: string;
  freeText: string | null;

  source: PlacementSource;
  /** Set only when source === 'leftover': the cook placement that produced it. */
  leftoverOf: Id | null;

  /** Meaningful only when source === 'cook'. */
  multiplier: Multiplier;
  notes: string | null;
}

/** Derived, never stored. */
export interface LeftoverLink {
  sourcePlacementId: Id;
  sourceSlot: SlotId;
  targetPlacementId: Id;
  targetSlot: SlotId;
  recipeName: string;
  /** Informational only — never affects the merge. */
  portionShare: number;
  /** Source missing, tombstoned, or now scheduled after the target. */
  broken: boolean;
}

// ---------------------------------------------------------------------------
// Shopping
// ---------------------------------------------------------------------------

export type AisleCategory =
  | 'produce'
  | 'bakery'
  | 'meat-seafood'
  | 'deli'
  | 'dairy-eggs'
  | 'chilled-plant'
  | 'frozen'
  | 'cans-jars'
  | 'dry-goods'
  | 'oils-sauces'
  | 'herbs-spices'
  | 'drinks'
  | 'household'
  | 'other'
  | 'staples';

export interface ShoppingSession extends Syncable {
  kind: 'shoppingSession';
  fromDate: ISODate;
  toDate: ISODate;
  status: 'active' | 'done';
  startedAt: ISODateTime;
}

/**
 * A tick is user intent about a physical act, so it is stored separately from
 * the derived list. Keyed on itemKey ALONE — not quantity, not recipe, not date
 * — which is what lets the plan change mid-shop without losing ticks.
 */
export interface ShoppingTick extends Syncable {
  kind: 'shoppingTick';
  /** Deterministic: `${sessionId}:${lineKey}`, so two devices ticking the same
   *  row converge under LWW instead of creating duplicates. */
  id: Id;
  sessionId: Id;
  lineKey: string;

  ticked: boolean;
  tickedAt: ISODateTime | null;

  /**
   * Struck off by hand for this shop. Optional, so rows written before this
   * field existed read as not-removed with no migration.
   *
   * Session-scoped by construction — the tick id carries the session — so
   * removing a standing manual item hides it for this shop only, and it comes
   * back on the next one. Kept independent of `ticked`: an item can be both in
   * the trolley and struck off the list, and clearing `ticked` here would
   * throw away that fact and make undo lossy.
   */
  removed?: boolean;

  /** Snapshot at tick time — powers "quantity grew since you ticked". Still
   *  written and still synced, though nothing reads the display fields since
   *  no-longer-needed rows started leaving the list outright. */
  quantityAtTick: number | null;
  unitAtTick: UnitCode | null;
  displayNameAtTick: string;
  displayQuantityAtTick: string;
}

export interface ManualItem extends Syncable {
  kind: 'manualItem';
  /** null = a standing item that appears on every shop. */
  sessionId: Id | null;
  rawText: string;
  parsed: ParsedIngredientLine;
  lineKey: string;
}

/** Learned facts about an item, shared across the space. */
export interface ItemMeta extends Syncable {
  kind: 'itemMeta';
  /** id is `item:${itemKey}` — deterministic. */
  itemKey: string;
  displayName: string | null;
  category: AisleCategory | null;
  pantryStaple: boolean;
  /** Lemons and onions can be bought by the half; tins cannot. */
  halvable: boolean;
  /** User-confirmed merge, e.g. 'tomato puree' -> 'tomato paste'. */
  aliasOf: string | null;
}

export interface PackSizeMemory extends Syncable {
  kind: 'packSize';
  /** id is `pack:${itemKey}:${container}`. */
  itemKey: string;
  container: ContainerUnit;
  size: number;
  unit: MassUnit | VolumeUnit;
  /** Seeded default vs. user-confirmed. */
  assumed: boolean;
}

// --- derived shopping types (computed, never persisted) ---------------------

export interface LineComponent {
  placementId: Id;
  recipeId: Id | null;
  recipeName: string;
  date: ISODate;
  mealType: MealType;
  /** The recipe line's lineKey — deep-links "fix this parse". */
  lineKey: string;
  rawText: string;
  /** effectiveScale(placement) × (per-person ? householdSize : 1) */
  scale: number;
  quantity: Quantity | null;
  unit: UnitCode | null;
  unitKind: UnitKind;
  packSize: PackSize | null;
  qualifiers: Qualifier[];
  confidence: number;
  source: 'recipe' | 'manual';
  dialect: MeasurementDialect;
}

export interface MergedQuantity {
  unitKind: UnitKind;
  unit: UnitCode;
  /** Exact and unrounded. Only formatQuantity may put this on screen. */
  value: number;
  isRange: boolean;
  rangeLow: number;
  approx: boolean;
}

export interface ShoppingLine {
  /** === itemKey. */
  lineKey: string;
  displayName: string;
  category: AisleCategory;
  /** More than one entry means incompatible units, rendered as 'A + B'. */
  totals: MergedQuantity[];
  displayQuantity: string;
  /** Provenance: which recipes and days produced this number. */
  components: LineComponent[];
  confidence: number;
  needsReview: boolean;
  hasAssumption: boolean;
  isToTaste: boolean;
  isPantryStaple: boolean;
  isOptional: boolean;
  manual: boolean;

  ticked: boolean;
  /** Ticked, but the quantity has grown materially since. */
  reopened: boolean;
  addedSinceStart: boolean;
}

export interface DerivedShoppingList {
  sessionId: Id;
  groups: { category: AisleCategory; lines: ShoppingLine[] }[];
  counts: { total: number; ticked: number; needsReview: number };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// The supermarket-loop order the list is grouped by. Several fine-grained
// categories share a shopper-facing aisle name (see AISLE_LABELS) — chilled
// plant-based items sit under "Dairy & eggs", the deli counter under "Meat &
// fish", dry goods + cans + oils + spices all under "Pasta, grains, tins,
// sauces, spices", and household under "Other" — so the list shows one header
// per aisle even though categorisation stays fine-grained under the hood.
// Consecutive same-label groups are merged where they're rendered. `staples`
// ("Check you have") is always pinned last.
export const DEFAULT_AISLE_ORDER: AisleCategory[] = [
  'produce',
  'dairy-eggs',
  'chilled-plant',
  'meat-seafood',
  'deli',
  'bakery',
  'dry-goods',
  'cans-jars',
  'oils-sauces',
  'herbs-spices',
  'drinks',
  'frozen',
  'household',
  'other',
  'staples',
];

export const AISLE_LABELS: Record<AisleCategory, string> = {
  produce: 'Fruit & vegetables',
  'dairy-eggs': 'Dairy & eggs',
  'chilled-plant': 'Dairy & eggs',
  'meat-seafood': 'Meat & fish',
  deli: 'Meat & fish',
  bakery: 'Bakery',
  'dry-goods': 'Pasta, grains, tins, sauces, spices',
  'cans-jars': 'Pasta, grains, tins, sauces, spices',
  'oils-sauces': 'Pasta, grains, tins, sauces, spices',
  'herbs-spices': 'Pasta, grains, tins, sauces, spices',
  drinks: 'Snacks & drinks',
  frozen: 'Frozen',
  household: 'Other',
  other: 'Other',
  staples: 'Check you have',
};

export const DEFAULT_SETTINGS: SpaceSettings = {
  weekStartsOn: 1,
  mealTypes: ['lunch', 'dinner'],
  householdSize: 2,
  dialect: 'metric-uk',
  aisleOrder: DEFAULT_AISLE_ORDER,
  hidePantryStaples: true,
  defaultPlanRange: 7,
  parserVersion: 1,
};

export const SCHEMA_VERSION = 1;
