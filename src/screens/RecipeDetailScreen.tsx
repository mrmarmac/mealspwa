/**
 * A single recipe: ingredients as parsed (grouped by the recipe's own section
 * headings) plus the method. Low-confidence lines are visibly flagged here,
 * because this is where a bad parse is cheapest to notice and fix.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ParsedIngredientLine } from '@/domain/types';
import { useSpaceStore } from '@/store/useSpaceStore';
import { useRecipeStore } from '@/store/useRecipeStore';
import { BottomSheet } from '@/shell/BottomSheet';
import { Icon } from '@/shell/Icon';
import { Spinner } from '@/shell/Spinner';
import { useToast } from '@/shell/Toast';
import './RecipeDetailScreen.css';

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
  const toast = useToast();

  const space = useSpaceStore((s) => s.space);
  const initSpace = useSpaceStore((s) => s.init);
  const recipes = useRecipeStore((s) => s.recipes);
  const loaded = useRecipeStore((s) => s.loaded);
  const load = useRecipeStore((s) => s.load);
  const deleteRecipe = useRecipeStore((s) => s.deleteRecipe);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void initSpace();
  }, [initSpace]);

  useEffect(() => {
    if (space) void load(space.id);
  }, [space, load]);

  const recipe = useMemo(() => recipes.find((r) => r.id === id), [recipes, id]);
  const sections = useMemo(() => (recipe ? groupBySection(recipe.ingredients) : []), [recipe]);

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
        <button type="button" className="btn btn--secondary" onClick={() => navigate('/recipes')}>
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
          onClick={() => navigate('/recipes')}
          aria-label="Back to recipes"
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
            <Icon name="camera" size={20} />
          </button>
          <button
            type="button"
            className="detail__icon-btn tap-target"
            onClick={() => setConfirmDelete(true)}
            aria-label="Delete recipe"
          >
            <Icon name="trash" size={20} />
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

      <BottomSheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${recipe.name}?`}
      >
        <div className="detail__confirm">
          {/* The plan is the truth: deleting from the library never silently
              rewrites meals you already planned. */}
          <p>
            Any meals you've already planned with it stay on the board, and its ingredients stay on
            your shopping list.
          </p>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={async () => {
              setConfirmDelete(false);
              await deleteRecipe(recipe.id);
              toast.show({ message: `Deleted ${recipe.name}`, variant: 'success' });
              navigate('/recipes');
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--block"
            onClick={() => setConfirmDelete(false)}
          >
            Keep it
          </button>
        </div>
      </BottomSheet>
    </div>
  );
}
