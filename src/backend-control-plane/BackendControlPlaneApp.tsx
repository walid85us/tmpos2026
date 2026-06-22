// Phase 1.6 M22B — Backend Control Plane read-only / mock-only UI foundation.
//
// Top-level, self-contained entry for the isolated DEV-only BCP route. It is
// lazy-loaded by App.tsx ONLY when BCP_ROUTE_ENABLED (Vite DEV build + explicit
// opt-in). It renders OUTSIDE the guarded '/' and '/owner' trees, is NOT wrapped
// by AccessGuard, and shares NO authority with the Owner Platform.
//
// It holds a single piece of local UI state ("entered") that flips the mock access
// gate to the shell. No authentication, no API, no DB, no mutation occurs anywhere.

import React from 'react';
import AccessGate from './AccessGate';
import Shell from './Shell';

export default function BackendControlPlaneApp() {
  const [entered, setEntered] = React.useState(false);

  return (
    <div className="min-h-screen bg-slate-950 font-sans text-slate-100">
      {entered ? <Shell /> : <AccessGate onEnter={() => setEntered(true)} />}
    </div>
  );
}
