/**
 * Every case below is a line shape that actually occurs in the user's library
 * (data/meal-list.csv). The table asserts only the fields that matter for that
 * shape, so a case reads as a claim about behaviour rather than a snapshot.
 */
import { describe, expect, it } from 'vitest';
import { parseLine } from '@/testdata/factories';
import { parseIngredientBlock, makeLineKey, PARSER_VERSION, applyOverrides } from './index';
import { fractionToNumber, parseQuantityPrefix, toFraction, wordToNumber } from './numbers';
import { normalizeUnicode, stripBullet } from './tokenize';
import { canonicaliseItem, similarity } from './canonical';
import { detectDialect, fromBase, lookupUnit, toBase } from './units';
import { band } from './confidence';
import { parsePack } from './containers';
import { classifyParenthetical } from './parentheticals';
import { matchSeasoning, splitItemAndNote } from './notes';

interface Case {
  raw: string;
  /** [low, high] */
  qty?: [number, number] | null;
  unit?: string | null;
  packSize?: { size: number; unit: string; container: string; drained?: number | null };
  item?: string;
  itemKey?: string;
  note?: string | RegExp | null;
  clarifier?: string | null;
  qualifiers?: string[];
  alternates?: [number, string][];
  isHeader?: boolean;
  confidenceBand?: 'high' | 'medium' | 'low';
  maxConfidence?: number;
  next?: string;
}

const CASES: Case[] = [
  // --- pack sizes and tins -------------------------------------------------
  {
    raw: '2 450g can chickpeas, drained & rinsed',
    qty: [2, 2],
    unit: 'can',
    packSize: { size: 450, unit: 'g', container: 'can' },
    itemKey: 'chickpea',
    note: /drained/,
    confidenceBand: 'high',
  },
  {
    raw: '1 (15.5 oz) can chickpeas, rinsed and drained',
    qty: [1, 1],
    unit: 'can',
    packSize: { size: 15.5, unit: 'oz', container: 'can' },
    itemKey: 'chickpea',
    note: /rinsed/,
  },
  {
    raw: '1 x 400ml can full-fat coconut milk',
    qty: [1, 1],
    unit: 'can',
    packSize: { size: 400, unit: 'ml', container: 'can' },
    itemKey: 'full-fat coconut milk',
  },
  {
    raw: '1 jar (570g) butter beans + the bean stock',
    qty: [1, 1],
    unit: 'jar',
    packSize: { size: 570, unit: 'g', container: 'jar' },
    itemKey: 'butter bean',
    note: /bean stock/,
  },
  {
    raw: '570g can cannellini/white beans, drained (400g drained weight)',
    qty: [1, 1],
    unit: 'can',
    packSize: { size: 570, unit: 'g', container: 'can', drained: 400 },
    itemKey: 'cannellini bean',
  },
  {
    raw: '2 tins butter beans',
    qty: [2, 2],
    unit: 'can',
    packSize: undefined,
    itemKey: 'butter bean',
    confidenceBand: 'high',
  },
  // --- counts and containers ----------------------------------------------
  {
    raw: '1 bunch tuscan kale, deveined and rough chopped',
    qty: [1, 1],
    unit: 'bunch',
    itemKey: 'tuscan kale',
    note: /deveined/,
  },
  {
    raw: '1/2 bunch parsley, minced (optional)',
    qty: [0.5, 0.5],
    unit: 'bunch',
    itemKey: 'parsley',
    note: 'minced',
    qualifiers: ['optional'],
  },
  { raw: '2 cloves garlic, crushed', qty: [2, 2], unit: 'clove', itemKey: 'garlic', note: 'crushed' },
  { raw: '3 spring onions, thinly sliced', qty: [3, 3], unit: 'each', itemKey: 'spring onion' },
  {
    raw: '1 medium orange bell pepper, diced',
    qty: [1, 1],
    unit: 'each',
    itemKey: 'orange pepper',
    note: 'diced',
  },
  // --- masses and volumes --------------------------------------------------
  { raw: '- 300ml cream', qty: [300, 300], unit: 'ml', itemKey: 'cream' },
  { raw: '400g cherry tomatoes', qty: [400, 400], unit: 'g', itemKey: 'cherry tomato' },
  {
    raw: '- 100g pasta per person',
    qty: [100, 100],
    unit: 'g',
    itemKey: 'pasta',
    qualifiers: ['per-person'],
  },
  { raw: '6 tbs harissa.', qty: [6, 6], unit: 'tbsp', itemKey: 'harissa' },
  { raw: '1 1/2 cups plain flour', qty: [1.5, 1.5], unit: 'cup', itemKey: 'plain flour' },
  { raw: '1-2 tsp chilli flakes', qty: [1, 2], unit: 'tsp', itemKey: 'chilli flake' },
  {
    raw: '4 tablespoon olive oil, divided',
    qty: [4, 4],
    unit: 'tbsp',
    itemKey: 'olive oil',
    qualifiers: ['divided', 'pantry-staple'],
  },
  // --- parentheticals ------------------------------------------------------
  {
    raw: '⅓ cup (65g) pepitas (pumpkin seed kernels), toasted',
    qty: [1 / 3, 1 / 3],
    unit: 'cup',
    itemKey: 'pumpkin seed',
    clarifier: 'pumpkin seed kernels',
    alternates: [[65, 'g']],
    note: 'toasted',
  },
  // --- named patterns ------------------------------------------------------
  {
    raw: 'Zest and juice of half lemon.',
    qty: [0.5, 0.5],
    unit: 'each',
    itemKey: 'lemon',
    note: 'zest and juice',
  },
  { raw: 'Handful of fresh basil', qty: [1, 1], unit: 'handful', itemKey: 'basil' },
  // --- seasonings ----------------------------------------------------------
  {
    raw: 'Salt and black pepper',
    qty: null,
    itemKey: 'salt and pepper',
    qualifiers: ['to-taste', 'pantry-staple'],
  },
  {
    raw: 'Kosher salt and freshly ground black pepper, to taste',
    qty: null,
    itemKey: 'salt and pepper',
    qualifiers: ['to-taste', 'pantry-staple'],
  },
  // --- headers -------------------------------------------------------------
  { raw: 'For the dressing:', isHeader: true, confidenceBand: 'high' },
  { raw: 'TOFU + marindade:', isHeader: true, confidenceBand: 'high' },
  // --- the ones we must be honest about being unsure of --------------------
  {
    raw: 'Your favorite crusty breast, to serve',
    qty: null,
    itemKey: 'crusty breast',
    confidenceBand: 'low',
    maxConfidence: 0.55,
  },
];

describe('parseIngredientLine — real library lines', () => {
  it('covers at least 26 distinct line shapes', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(26);
  });

  for (const c of CASES) {
    it(`parses ${JSON.stringify(c.raw)}`, () => {
      const p = parseLine(c.raw, c.next ? { next: c.next } : {});

      if (c.isHeader !== undefined) expect(p.isHeader).toBe(c.isHeader);
      if (c.isHeader) return;

      if (c.qty !== undefined) {
        if (c.qty === null) expect(p.quantity).toBeNull();
        else {
          expect(p.quantity).not.toBeNull();
          expect(p.quantity!.low).toBeCloseTo(c.qty[0], 6);
          expect(p.quantity!.high).toBeCloseTo(c.qty[1], 6);
          expect(p.quantity!.isRange).toBe(c.qty[0] !== c.qty[1]);
        }
      }
      if (c.unit !== undefined) expect(p.unit).toBe(c.unit);
      if (c.packSize !== undefined) {
        expect(p.packSize).not.toBeNull();
        expect(p.packSize!.size).toBeCloseTo(c.packSize.size, 6);
        expect(p.packSize!.unit).toBe(c.packSize.unit);
        expect(p.packSize!.container).toBe(c.packSize.container);
        if (c.packSize.drained !== undefined) {
          expect(p.packSize!.drainedSize).toBe(c.packSize.drained);
        }
      }
      if (c.itemKey !== undefined) expect(p.itemKey).toBe(c.itemKey);
      if (c.item !== undefined) expect(p.item).toBe(c.item);
      if (c.note !== undefined) {
        if (c.note === null) expect(p.note).toBeNull();
        else if (c.note instanceof RegExp) expect(p.note ?? '').toMatch(c.note);
        else expect(p.note).toBe(c.note);
      }
      if (c.clarifier !== undefined) expect(p.clarifier).toBe(c.clarifier);
      if (c.qualifiers !== undefined) {
        for (const q of c.qualifiers) expect(p.qualifiers).toContain(q);
      }
      if (c.alternates !== undefined) {
        expect(p.alternates.map((a) => [a.quantity, a.unit])).toEqual(c.alternates);
      }
      if (c.confidenceBand !== undefined) expect(band(p.confidence)).toBe(c.confidenceBand);
      if (c.maxConfidence !== undefined) expect(p.confidence).toBeLessThan(c.maxConfidence);
      expect(p.parserVersion).toBe(PARSER_VERSION);
    });
  }
});

describe('numbers', () => {
  it('reads mixed numbers, fractions and decimals', () => {
    expect(parseQuantityPrefix('1 1/2 cups flour')!.qty.low).toBeCloseTo(1.5);
    expect(parseQuantityPrefix('1/2 tsp salt')!.qty.low).toBeCloseTo(0.5);
    expect(parseQuantityPrefix('15.5 oz beans')!.qty.low).toBeCloseTo(15.5);
    expect(fractionToNumber('3/4')).toBeCloseTo(0.75);
    expect(fractionToNumber('not a fraction')).toBeNull();
    expect(wordToNumber('half')).toBeCloseTo(0.5);
    expect(wordToNumber('a couple')).toBe(2);
    expect(wordToNumber('parsley')).toBeNull();
  });

  it('treats a hyphen as a range only when a measure follows', () => {
    const range = parseQuantityPrefix('400-500g flour');
    expect(range!.qty.isRange).toBe(true);
    expect(range!.qty.low).toBe(400);
    expect(range!.qty.high).toBe(500);
    // 'chilli-garlic paste' has no leading number at all, and must not parse
    // as one; this is the case the lookahead rule exists for.
    expect(parseQuantityPrefix('chilli-garlic paste')).toBeNull();
    const p = parseLine('1 tbsp chilli-garlic paste');
    expect(p.quantity!.isRange).toBe(false);
    expect(p.itemKey).toBe('chilli-garlic paste');
  });

  it('renders honest fractions only', () => {
    expect(toFraction(1 / 3)).toBe('1/3');
    expect(toFraction(1.5)).toBe('1 1/2');
    expect(toFraction(0.5)).toBe('1/2'); // smallest denominator, never 4/8
    expect(toFraction(1.29)).toBeNull(); // 1.29 is not 1 1/3
  });
});

describe('tokenize', () => {
  it('normalises unicode fractions, dashes and mixed numbers', () => {
    expect(normalizeUnicode('½ tsp')).toBe('1/2 tsp');
    expect(normalizeUnicode('1½ tablespoons')).toBe('1 1/2 tablespoons');
    expect(normalizeUnicode('⅓ cup')).toBe('1/3 cup');
    expect(normalizeUnicode('14–16 ounce')).toBe('14-16 ounce');
    expect(normalizeUnicode('2 × 400g')).toBe('2 x 400g');
    expect(normalizeUnicode('a b')).toBe('a b');
  });

  it('strips bullets but leaves quantities alone', () => {
    expect(stripBullet('- 300ml cream')).toBe('300ml cream');
    expect(stripBullet('• basil')).toBe('basil');
    expect(stripBullet('1/2 bunch parsley')).toBe('1/2 bunch parsley');
    // A numbered prefix is only a bullet in an incrementing list.
    expect(stripBullet('1. tomato')).toBe('1. tomato');
    expect(stripBullet('1. tomato', true)).toBe('tomato');
  });
});

describe('units', () => {
  it('uses UK measures by default and US where detected', () => {
    expect(toBase(1, 'tbsp', 'metric-uk')).toBe(15);
    expect(toBase(1, 'tbsp', 'metric-au')).toBe(20);
    expect(toBase(1, 'cup', 'metric-uk')).toBe(250);
    expect(toBase(1, 'cup', 'us')).toBe(240);
    expect(toBase(1, 'floz', 'metric-uk')).toBeCloseTo(28.41);
    expect(toBase(1, 'oz', 'metric-uk')).toBeCloseTo(28.3495);
    expect(fromBase(1200, 'mass', 'metric-uk')).toEqual({ value: 1.2, unit: 'kg' });
  });

  it('knows every spelling the user actually types', () => {
    for (const alias of ['tablespoon', 'tablespoons', 'tbs', 'tbsp.', 'T', 'tbspn', 'tbl']) {
      expect(lookupUnit(alias)?.code).toBe('tbsp');
    }
    expect(lookupUnit('t')?.code).toBe('tsp');
    expect(lookupUnit('tins')?.code).toBe('can');
  });

  it('sniffs dialect and refuses to guess when the evidence is mixed', () => {
    expect(detectDialect('6 oz feta cheese\n1 cup arugula')).toBe('us');
    expect(detectDialect('300g pasta\n200ml cream')).toBe('metric-uk');
    expect(detectDialect('15 oz chickpeas\n300g lentils')).toBeNull();
    expect(detectDialect('salt and pepper')).toBeNull();
  });
});

describe('containers', () => {
  it('reads a size as a pack only when a container noun follows', () => {
    const pack = parsePack('2 450g can chickpeas');
    expect(pack.matched).toBe(true);
    expect(pack.count!.low).toBe(2);
    expect(pack.packSize!.size).toBe(450);
    // '300g small brown lentils' is 300 grams, NOT one 300 g pack of anything.
    expect(parsePack('300g small brown lentils').matched).toBe(false);
    expect(parsePack('2 tins butter beans').matched).toBe(false);
  });

  it('derives alternates from count x size', () => {
    const p = parseLine('2 450g can chickpeas');
    expect(p.quantity!.low * p.packSize!.size).toBe(900);
  });
});

describe('parentheticals', () => {
  it('classifies in the documented order', () => {
    expect(classifyParenthetical('65g').kind).toBe('alt-measure');
    expect(classifyParenthetical('400g drained weight').kind).toBe('drainedSize');
    expect(classifyParenthetical('optional').kind).toBe('qualifier');
    expect(classifyParenthetical('roughly 3 cups').kind).toBe('approx');
    expect(classifyParenthetical('pumpkin seed kernels').kind).toBe('clarifier');
  });

  it('keeps a clarifier out of the itemKey so it still merges', () => {
    const withClarifier = parseLine('⅓ cup (65g) pepitas (pumpkin seed kernels), toasted');
    const bare = parseLine('50g pepitas');
    expect(withClarifier.itemKey).toBe(bare.itemKey);
  });
});

describe('notes', () => {
  it('splits at a comma only when a prep phrase follows', () => {
    expect(splitItemAndNote('chickpeas, drained & rinsed')).toEqual({
      item: 'chickpeas',
      note: 'drained & rinsed',
    });
    // The comma here separates ingredients, not a note. Splitting would invent
    // an ingredient the user never wrote, so we keep the line whole.
    expect(splitItemAndNote('salt, pepper and oil').item).toBe('salt, pepper and oil');
  });

  it('collapses seasoning phrases to one row', () => {
    for (const phrase of [
      'salt and pepper',
      'salt & pepper',
      'Salt and black pepper',
      'Kosher salt and freshly ground black pepper',
      'Sea salt and cracked black pepper',
    ]) {
      expect(matchSeasoning(phrase)?.itemKey).toBe('salt and pepper');
    }
    expect(matchSeasoning('1 tsp salt')).toBeNull();
  });
});

describe('canonicalisation', () => {
  it('singularises the head noun only', () => {
    expect(canonicaliseItem('spring onions').itemKey).toBe('spring onion');
    expect(canonicaliseItem('cherry tomatoes').itemKey).toBe('cherry tomato');
    expect(canonicaliseItem('leaves').itemKey).toBe('leaf');
    expect(canonicaliseItem('olives').itemKey).toBe('olive');
    expect(canonicaliseItem('potatoes').itemKey).toBe('potato');
  });

  it('NEVER collapses a variety into its base product', () => {
    expect(canonicaliseItem('cherry tomatoes').itemKey).not.toBe(
      canonicaliseItem('tomatoes').itemKey,
    );
    expect(canonicaliseItem('smoked paprika').itemKey).not.toBe(
      canonicaliseItem('paprika').itemKey,
    );
    expect(canonicaliseItem('self raising flour').itemKey).not.toBe(
      canonicaliseItem('plain flour').itemKey,
    );
  });

  it('strips only the non-distinguishing adjectives', () => {
    expect(canonicaliseItem('fresh basil').itemKey).toBe('basil');
    expect(canonicaliseItem('1 large cucumber'.replace('1 ', '')).itemKey).toBe('cucumber');
    expect(canonicaliseItem('good quality olive oil').itemKey).toBe('olive oil');
    expect(canonicaliseItem('red onion').itemKey).toBe('red onion');
    expect(canonicaliseItem('dried oregano').itemKey).toBe('dried oregano');
  });

  it('translates US vocabulary to British', () => {
    const cases: [string, string][] = [
      ['garbanzo beans', 'chickpea'],
      ['cilantro', 'coriander'],
      ['eggplant', 'aubergine'],
      ['zucchini', 'courgette'],
      ['scallions', 'spring onion'],
      ['all-purpose flour', 'plain flour'],
      ['heavy cream', 'double cream'],
      ['arugula', 'rocket'],
      ['shrimp', 'prawn'],
    ];
    for (const [from, to] of cases) expect(canonicaliseItem(from).itemKey).toBe(to);
  });

  it('records slash alternatives as aliases', () => {
    const c = canonicaliseItem('cannellini/white beans');
    expect(c.itemKey).toBe('cannellini bean');
    expect(c.aliases).toContain('white bean');
  });

  it('similarity is for suggestions only', () => {
    expect(similarity('cherry tomato', 'cherry tomato')).toBe(1);
    expect(similarity('tomato puree', 'tomato paste')).toBeGreaterThan(0.5);
    expect(similarity('lemon', 'gnocchi')).toBeLessThan(0.2);
  });
});

describe('blocks, keys and overrides', () => {
  const BLOCK = [
    'For the dressing:',
    '6 tbs harissa.',
    '1 Tbs olive oil.',
    '',
    'Salad',
    '3 large carrots, cut into 1-inch slices',
    '1 (15.5 oz) can chickpeas, rinsed and drained',
  ].join('\n');

  it('tracks sections and flags the ambiguous header rule', () => {
    const lines = parseIngredientBlock(BLOCK);
    expect(lines[0]!.isHeader).toBe(true);
    expect(lines[0]!.confidence).toBeCloseTo(0.95);
    expect(lines[1]!.section).toBe('dressing');
    const salad = lines.find((l) => l.item === 'Salad')!;
    expect(salad.isHeader).toBe(true);
    expect(salad.confidence).toBeCloseTo(0.6);
    expect(lines[lines.length - 1]!.section).toBe('Salad');
  });

  it('gives duplicate lines distinct, stable keys', () => {
    const lines = parseIngredientBlock('1 tsp cumin\n1 tsp cumin\n1 tsp coriander');
    expect(lines[0]!.lineKey).not.toBe(lines[1]!.lineKey);
    expect(lines[0]!.lineKey.split(':')[0]).toBe(lines[1]!.lineKey.split(':')[0]);
    expect(parseIngredientBlock('1 tsp cumin\n1 tsp cumin\n1 tsp coriander')[1]!.lineKey).toBe(
      lines[1]!.lineKey,
    );
  });

  it('ignores bullet, case and whitespace noise in the key', () => {
    const a = makeLineKey('- 300ml Cream', 0);
    const b = makeLineKey('300ml   cream', 0);
    const c = makeLineKey('•  300ml cream ', 0);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('applies user overrides on top of the parse', () => {
    const lines = parseIngredientBlock('2 tins butter beans');
    const patched = applyOverrides(lines, [
      {
        lineKey: lines[0]!.lineKey,
        quantity: { low: 3, high: 3 },
        item: 'butter beans',
        editedAt: '2026-08-03T09:00:00.000Z',
        editedByClientId: 'client-a',
      },
    ]);
    expect(patched[0]!.quantity!.low).toBe(3);
    expect(patched[0]!.overridden).toBe(true);
    // An override keyed to different text is dropped, not misapplied.
    expect(applyOverrides(lines, [
      {
        lineKey: 'deadbeef00:0',
        quantity: { low: 9, high: 9 },
        editedAt: '2026-08-03T09:00:00.000Z',
        editedByClientId: 'client-a',
      },
    ])[0]!.overridden).toBe(false);
  });

  it('excludes water from the shopping list', () => {
    expect(parseLine('3tbs water to thin out').excluded).toBe(true);
    expect(parseLine('1 cup pasta water').excluded).toBe(true);
    expect(parseLine('300ml cream').excluded).toBe(false);
  });
});
