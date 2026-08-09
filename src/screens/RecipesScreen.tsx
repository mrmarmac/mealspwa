/** The recipe library: a searchable, tag-filterable card grid. */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RECIPE_TAGS, type RecipeTag } from '@/domain/types';
import { filterByTags } from '@/domain/recipeFilter';
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
  const [selectedTags, setSelectedTags] = useState<RecipeTag[]>([]);

  useEffect(() => {
    void initSpace();
  }, [initSpace]);

  useEffect(() => {
    if (space) void load(space.id);
  }, [space, load]);

  const toggleTag = (tag: RecipeTag) =>
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const results = useMemo(() => {
    const bySearch = query.trim() ? search(query) : recipes;
    const byTag = filterByTags(bySearch, selectedTags);
    return byTag.filter((r) => !r.archived);
  }, [query, recipes, search, selectedTags]);

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
        <div className="recipes__search-row">
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
          <div className="recipes__actions">
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
        <div className="recipes__tags" role="group" aria-label="Filter by tag">
          {RECIPE_TAGS.map((tag) => {
            const active = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={`recipes__tag ${active ? 'is-active' : ''}`}
                onClick={() => toggleTag(tag)}
                aria-pressed={active}
              >
                {tag}
              </button>
            );
          })}
        </div>
      </header>

      {results.length === 0 ? (
        <EmptyState
          icon="book"
          title={recipes.length === 0 ? 'No recipes yet' : 'Nothing matches that'}
          description={
            recipes.length === 0
              ? 'Save one from a link, or paste one in.'
              : selectedTags.length > 0
                ? 'Try removing a tag, or a different word.'
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
            const needsReview = r.ingredients.filter((l) => !l.isHeader && l.confidence < 0.55).length;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className="recipe-card"
                  onClick={() => navigate(`/recipes/${r.id}`, { state: { from: '/recipes' } })}
                >
                  <span className="recipe-card__name">{r.name}</span>
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
