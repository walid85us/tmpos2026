import { describe, it, expect } from 'vitest';
import { QUICK_ADD_STOCK_DEFAULTS } from './POS';

// Structural fix (TS2345): StockItem requires `type`, `isRepairPart` and `isHiddenOnPOS`,
// but the three POS quick-add call sites omitted all three. These are real runtime values
// written onto created inventory items — a wrong default would silently hide an item from
// the POS or mis-flag it as a repair part. The exact shape also pins that quick-add never
// invents an id, sku, price or stock quantity.
describe('QUICK_ADD_STOCK_DEFAULTS', () => {
  it('defaults quick-added stock to a visible, non-serialized, non-repair-part item and nothing else', () => {
    expect(QUICK_ADD_STOCK_DEFAULTS).toEqual({
      type: 'non-serialized',
      isRepairPart: false,
      isHiddenOnPOS: false,
    });
  });
});
