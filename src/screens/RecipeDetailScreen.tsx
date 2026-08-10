/**
 * A single recipe: ingredients as parsed (grouped by the recipe's own section
 * headings) plus the method. Low-confidence lines are visibly flagged here,
 * because this is where a bad parse is cheapest to notice and fix.
 */
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { RECIPE_TAGS, type ParsedIngredientLine } from '@/domain/types';
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

  useEffect(() => {
    void initSpace();
  }, [initSpace]);

  useEffect(() => {
    if (space) void load(space.id);
  }, [space, load]);

  const recipe = useMemo(() => recipes.find((r) => r.id === id), [recipes, id]);
  const sections = useMemo(() => (recipe ? groupBySection(recipe.ingredients) : []), [recipe]);
  // Read-only here: show only the tags actually assigned, in the vocabulary's
  // own order, and ignore any legacy free-form tag. Changing tags is done in
  // the editor (Capture screen), reached via the edit button in the header.
  const tags = useMemo(
    () => RECIPE_TAGS.filter((t) => (recipe?.tags ?? []).includes(t)),
    [recipe],
  );

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

      {/* Read-only: only the tags assigned to this recipe are shown. To change
          them, open the editor with the edit button in the header above. */}
      {tags.length > 0 && (
        <ul className="detail__tags" aria-label="Recipe tags">
          {tags.map((tag) => (
            <li key={tag} className="detail__tag">
              {tag}
            </li>
          ))}
        </ul>
      )}

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
