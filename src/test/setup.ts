// Vitest setup: register @testing-library/jest-dom matchers on vitest's expect,
// and auto-clean the DOM between tests.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
