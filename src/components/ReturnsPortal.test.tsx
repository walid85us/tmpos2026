import { describe, it, expect } from 'vitest';
import { resolveActorName } from './ReturnsPortal';

// Behaviour-bearing fix (TS2339): Session exposes the display name at `user.name`
// and has no top-level `name`. The former `session?.name` was always undefined, so
// every return action (performedBy / receivedBy / createdBy) recorded the 'System'
// fallback instead of the actual actor.
describe('resolveActorName', () => {
  it('uses the canonical Session display name when present', () => {
    expect(resolveActorName({ user: { name: 'Dana Reyes' } })).toBe('Dana Reyes');
  });

  it('falls back to System whenever no display name is available', () => {
    expect(resolveActorName(null)).toBe('System');
    expect(resolveActorName(undefined)).toBe('System');
    expect(resolveActorName({})).toBe('System');
    expect(resolveActorName({ user: {} })).toBe('System');
    expect(resolveActorName({ user: { name: '' } })).toBe('System');
  });
});
