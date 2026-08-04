/** The recipe library: a searchable card grid. */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSpaceStore } from '@/store/useSpaceStore';
import { useRecipeStore } from '@/store/useRecipeStore';
import { EmptyState } from '@/shell/EmptyState';
import { Icon } from '@/shell/Icon';
import { Spinner } from '@/shell/Spinner';
import './RecipesScreen.css';

export default function RecipesScreen() {
  const navigate = useNavigate();
  const space = useSpaceStore((s) => s.space);
  const initSpace = useSpaceStore((s) => s.init);
  const recipes = useRecipeStore((s) => s.recipes);
  const loaded = useRecipeStore((s) => s.loaded);
  const load = useRecipeStore((s) => s.load);
  const search = useRecipeStore((s) => s.search);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void initSpace();
  }, [initSpace]);

  useEffect(() => {
    if (space) void load(space.id);
  }, [space, load]);

  const results = useMemo(() => {
    const list = query.trim() ? search(query) : recipes;
    return list.filter((r) => !r.archived);
  }, [query, recipes, search]);

  if (!space || !loaded) {
    return (
      <div className="recipes__loading">
        <Spinner size={32} />
      </div>
    );
  }

  return (
    <div className="recipes">
      <header className="recipes__header">
        <div className="recipes__title-row">
          <h1 className="recipes__title">Recipes</h1>
          <div className="recipes__actions">
            <button
              type="button"
              className="recipes__icon-btn tap-target"
              onClick={() => navigate('/import')}
              aria-label="Import recipes"
            >
              <Icon name="share" size={20} />
            </button>
            <button
              type="button"
              className="recipes__icon-btn recipes__icon-btn--primary tap-target"
              onClick={() => navigate('/capture')}
              aria-label="Add a recipe"
            >
              <Icon name="plus" size={20} />
            </button>
          </div>
        </div>
        <label className="recipes__search">
          <Icon name="search" size={18} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or ingredient"
            aria-label="Search recipes"
            autoComplete="off"
          />
        </label>
      </header>

      {results.length === 0 ? (
        <EmptyState
          icon="book"
          title={recipes.length === 0 ? 'No recipes yet' : 'Nothing matches that'}
          description={
            recipes.length === 0
              ? 'Save one from a link, or paste one in.'
              : 'Try a different word.'
          }
          action={
            recipes.length === 0 ? (
              <button type="button" className="btn btn--primary" onClick={() => navigate('/capture')}>
                Add a recipe
              </button>
            ) : undefined
          }
        />
      ) : (
        <ul className="recipes__grid">
          {results.map((r) => {
            const count = r.ingredients.filter((l) => !l.isHeader).length;
            const needsReview = r.ingredients.filter((l) => !l.isHeader && l.confidence < 0.55).length;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className="recipe-card"
                  onClick={() => navigate(`/recipes/${r.id}`)}
                >
                  <span className="recipe-card__name">{r.name}</span>
                  <span className="recipe-card__meta">
                    {count} ingredient{count === 1 ? '' : 's'}
                    {r.sourceDomain && ` · ${r.sourceDomain}`}
                  </span>
                  {needsReview > 0 && (
                    <span className="chip chip--warning recipe-card__flag">
                      {needsReview} to check
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
