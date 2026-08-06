/**
 * A single recipe: ingredients as parsed (grouped by the recipe's own section
 * headings) plus the method. Low-confidence lines are visibly flagged here,
 * because this is where a bad parse is cheapest to notice and fix.
 */
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { RECIPE_TAGS, type ParsedIngredientLine, type RecipeTag } from '@/domain/types';
import { useSpaceStore } from '@/store/useSpaceStore';
import { useRecipeStore } from '@/store/useRecipeStore';
import { Icon } from '@/shell/Icon';
import { Spinner } from '@/shell/Spinner';
import './RecipeDetailScreen.css';

/** Where "Back" should return to: the screen we arrived from (passed through
 *  router state), defaulting to the library for deep links / cold loads. */
export function backTarget(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' ? from : '/recipes';
}

/** Group parsed lines under their section heading, preserving order. */
function groupBySection(lines: ParsedIngredientLine[]) {
  const groups: { section: string | null; lines: ParsedIngredientLine[] }[] = [];
  for (const line of lines) {
    if (line.isHeader) continue;
    const section = line.section;
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.lines.push(line);
    else groups.push({ section, lines: [line] });
  }
  return groups;
}

export default function RecipeDetailScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const back = backTarget(location.state);

  const space = useSpaceStore((s) => s.space);
  const initSpace = useSpaceStore((s) => s.init);
  const recipes = useRecipeStore((s) => s.recipes);
  const loaded = useRecipeStore((s) => s.loaded);
  const load = useRecipeStore((s) => s.load);
  const setTags = useRecipeStore((s) => s.setTags);

  useEffect(() => {
    void initSpace();
  }, [initSpace]);

  useEffect(() => {
    if (space) void load(space.id);
  }, [space, load]);

  const recipe = useMemo(() => recipes.find((r) => r.id === id), [recipes, id]);
  const sections = useMemo(() => (recipe ? groupBySection(recipe.ingredients) : []), [recipe]);
  // Only the known vocabulary is toggleable; any legacy free-form tag is
  // ignored here rather than shown as an un-editable chip.
  const activeTags = useMemo(
    () =>
      new Set(
        (recipe?.tags ?? []).filter((t): t is RecipeTag =>
          (RECIPE_TAGS as readonly string[]).includes(t),
        ),
      ),
    [recipe],
  );

  const toggleTag = (tag: RecipeTag) => {
    if (!recipe) return;
    const next = new Set(activeTags);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    // Persist in the vocabulary's own order so tags read consistently.
    void setTags(
      recipe.id,
      RECIPE_TAGS.filter((t) => next.has(t)),
    );
  };

  if (!space || !loaded) {
    return (
      <div className="detail__loading">
        <Spinner size={32} />
      </div>
    );
  }

  if (!recipe) {
    return (
      <div className="detail">
        <p className="detail__missing">That recipe isn't here any more.</p>
        <button type="button" className="btn btn--secondary" onClick={() => navigate(back)}>
          Back to recipes
        </button>
      </div>
    );
  }

  return (
    <div className="detail">
      <header className="detail__header">
        <button
          type="button"
          className="detail__back tap-target"
          onClick={() => navigate(back)}
          aria-label="Back"
        >
          <Icon name="chevron" size={20} rotate={90} />
        </button>
        <div className="detail__actions">
          <button
            type="button"
            className="detail__icon-btn tap-target"
            onClick={() => navigate(`/capture?edit=${recipe.id}`)}
            aria-label="Edit recipe"
          >
            <Icon name="menu" size={20} />
          </button>
        </div>
      </header>

      <h1 className="detail__title">{recipe.name}</h1>
      {recipe.sourceUrl && (
        <a className="detail__source" href={recipe.sourceUrl} target="_blank" rel="noreferrer">
          <Icon name="link" size={16} />
          {recipe.sourceDomain ?? 'Source'}
        </a>
      )}

      {/* Tags are viewed and changed right here — no need to open the editor.
          Every tag in the vocabulary shows as a toggle; active ones are
          filled. */}
      <div className="detail__tags" role="group" aria-label="Recipe tags">
        {RECIPE_TAGS.map((tag) => {
          const active = activeTags.has(tag);
          return (
            <button
              key={tag}
              type="button"
              className={`detail__tag ${active ? 'is-active' : ''}`}
              onClick={() => toggleTag(tag)}
              aria-pressed={active}
            >
              {tag}
            </button>
          );
        })}
      </div>

      <section className="detail__section">
        <h2 className="detail__section-title">Ingredients</h2>
        {sections.map((group, gi) => (
          <div key={`${group.section ?? 'main'}-${gi}`} className="detail__group">
            {group.section && <h3 className="detail__group-title">{group.section}</h3>}
            <ul className="detail__ingredients">
              {group.lines.map((line) => (
                <li key={line.lineKey} className="detail__ingredient">
                  <span>{line.rawText}</span>
                  {line.confidence < 0.55 && (
                    <span className="chip chip--warning" title="We weren't sure how to read this">
                      unclear
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {recipe.method && (
        <section className="detail__section">
          <h2 className="detail__section-title">Method</h2>
          <p className="detail__method">{recipe.method}</p>
        </section>
      )}
    </div>
  );
}
