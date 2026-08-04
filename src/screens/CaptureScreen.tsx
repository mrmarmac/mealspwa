/**
 * Recipe capture.
 *
 * Paste-first by design. A browser cannot fetch most recipe pages (CORS), and
 * the optional worker only helps on recipe blogs — never on TikTok or
 * Instagram, which is where most of this library came from. So the paste box
 * is the main event and the fetch is an accelerator that fails silently.
 *
 * The parse preview under the box is the trust mechanism: you see how each line
 * was read at the moment you save it, which is when a mistake is cheapest to
 * catch.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { parseIngredientBlock } from '@/parser';
import { RECIPE_TAGS, type RecipeTag } from '@/domain/types';
import { useSpaceStore } from '@/store/useSpaceStore';
import { useRecipeStore } from '@/store/useRecipeStore';
import { fetchRecipeFromUrl } from '@/lib/fetcher';
import { Icon } from '@/shell/Icon';
import { Spinner } from '@/shell/Spinner';
import { useToast } from '@/shell/Toast';
import './CaptureScreen.css';

/** A shared URL often arrives as loose text; pull the first link out of it. */
function firstUrlIn(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

export default function CaptureScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();

  const space = useSpaceStore((s) => s.space);
  const initSpace = useSpaceStore((s) => s.init);
  const recipes = useRecipeStore((s) => s.recipes);
  const load = useRecipeStore((s) => s.load);
  const saveRecipe = useRecipeStore((s) => s.saveRecipe);

  const editId = params.get('edit');
  const [name, setName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [ingredientsRaw, setIngredientsRaw] = useState('');
  const [method, setMethod] = useState('');
  const [tags, setTags] = useState<RecipeTag[]>([]);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    void initSpace();
  }, [initSpace]);

  useEffect(() => {
    if (space) void load(space.id);
  }, [space, load]);

  // Prefill from an edit target, or from an OS share payload (?title/&text/&url).
  useEffect(() => {
    if (prefilled) return;
    if (editId) {
      const existing = recipes.find((r) => r.id === editId);
      if (!existing) return;
      setName(existing.name);
      setSourceUrl(existing.sourceUrl ?? '');
      setIngredientsRaw(existing.ingredientsRaw);
      setMethod(existing.method ?? '');
      setTags(
        existing.tags.filter((t): t is RecipeTag => (RECIPE_TAGS as readonly string[]).includes(t)),
      );
      setPrefilled(true);
      return;
    }
    const sharedTitle = params.get('title');
    const sharedText = params.get('text') ?? '';
    const sharedUrl = params.get('url') ?? firstUrlIn(sharedText);
    if (sharedTitle || sharedUrl || sharedText) {
      if (sharedTitle) setName(sharedTitle);
      if (sharedUrl) setSourceUrl(sharedUrl);
      // Only keep the shared text as ingredients if it isn't just the link.
      if (sharedText && sharedText.trim() !== sharedUrl) setIngredientsRaw(sharedText);
      setPrefilled(true);
    }
  }, [editId, recipes, params, prefilled]);

  /** Live parse of whatever is in the box right now. */
  const parsed = useMemo(
    () => (ingredientsRaw.trim() ? parseIngredientBlock(ingredientsRaw) : []),
    [ingredientsRaw],
  );
  const parsedLines = useMemo(() => parsed.filter((l) => !l.isHeader), [parsed]);
  const unclear = useMemo(() => parsedLines.filter((l) => l.confidence < 0.55), [parsedLines]);

  const handleFetch = useCallback(async () => {
    const url = sourceUrl.trim();
    if (!url) return;
    setFetching(true);
    const fetched = await fetchRecipeFromUrl(url);
    setFetching(false);
    if (!fetched) {
      toast.show({
        message: "Couldn't read that page — paste the ingredients instead",
      });
      return;
    }
    if (fetched.name && !name.trim()) setName(fetched.name);
    if (fetched.ingredientsRaw) setIngredientsRaw(fetched.ingredientsRaw);
    if (fetched.method && !method.trim()) setMethod(fetched.method);
    toast.show({ message: 'Filled in from the page', variant: 'success' });
  }, [sourceUrl, name, method, toast]);

  const handleSave = useCallback(async () => {
    if (!space || !name.trim() || !ingredientsRaw.trim()) return;
    setSaving(true);
    try {
      const saved = await saveRecipe({
        id: editId ?? undefined,
        spaceId: space.id,
        name: name.trim(),
        sourceUrl: sourceUrl.trim() || null,
        ingredientsRaw,
        method: method.trim() || null,
        tags,
      });
      toast.show({ message: `Saved ${saved.name}`, variant: 'success' });
      navigate(`/recipes/${saved.id}`);
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not save',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }, [space, name, sourceUrl, ingredientsRaw, method, tags, editId, saveRecipe, navigate, toast]);

  const toggleTag = (tag: RecipeTag) =>
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const canSave = name.trim().length > 0 && ingredientsRaw.trim().length > 0 && !saving;

  return (
    <div className="capture">
      <header className="capture__header">
        <button
          type="button"
          className="capture__back tap-target"
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <Icon name="x" size={20} />
        </button>
        <h1 className="capture__title">{editId ? 'Edit recipe' : 'Add recipe'}</h1>
      </header>

      <label className="capture__field">
        <span className="capture__label">Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Creamy butter beans"
          autoComplete="off"
        />
      </label>

      <div className="capture__field">
        <span className="capture__label">Tags</span>
        <div className="capture__tags" role="group" aria-label="Recipe tags">
          {RECIPE_TAGS.map((tag) => {
            const active = tags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={`capture__tag ${active ? 'is-active' : ''}`}
                onClick={() => toggleTag(tag)}
                aria-pressed={active}
              >
                {tag}
              </button>
            );
          })}
        </div>
      </div>

      <label className="capture__field">
        <span className="capture__label">Link (optional)</span>
        <div className="capture__link-row">
          <input
            type="url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://…"
            inputMode="url"
            autoComplete="off"
          />
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void handleFetch()}
            disabled={!sourceUrl.trim() || fetching}
          >
            {fetching ? <Spinner size={16} label="Fetching" /> : 'Try fetch'}
          </button>
        </div>
        <span className="capture__hint">
          Works on recipe blogs. TikTok and Instagram won't fetch — paste those.
        </span>
      </label>

      <label className="capture__field">
        <span className="capture__label">Ingredients</span>
        <textarea
          value={ingredientsRaw}
          onChange={(e) => setIngredientsRaw(e.target.value)}
          placeholder={'1 jar (570g) butter beans\n2 cloves of garlic\n1 tbsp olive oil'}
          rows={8}
        />
      </label>

      {parsedLines.length > 0 && (
        <section className="capture__preview">
          <h2 className="capture__preview-title">
            How we read it
            <span className="capture__preview-count">
              {parsedLines.length} line{parsedLines.length === 1 ? '' : 's'}
              {unclear.length > 0 && ` · ${unclear.length} unclear`}
            </span>
          </h2>
          <ul className="capture__parsed">
            {parsedLines.map((line) => (
              <li
                key={line.lineKey}
                className={`capture__parsed-row ${line.confidence < 0.55 ? 'is-unclear' : ''}`}
              >
                <span className="capture__parsed-qty">
                  {line.quantity
                    ? `${line.quantity.low}${line.quantity.isRange ? `–${line.quantity.high}` : ''}`
                    : '—'}
                </span>
                <span className="capture__parsed-unit">{line.unit ?? ''}</span>
                <span className="capture__parsed-item">{line.item || line.rawText}</span>
                {line.qualifiers.includes('optional') && (
                  <span className="chip chip--neutral">optional</span>
                )}
              </li>
            ))}
          </ul>
          {unclear.length > 0 && (
            <p className="capture__preview-note">
              Unclear lines still save — they just won't be added up on the shopping list until
              they're tidied.
            </p>
          )}
        </section>
      )}

      <label className="capture__field">
        <span className="capture__label">Method (optional)</span>
        <textarea
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          placeholder="Heat the oil, add the garlic…"
          rows={6}
        />
      </label>

      <div className="sticky-cta">
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={() => void handleSave()}
          disabled={!canSave}
        >
          {saving ? <Spinner size={18} label="Saving" /> : 'Save recipe'}
        </button>
      </div>
    </div>
  );
}
