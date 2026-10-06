import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// M7B-INVOICES-P1 (commit 15110e4 changed only this screen's note): the note over the Invoices level panel is a claim
// about what that level does, and it must say what the panel itself says (ServerCustomerLevels.tsx, SCL-63) — the level
// decides the server drafts, and other invoices stay in this browser. Read from the source: a JSX comment never renders.
describe('the server-backed level panels on the Employees screen', () => {
  it('EMP-01. the Invoices level panel follows the Customers one, both for the signed-in user, under a note saying its level decides server drafts and other invoices stay in this browser', () => {
    const lines = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'Employees.tsx'), 'utf8').split('\n').map((line) => line.trim());
    const at = lines.indexOf('<ServerInvoiceLevels uid={session?.user.id ?? null} />');
    expect(at).toBeGreaterThan(2);
    expect(lines[at - 1]).toMatch(/^\{\/\* M5-INVOICES-AUTH-P1: the built-in roles' Invoices LEVEL only; it decides server drafts \(M7B-INVOICES-P1\), other invoices stay in this browser\. \*\/\}$/);
    expect(lines[at - 2]).toBe('<ServerCustomerLevels uid={session?.user.id ?? null} />');
  });
});
