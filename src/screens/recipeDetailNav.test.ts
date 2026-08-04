import { describe, expect, it } from 'vitest';
import { backTarget } from './RecipeDetailScreen';

describe('backTarget', () => {
  it('returns the origin passed through router state', () => {
    expect(backTarget({ from: '/plan' })).toBe('/plan');
    expect(backTarget({ from: '/recipes' })).toBe('/recipes');
  });

  it('falls back to the library for a deep link / cold load', () => {
    expect(backTarget(null)).toBe('/recipes');
    expect(backTarget(undefined)).toBe('/recipes');
    expect(backTarget({})).toBe('/recipes');
    expect(backTarget({ from: 123 })).toBe('/recipes');
  });
});
