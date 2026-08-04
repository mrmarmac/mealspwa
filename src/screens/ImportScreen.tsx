/**
 * Bulk import from a CSV export (the Google Sheet this library started as) or
 * from pasted text. Always previews before writing — an import that silently
 * duplicates 39 recipes is worse than no import at all.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseRecipeCsv, parseRecipePaste, type ImportPreview } from '@/import/csv';
import { useSpaceStore } from '@/store/useSpaceStore';
import { useRecipeStore } from '@/store/useRecipeStore';
import { Icon } from '@/shell/Icon';
import { Spinner } from '@/shell/Spinner';
import { useToast } from '@/shell/Toast';
import './ImportScreen.css';

type Mode = 'csv' | 'paste';

export default function ImportScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const space = useSpaceStore((s) => s.space);
  const recipes = useRecipeStore((s) => s.recipes);
  const saveRecipe = useRecipeStore((s) => s.saveRecipe);

  const [mode, setMode] = useState<Mode>('csv');
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [skipDuplicates, setSkipDuplicates] = useState(true);

  const existingNames = useMemo(() => recipes.map((r) => r.name), [recipes]);

  const preview: ImportPreview | null = useMemo(() => {
    if (!text.trim()) return null;
    return mode === 'csv' ? parseRecipeCsv(text, existingNames) : parseRecipePaste(text);
  }, [text, mode, existingNames]);

  const duplicates = useMemo(
    () => new Set(preview?.duplicateOfExistingName ?? []),
    [preview],
  );

  const toImport = useMemo(() => {
    if (!preview) return [];
    return skipDuplicates ? preview.rows.filter((r) => !duplicates.has(r.name)) : preview.rows;
  }, [preview, skipDuplicates, duplicates]);

  const handleFile = useCallback(async (file: File) => {
    setMode('csv');
    setText(await file.text());
  }, []);

  const handleImport = useCallback(async () => {
    if (!space || toImport.length === 0) return;
    setImporting(true);
    let ok = 0;
    try {
      for (const row of toImport) {
        await saveRecipe({
          spaceId: space.id,
          name: row.name,
          ingredientsRaw: row.ingredientsRaw,
          method: row.method,
          sourceUrl: row.sourceUrl,
        });
        ok += 1;
      }
      toast.show({ message: `Imported ${ok} recipe${ok === 1 ? '' : 's'}`, variant: 'success' });
      navigate('/recipes');
    } catch (err) {
      toast.show({
        message: `Imported ${ok}, then failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        variant: 'error',
      });
    } finally {
      setImporting(false);
    }
  }, [space, toImport, saveRecipe, toast, navigate]);

  return (
    <div className="import">
      <header className="import__header">
        <button
          type="button"
          className="import__back tap-target"
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <Icon name="x" size={20} />
        </button>
        <h1 className="import__title">Import</h1>
      </header>

      <div className="import__modes" role="group" aria-label="Import source">
        <button
          type="button"
          className={`import__mode ${mode === 'csv' ? 'is-active' : ''}`}
          onClick={() => setMode('csv')}
          aria-pressed={mode === 'csv'}
        >
          Spreadsheet
        </button>
        <button
          type="button"
          className={`import__mode ${mode === 'paste' ? 'is-active' : ''}`}
          onClick={() => setMode('paste')}
          aria-pressed={mode === 'paste'}
        >
          One recipe
        </button>
      </div>

      {mode === 'csv' && (
        <>
          <button
            type="button"
            className="btn btn--secondary btn--block"
            onClick={() => fileInput.current?.click()}
          >
            Choose a CSV file
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
            className="visually-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
        </>
      )}

      <label className="import__field">
        <span className="import__label">
          {mode === 'csv' ? 'Or paste the spreadsheet' : 'Paste a recipe'}
        </span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={
            mode === 'csv'
              ? 'Dish,Ingredients,Method,Link\n…'
              : 'Creamy butter beans\n1 jar (570g) butter beans\n2 cloves of garlic\n\nMethod\nHeat the oil…'
          }
        />
      </label>

      {preview && (
        <section className="import__preview">
          <h2 className="import__preview-title">
            {preview.rows.length} recipe{preview.rows.length === 1 ? '' : 's'} found
          </h2>

          {preview.warnings.length > 0 && (
            <ul className="import__warnings">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {duplicates.size > 0 && (
            <label className="import__dupes">
              <input
                type="checkbox"
                checked={skipDuplicates}
                onChange={(e) => setSkipDuplicates(e.target.checked)}
              />
              <span>
                Skip {duplicates.size} that you already have
              </span>
            </label>
          )}

          <ul className="import__rows">
            {preview.rows.map((row, i) => {
              const dupe = duplicates.has(row.name);
              return (
                <li key={`${row.name}-${i}`} className={`import__row ${dupe && skipDuplicates ? 'is-skipped' : ''}`}>
                  <span className="import__row-name">{row.name}</span>
                  <span className="import__row-meta">
                    {row.ingredientsRaw.split('\n').filter((l) => l.trim()).length} lines
                    {dupe && ' · already saved'}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="sticky-cta">
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={() => void handleImport()}
          disabled={toImport.length === 0 || importing}
        >
          {importing ? (
            <Spinner size={18} label="Importing" />
          ) : (
            `Import ${toImport.length || ''} recipe${toImport.length === 1 ? '' : 's'}`.trim()
          )}
        </button>
      </div>
    </div>
  );
}
