/**
 * Aisle categorisation. Resolution order matters: the user's own override
 * always wins, then the curated tables, then keyword rules with negative
 * guards, and only then 'other'. The guards are the point — '*milk' is dairy
 * unless it is coconut/oat/almond/soy/rice milk, which lives with the dry
 * goods, and 'frozen *' beats everything.
 */
import type { AisleCategory, ItemMeta } from '@/domain/types';
import categoriesJson from '@/parser/lexicon/categories.json';
import { applySynonyms, FOODS, singulariseHead } from '@/parser/canonical';

interface KeywordRule {
  match: string;
  where: string;
  category: string;
  not?: string[];
}

const EXACT = categoriesJson.exact as Record<string, string>;
const RULES = categoriesJson.keywordRules as KeywordRule[];
const VALID = new Set<AisleCategory>([
  'produce', 'bakery', 'meat-seafood', 'deli', 'dairy-eggs', 'chilled-plant',
  'frozen', 'cans-jars', 'dry-goods', 'oils-sauces', 'herbs-spices', 'drinks',
  'household', 'other', 'staples',
]);

function asCategory(s: string | null | undefined): AisleCategory | null {
  return s && VALID.has(s as AisleCategory) ? (s as AisleCategory) : null;
}

export function categoriseItem(itemKey: string, meta?: ItemMeta | null): AisleCategory {
  // (1) user override
  const override = asCategory(meta?.category ?? null);
  if (override) return override;

  const key = itemKey.trim().toLowerCase();
  if (!key) return 'other';

  // (2) exact itemKey
  const exact = asCategory(EXACT[key]);
  if (exact) return exact;

  // (2b) the food lexicon carries a category for every entry
  const direct = asCategory(FOODS[key]);
  if (direct) return direct;

  const tokens = key.split(/\s+/).filter(Boolean);

  // (4a) 'frozen *' overrides everything below
  if (tokens[0] === 'frozen') return 'frozen';

  // (3) head-noun match
  const head = tokens[tokens.length - 1];
  if (head !== undefined) {
    const headKey = applySynonyms(singulariseHead(head));
    const byHead = asCategory(FOODS[headKey] ?? FOODS[head]);
    if (byHead) {
      // A guard on the head noun still applies: 'oat milk' is not dairy.
      const guarded = applyKeywordRules(tokens);
      if (guarded) return guarded;
      return byHead;
    }
  }

  // (4) keyword rules
  const rule = applyKeywordRules(tokens);
  if (rule) return rule;

  // (5)
  return 'other';
}

function applyKeywordRules(tokens: string[]): AisleCategory | null {
  const last = tokens[tokens.length - 1];
  const prev = tokens.length > 1 ? tokens[tokens.length - 2] : undefined;
  for (const rule of RULES) {
    const hit =
      rule.where === 'prefix'
        ? tokens[0] === rule.match
        : rule.where === 'suffix'
          ? last === rule.match
          : tokens.includes(rule.match);
    if (!hit) continue;
    if (rule.not && rule.not.some((n) => tokens.includes(n) || prev === n)) continue;
    const cat = asCategory(rule.category);
    if (cat) return cat;
  }
  return null;
}
