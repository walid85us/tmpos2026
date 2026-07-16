import { describe, it, expect } from 'vitest';
import { isPermissionLevel } from './Employees';
import { PERMISSION_HIERARCHY } from '../context/accessConfig';

// Structural fix (TS2322): the new-role permission map is Record<string, PermissionLevel>,
// but the <select> hands back a raw string. Validate against the canonical vocabulary
// rather than asserting, so an unrecognised level is rejected instead of stored.
describe('isPermissionLevel', () => {
  it('accepts exactly the canonical vocabulary', () => {
    for (const level of PERMISSION_HIERARCHY) {
      expect(isPermissionLevel(level)).toBe(true);
    }
  });

  it('rejects unknown levels', () => {
    for (const bad of ['admin', 'owner', 'write', 'delete', 'superuser', 'FULL', 'View', '']) {
      expect(isPermissionLevel(bad)).toBe(false);
    }
  });

  it('rejects prototype keys, so a key-lookup rewrite of the guard would fail here', () => {
    expect(isPermissionLevel('__proto__')).toBe(false);
    expect(isPermissionLevel('constructor')).toBe(false);
    expect(isPermissionLevel('toString')).toBe(false);
  });
});
