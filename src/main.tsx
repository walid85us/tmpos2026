import {Component, StrictMode, Suspense, lazy, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import './index.css';
import {currentSurface} from './backend-control-plane/console/adminSurface';
import ApiPathNotFound from './backend-control-plane/console/ApiPathNotFound';

// Phase 4.0 M4 — the surface is chosen from the address before anything else loads. The
// administration console and the tenant application never share a page, so the tenant app's
// persisted Firebase instance is never initialised on a console page (adminSurface.ts). An API
// address is neither: it gets a bounded "not found" without loading either application, so no
// session request or provider load happens and the address is not rewritten.
const surface = currentSurface(window.location);
const App = lazy(() => import('./App.tsx'));
const AdminConsoleApp = lazy(() => import('./backend-control-plane/console/AdminConsoleApp'));

// A chunk that fails to load (a dropped connection, a stale page after a deploy) shows a way out
// instead of a blank page.
class LoadBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() {
    return {failed: true};
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p role="alert" style={{padding: '2rem', fontFamily: 'system-ui, sans-serif'}}>
        This page could not load.{' '}
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </p>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LoadBoundary>
      <Suspense fallback={null}>
        {surface === 'api-path' ? <ApiPathNotFound /> : surface === 'tenant' ? <App /> : <AdminConsoleApp surface={surface} />}
      </Suspense>
    </LoadBoundary>
  </StrictMode>,
);
