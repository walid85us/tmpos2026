import { describe, it, expect } from 'vitest';
import { normalizeTags } from './TemplateEditor';

// Behavior-touching fix (TS2345 unknown[] -> string[]): tags fed to
// buildTemplateHtml must be genuine strings. normalizeTags is a real runtime
// guard that safely filters out any non-string value rather than an unchecked
// cast, so a malformed persisted template cannot inject non-string tags.
describe('normalizeTags', () => {
  it('returns string tags unchanged from an array', () => {
    expect(normalizeTags(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns string tags unchanged from a Set', () => {
    expect(normalizeTags(new Set(['x', 'y']))).toEqual(['x', 'y']);
  });

  it('drops non-string values (number, null, undefined, object)', () => {
    const mixed: Iterable<unknown> = ['a', 1, null, undefined, { t: 'z' }, 'b'];
    expect(normalizeTags(mixed)).toEqual(['a', 'b']);
  });
});
