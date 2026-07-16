import { describe, it, expect } from 'vitest';
import { buildDashboardStockItem } from './DashboardOverview';

// Behavior-touching fix (TS2739): dashboard quick-add constructed a StockItem
// missing type/isRepairPart/isHiddenOnPOS. These control POS visibility and
// inventory semantics, so the defaults must be domain-correct: a generic
// quick-added item is non-serialized, not a repair part, and visible on POS.
describe('buildDashboardStockItem (dashboard quick-add defaults)', () => {
  it('defaults a quick-added item to non-serialized, non-repair, POS-visible', () => {
    const item = buildDashboardStockItem(
      { name: 'Test Cable', sku: 'TC-1', qty: 3, cost: 1, price: 2, category: 'Accessories' },
      'approved',
    );
    expect(item.type).toBe('non-serialized');
    expect(item.isRepairPart).toBe(false);
    expect(item.isHiddenOnPOS).toBe(false);
    expect(item.status).toBe('approved');
    expect(item.name).toBe('Test Cable');
    expect(item.qty).toBe(3);
    expect(typeof item.id).toBe('string');
    expect(typeof item.addedAt).toBe('string');
  });

  it('carries pending_approval status for users without inventory permission, still POS-visible', () => {
    const item = buildDashboardStockItem(
      { name: 'X', sku: 'X-1', qty: 1, cost: 0, price: 0, category: 'Parts' },
      'pending_approval',
    );
    expect(item.status).toBe('pending_approval');
    expect(item.isHiddenOnPOS).toBe(false);
    expect(item.type).toBe('non-serialized');
  });
});
