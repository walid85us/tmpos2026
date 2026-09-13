// Phase 4.0 M4 — the administration console (docs/phase-4/03, ADR-02): the production successor
// of the DEV-only mock Backend Control Plane shell (../BackendControlPlaneApp.tsx), whose
// presentation primitives it reuses. src/main.tsx loads it only on the console surface
// (adminSurface.ts), so no tenant-app code, tenant Firebase instance or tenant session runs here.
//
// Nothing administrative renders until GET /admin/v1/session confirms a session; the console
// holds no authority of its own (every decision is the server's); and on an address that is not
// a configured administration origin it renders a refusal and makes no request at all.

import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { lazyFirebaseIdentity } from './adminIdentity';
import { createAdminSessionClient } from './adminSessionClient';
import { CONSOLE_BASE, isApiPath } from './adminSurface';
import ApiPathNotFound from './ApiPathNotFound';
import { createCommandCenterClient } from './commandCenterClient';
import CommandCenterPage from './CommandCenterPage';
import { ConsoleContext, useSessionState, type ConsoleServices } from './consoleContext';
import ConsoleShell from './ConsoleShell';
import { HostRefused, LoadingScreen, ModulePage } from './ConsolePages';
import { CONSOLE_HOME, CONSOLE_MODULES, SIGN_IN_PATH, safeReturnPath } from './navigation';
import SignInScreen from './SignInScreen';

function RequireSession({ children }: { children: React.ReactNode }) {
  const state = useSessionState();
  const location = useLocation();
  if (state.phase === 'checking') return <LoadingScreen />;
  if (state.phase === 'active' || state.phase === 'signing-out') return <>{children}</>;
  return <Navigate to={SIGN_IN_PATH} replace state={{ returnTo: location.pathname }} />;
}

function SignInRoute() {
  const state = useSessionState();
  const location = useLocation();
  if (state.phase === 'active') {
    return <Navigate to={safeReturnPath((location.state as { returnTo?: unknown } | null)?.returnTo)} replace />;
  }
  return <SignInScreen />;
}

export function ConsoleRoutes() {
  return (
    <Routes>
      <Route path={SIGN_IN_PATH} element={<SignInRoute />} />
      <Route
        path={CONSOLE_BASE}
        element={
          <RequireSession>
            <ConsoleShell />
          </RequireSession>
        }
      >
        <Route index element={<CommandCenterPage />} />
        {/* One Command Center, the console home: an old link to it lands there, never on a second dashboard. */}
        <Route path="command-center" element={<Navigate to={CONSOLE_HOME} replace />} />
        {CONSOLE_MODULES.map((module) => (
          <Route key={module.slug} path={module.slug} element={<ModulePage module={module} />} />
        ))}
      </Route>
      <Route path="*" element={<UnknownAddress />} />
    </Routes>
  );
}

/**
 * Inside the page, an address no route claims. An API path under the one canonical rule
 * (adminSurface.ts) is never a console page and never redirected; anything else goes home.
 * A page load of an API path never gets here (src/main.tsx).
 */
function UnknownAddress() {
  return isApiPath(useLocation().pathname) ? <ApiPathNotFound /> : <Navigate to={CONSOLE_BASE} replace />;
}

/** Reads the session once on mount; an unmount abandons whatever is still in flight. */
export function ConsoleProvider({ client, identity, commandCenter, children }: ConsoleServices & { children: React.ReactNode }) {
  React.useEffect(() => {
    void client.bootstrap();
    return () => client.abort();
  }, [client]);
  const screens = React.useRef({ shown: false }).current;
  const services = React.useMemo(() => ({ client, identity, commandCenter, screens }), [client, identity, commandCenter, screens]);
  return <ConsoleContext.Provider value={services}>{children}</ConsoleContext.Provider>;
}

// A Vite dev server does not enforce the administration address (adminSurface.ts). Vite folds
// `import.meta.env.DEV` to false in a production build, so this badge never ships.
function DevelopmentBadge() {
  return (
    <p className="pointer-events-none fixed bottom-3 right-3 z-[70] rounded-full bg-amber-300 px-3 py-1 text-xs font-semibold text-slate-950 shadow-lg">
      Local development build. The administration address is not enforced here.
    </p>
  );
}

export default function AdminConsoleApp({ surface, services }: { surface: 'admin' | 'admin-refused'; services?: ConsoleServices }) {
  const [resolved] = React.useState<ConsoleServices>(
    () => services ?? { client: createAdminSessionClient(), identity: lazyFirebaseIdentity, commandCenter: createCommandCenterClient() },
  );
  if (surface === 'admin-refused') return <HostRefused />;
  return (
    <ConsoleProvider {...resolved}>
      <BrowserRouter>
        <ConsoleRoutes />
      </BrowserRouter>
      {import.meta.env.DEV && import.meta.env.MODE === 'development' && import.meta.hot !== undefined ? <DevelopmentBadge /> : null}
    </ConsoleProvider>
  );
}
