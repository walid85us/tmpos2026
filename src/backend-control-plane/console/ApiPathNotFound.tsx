// Phase 4.0 M4 — what an API address shows if a page load of one ever reaches the frontend
// (adminSurface.ts isApiPath): a bounded "not found", never the console, the tenant application
// or a redirect. React only (no console context, router or request), so src/main.tsx renders it
// without loading either application, and the address stays as it is.

import { useEffect } from 'react';

export default function ApiPathNotFound() {
  useEffect(() => {
    document.title = 'Not found';
  }, []);
  return (
    <main id="main-content" className="grid min-h-screen place-items-center bg-slate-950 px-4 py-16">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold tracking-tight text-white">Not found</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-300">This address is not a page.</p>
      </div>
    </main>
  );
}
