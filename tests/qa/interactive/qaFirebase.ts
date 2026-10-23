// QA-INTERACTIVE-P1 — stands in for src/firebase.ts in the QA bundle only (vite.qa.config.ts swaps it by resolved path).
// Same exports; every Firebase call goes to the local emulators through the QA front's own origin.
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';
import qaConfig from './qa-firebase-config.json';

declare const __TMPOS_QA__: { origin: string; host: string; projectId: string; runId: string };
const QA = __TMPOS_QA__;

// A named app with a demo key: the SDK keeps its signed-in user under `firebase:authUser:<demo key>:tmpos-qa`, so a real
// session the normal app stored in this browser is neither read nor overwritten.
const app = initializeApp({ ...qaConfig, projectId: QA.projectId, authDomain: QA.host }, 'tmpos-qa');
export const auth = getAuth(app);
// The SDK replaces any path with '/', so its requests reach <origin>/identitytoolkit.googleapis.com/... on the QA front.
connectAuthEmulator(auth, QA.origin, { disableWarnings: true });
// connectFirestoreEmulator only speaks plain http to host:port, which an https page cannot reach; a custom host over
// https through the same front can. Long polling keeps every exchange an ordinary request the front can relay.
export const db = initializeFirestore(app, { host: QA.host, ssl: true, experimentalForceLongPolling: true });

// Outside the product design on purpose: a fixed corner label that never takes a click.
function showQaBanner() {
  document.title = `[QA] ${document.title}`;
  document.documentElement.dataset.tmposQaRun = QA.runId;
  const banner = document.createElement('div');
  banner.dataset.testid = 'qa-run-banner';
  banner.textContent = `QA ONLY · synthetic data · run ${QA.runId}`;
  Object.assign(banner.style, {
    position: 'fixed', top: '0', right: '0', zIndex: '2147483647', pointerEvents: 'none', padding: '1px 8px',
    background: '#9a3412', color: '#ffffff', font: '600 11px/1.6 system-ui, sans-serif', borderBottomLeftRadius: '6px',
  });
  document.body.appendChild(banner);
}
if (document.body) showQaBanner();
else document.addEventListener('DOMContentLoaded', showQaBanner, { once: true });
