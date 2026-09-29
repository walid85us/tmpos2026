// M7A-CUSTOMERS-P3-R2 — the shop's server-backed editor for the built-in roles' Customers levels.
//
// This is the only part of the Employees permissions screen whose changes reach the tenant server: the three editable
// built-in roles' Customers level (store_owner is fixed Full), read from GET /api/v1/roles/levels and changed through
// R1's PUT /api/v1/roles/levels. Custom roles and every other domain stay in the local-only grid below it.
//
//   - The server decides everything: who may read (the store owner), who may edit, the tenant, the level that stands.
//     A manager or any other role sees the server's refusal as the "denied" state; nothing here decides authority.
//   - An edit is "Saved" ONLY when a PUT answered exactly 200 (a fresh execution or the idempotent replay of the same
//     key) AND the read-back that follows, for the same tenant, shows the requested level. Nothing else is ever
//     "Saved" (AM1): a 409, a 5xx, an unexpected body or no answer at all is read back and reported as what the server
//     now has. Every refusal keeps the draft visible with a way to retry. Nothing is optimistic.
//   - One Idempotency-Key per change. No answer at all → one automatic retry of the identical payload under the same
//     key (idempotent: it replays or executes once). A 409 (that key still in progress) or a second silence keeps the
//     key, so pressing Save again replays it — even when the server already shows the level, Save stays usable to
//     confirm the held payload. Any other answer settles the key; any other payload gets its own key.
//   - Each row status records the server level it describes: a later read that changes that level replaces a former
//     "Saved" with "Changed elsewhere", clears an idle note, and turns a failed, stale or unconfirmed save into "The
//     server now has X. Your change is not saved." (AM2); a status that carries an action is left alone.
//   - Staleness: every async result — including each continuation after an awaited helper — is applied only under the
//     generation that started it (a user switch, sign-out or unmount abandons everything), and only for the tenant the
//     first read of that generation named — a save whose read-back names another tenant restarts the panel and leaves
//     a notice until the next user switch (AM5; R1's PUT has no tenant precondition). A read that started before a
//     later-applied read never overwrites it. Focus/visibility refreshes run one at a time, wait while a save or a
//     sign-in confirmation is under way (AM3), and speak only while no later read has started. Two tabs: last writer
//     wins on the server (R1 has no version precondition); each tab shows its own read-back and never says "Saved"
//     unless that read-back matches.

import { useEffect, useRef, useState } from 'react';
import { EmailAuthProvider, GoogleAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup } from 'firebase/auth';
import { auth } from '../firebase';
import { PERMISSION_DOMAINS, PERMISSION_HIERARCHY, tenantRoles } from '../context/accessConfig';
import { checkReason, createIntentKeys, REASON_MAX, REASON_MIN, type IntentKeys } from '../backend-control-plane/console/tenantManagementClient';
import { tenantSession, type SessionResult, type TenantSessionClient } from './tenantSessionClient';
import { EDITABLE_ROLE_IDS, roleLevels, type EditableRoleId, type ReadResult, type RoleLevel, type RoleLevelEntry, type RoleLevelsClient } from './roleLevelsClient';

/** The signed-in shop user's provider identity: ID tokens and a real re-authentication. */
export interface ShopIdentity {
  /** A current ID token for `uid`, or null when that user is not the one signed in here. */
  idToken(uid: string): Promise<string | null>;
  /** How this user proves a recent sign-in: their password, a Google popup, or neither available here. */
  reauthMethod(uid: string): 'password' | 'google' | null;
  /** Re-authenticate `uid` with the provider, then a freshly issued ID token; null when it did not succeed. */
  reauthenticate(uid: string, password: string | null): Promise<string | null>;
}

export const firebaseShopIdentity: ShopIdentity = Object.freeze({
  async idToken(uid: string): Promise<string | null> {
    const user = auth.currentUser;
    return user !== null && user.uid === uid ? user.getIdToken() : null;
  },
  reauthMethod(uid: string): 'password' | 'google' | null {
    const user = auth.currentUser;
    if (user === null || user.uid !== uid) return null;
    const providers = user.providerData.map((p) => p.providerId);
    return providers.includes('password') ? 'password' : providers.includes('google.com') ? 'google' : null;
  },
  async reauthenticate(uid: string, password: string | null): Promise<string | null> {
    const user = auth.currentUser;
    if (user === null || user.uid !== uid) return null;
    try {
      if (password !== null) {
        if (user.email === null) return null;
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
      } else {
        await reauthenticateWithPopup(user, new GoogleAuthProvider());
      }
      return await user.getIdToken(true);
    } catch {
      return null;
    }
  },
});

const LEVEL_LABELS: Record<RoleLevel, string> = {
  none: 'None', view: 'View Only', create: 'Create', edit: 'Edit', manage: 'Manage', approve: 'Approve', full: 'Full Access',
};
const CUSTOMER_LEVELS: readonly string[] = PERMISSION_DOMAINS.find((d) => d.id === 'customers')?.levels ?? [];
const roleName = (id: string): string => tenantRoles.find((r) => r.id === id)?.name ?? id;

type Phase = 'loading' | 'ready' | 'denied' | 'unavailable' | 'signed-out';
const PHASE_LABELS: Record<Phase, string> = {
  loading: 'Loading', ready: 'Ready', denied: 'Denied', unavailable: 'Unavailable', 'signed-out': 'Signed out',
};
export const DENIED_NOTE =
  'Server-enforced Customers access can only be viewed and changed by the store owner. Changes in the table below affect this browser only.';
export const REFRESH_FAILED_NOTE = 'Could not refresh from the server; values may be out of date.';
export const DIFFERENT_STORE_NOTICE = 'Your last change may have been applied to a different store. Review the levels below.';

type Tone = 'idle' | 'saving' | 'saved' | 'confirm' | 'failed' | 'stale' | 'step-up' | 'signed-out' | 'denied';
/** A row's status line and the server level it describes (null: none). */
interface RowStatus { readonly tone: Tone; readonly text: string; readonly level: RoleLevel | null }

export interface ServerCustomerLevelsProps {
  /** The signed-in shop user's UID (the Firebase UID), or null when nobody is signed in. */
  readonly uid: string | null;
  readonly session?: TenantSessionClient;
  readonly levels?: RoleLevelsClient;
  readonly identity?: ShopIdentity;
  readonly newKey?: () => string;
}

export default function ServerCustomerLevels({
  uid, session = tenantSession, levels = roleLevels, identity = firebaseShopIdentity, newKey,
}: ServerCustomerLevelsProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState(''); // survives a tenant restart and later saves; cleared only by a user switch
  const [roles, setRoles] = useState<readonly RoleLevelEntry[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<EditableRoleId, RoleLevel>>>({});
  const [reasons, setReasons] = useState<Partial<Record<EditableRoleId, string>>>({});
  const [statuses, setStatuses] = useState<Partial<Record<EditableRoleId, RowStatus>>>({});
  const [saving, setSaving] = useState<EditableRoleId | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const [stepUp, setStepUp] = useState<{ readonly roleId: EditableRoleId; readonly method: 'password' | 'google' | null } | null>(null);
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);

  const gen = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const tenant = useRef<string | null>(null); // the tenant the first read of this generation named
  const readSeq = useRef(0); // the start order of reads
  const appliedSeq = useRef(0); // the start order of the read last applied
  const savingRef = useRef(false);
  const refreshingRef = useRef(false); // a focus/visibility refresh is in flight
  const stepUpRef = useRef(false); // a sign-in prompt is showing
  const confirmingRef = useRef(false); // a sign-in confirmation is under way
  const phaseRef = useRef<Phase>('loading');
  const statusesRef = useRef(statuses);
  const keys = useRef(new Map<EditableRoleId, IntentKeys>());
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  phaseRef.current = phase;
  statusesRef.current = statuses;

  const setStatus = (roleId: EditableRoleId, tone: Tone, text: string, level: RoleLevel | null): void =>
    setStatuses((prev) => ({ ...prev, [roleId]: { tone, text, level } }));
  const promptStepUp = (next: { readonly roleId: EditableRoleId; readonly method: 'password' | 'google' | null } | null): void => {
    stepUpRef.current = next !== null;
    setStepUp(next);
  };
  const keysFor = (roleId: EditableRoleId): IntentKeys => {
    let held = keys.current.get(roleId);
    if (held === undefined) {
      held = createIntentKeys(newKey);
      keys.current.set(roleId, held);
    }
    return held;
  };
  const ensure = (who: string): Promise<SessionResult> => session.ensure(who, () => identity.idToken(who));

  // The sign-in prompt takes focus when it appears: the password field, or the Google button (AM7).
  useEffect(() => {
    if (stepUp === null) return;
    (stepUp.method === 'password' ? passwordRef.current : confirmRef.current)?.focus();
  }, [stepUp]);

  /**
   * Adopt server values. A draft equal to the server's level is no longer a change and is dropped — unless its row
   * holds an unconfirmed save (tone `confirm`), whose payload stays for the replay. A status whose server level this
   * read changed is out of date (AM2): a former "Saved" becomes "Changed elsewhere", an idle note is cleared, and a
   * failed, stale or unconfirmed save says what the server now has — an unconfirmed hold ends there, but its draft and
   * held key stay, so a later Save of the same payload may replay it. Saving, step-up, signed-out and denied statuses
   * carry an action and are left alone.
   */
  const adopt = (next: readonly RoleLevelEntry[]): void => {
    const levelOf = (id: EditableRoleId): RoleLevel | undefined => next.find((r) => r.roleId === id)?.level;
    setRoles(next);
    setDrafts((prev) => {
      const kept: Partial<Record<EditableRoleId, RoleLevel>> = {};
      for (const id of EDITABLE_ROLE_IDS) {
        const draft = prev[id];
        if (draft !== undefined && (draft !== levelOf(id) || statusesRef.current[id]?.tone === 'confirm')) kept[id] = draft;
      }
      return kept;
    });
    setStatuses((prev) => {
      const out = { ...prev };
      let changed = false;
      for (const id of EDITABLE_ROLE_IDS) {
        const status = prev[id];
        const now = levelOf(id);
        if (status === undefined || status.level === null || now === undefined || now === status.level) continue;
        // A former Saved (and its own later moves) describes no pending change of this tab: it only says what the server has.
        const noPendingChange = status.tone === 'saved' || (status.tone === 'stale' && !status.text.includes('Your change'));
        if (noPendingChange) out[id] = { tone: 'stale', text: `Changed elsewhere — the server now has ${LEVEL_LABELS[now]}.`, level: now };
        else if (status.tone === 'idle') delete out[id];
        else if (status.tone === 'failed' || status.tone === 'stale' || status.tone === 'confirm') {
          out[id] = { tone: 'stale', text: `The server now has ${LEVEL_LABELS[now]}. Your change is not saved.`, level: now };
        } else continue;
        changed = true;
      }
      return changed ? out : prev;
    });
  };

  /**
   * A read answer for this generation: false when it named another tenant (the panel has restarted). A save's read-back
   * that does so leaves a notice: that save may have landed in the other store (AM5).
   */
  const accept = (answer: Extract<ReadResult, { kind: 'ok' }>, seq: number, fromSave: boolean): boolean => {
    if (tenant.current === null) tenant.current = answer.tenant;
    if (answer.tenant !== tenant.current) {
      if (fromSave) setNotice(DIFFERENT_STORE_NOTICE);
      begin('tenant'); // a different tenant answered: discard everything this generation showed and start over
      return false;
    }
    if (seq > appliedSeq.current) {
      appliedSeq.current = seq;
      adopt(answer.roles);
    }
    return true;
  };

  const sessionProblem = (kind: Exclude<SessionResult['kind'], 'ok'>): void => {
    if (kind === 'no-identity') {
      setPhase('signed-out');
      setNote('Sign in with your store account to see server-enforced Customers access.');
    } else if (kind === 'refused') {
      setPhase('signed-out');
      setNote('The store server did not accept this sign-in. Reconnect, or sign out and sign in again.');
    } else {
      setPhase('unavailable');
      setNote(kind === 'rate-limited'
        ? 'Too many sign-in attempts. Wait a minute, then try again.'
        : 'The store server could not be reached. Nothing was changed.');
    }
  };

  /**
   * Read the server's levels. A refresh (focus/visibility) keeps the panel ready when it cannot reach the server, and a
   * refusal demotes the panel only when no save is in flight (AM3). One refresh runs at a time, and its outcome (the
   * values, a note, a demotion) applies only while no later read has started — an older answer arriving last is
   * dropped. An initial load or a save's read-back is never dropped that way.
   */
  async function load(mode: 'initial' | 'refresh'): Promise<void> {
    if (uid === null || controller.current === null) return;
    const mine = gen.current;
    const signal = controller.current.signal;
    const refresh = mode === 'refresh';
    let seq = readSeq.current; // until this load's own read starts: no later read may have started either
    const superseded = (): boolean => mine !== gen.current || (refresh && seq !== readSeq.current);
    if (refresh) refreshingRef.current = true;
    try {
      if (!refresh) setPhase('loading');
      const s = await ensure(uid);
      if (superseded()) return;
      if (s.kind !== 'ok') {
        if (refresh && (s.kind === 'unavailable' || s.kind === 'rate-limited')) return setNote(REFRESH_FAILED_NOTE);
        if (refresh && savingRef.current) return;
        return sessionProblem(s.kind);
      }
      seq = ++readSeq.current;
      const answer = await levels.read(signal);
      if (superseded()) return;
      if (answer.kind === 'ok') {
        if (!accept(answer, seq, false)) return;
        setReconnect(false);
        setNote('');
        setPhase('ready');
      } else if (refresh && answer.kind === 'unavailable') {
        setNote(REFRESH_FAILED_NOTE);
      } else if (refresh && savingRef.current) {
        // a save is in flight: its own answer decides what the row says
      } else if (answer.kind === 'denied') {
        setPhase('denied');
        setNote(DENIED_NOTE);
      } else if (answer.kind === 'signed-out') {
        setPhase('signed-out');
        setNote('Your server session ended. Reconnect to see server-enforced Customers access.');
      } else {
        setPhase('unavailable');
        setNote('The store server could not be reached. Nothing was changed.');
      }
    } finally {
      if (refresh && mine === gen.current) refreshingRef.current = false; // a new generation has its own flag
    }
  }

  /**
   * Start a new generation: abandon everything in flight and forget every tenant-specific value. A user switch (or
   * sign-out, or mount) also clears the different-store notice; a tenant restart keeps it.
   */
  function begin(kind: 'user' | 'tenant'): void {
    gen.current += 1;
    controller.current?.abort();
    controller.current = new AbortController();
    tenant.current = null;
    appliedSeq.current = readSeq.current;
    savingRef.current = false;
    refreshingRef.current = false;
    confirmingRef.current = false;
    keys.current.clear();
    if (kind === 'user') setNotice('');
    setRoles([]);
    setDrafts({});
    setReasons({});
    setStatuses({});
    setSaving(null);
    setReconnect(false);
    promptStepUp(null);
    setPassword('');
    setConfirming(false);
    if (uid === null) {
      setPhase('signed-out');
      setNote('Sign in with your store account to see server-enforced Customers access.');
      return;
    }
    void load('initial');
  }

  useEffect(() => {
    begin('user');
    const refresh = (): void => {
      if (document.visibilityState === 'hidden' || phaseRef.current !== 'ready') return;
      if (savingRef.current || stepUpRef.current || confirmingRef.current || refreshingRef.current) return;
      void load('refresh');
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      gen.current += 1;
      controller.current?.abort();
    };
    // Only a user switch (or sign-out) starts a new generation; the clients are fixed for the panel's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  /** A read-back for this save: the level it shows for `roleId`, why it could not be read, or null (superseded). */
  async function readBack(roleId: EditableRoleId, mine: number, signal: AbortSignal): Promise<{ level: RoleLevel } | { failed: 'signed-out' | 'denied' | 'unavailable' } | null> {
    const seq = ++readSeq.current;
    const back = await levels.read(signal);
    if (mine !== gen.current) return null;
    if (back.kind !== 'ok') return { failed: back.kind };
    if (!accept(back, seq, true)) return null; // another tenant answered: the panel has started over
    const level = back.roles.find((r) => r.roleId === roleId)?.level;
    return level === undefined ? { failed: 'unavailable' } : { level };
  }

  async function save(roleId: EditableRoleId): Promise<void> {
    const current = roles.find((r) => r.roleId === roleId);
    const level = drafts[roleId];
    const reason = checkReason(reasons[roleId] ?? '');
    const confirmHeld = statuses[roleId]?.tone === 'confirm';
    if (uid === null || controller.current === null || savingRef.current || confirmingRef.current || phase !== 'ready') return;
    if (current === undefined || level === undefined || (level === current.level && !confirmHeld) || !('value' in reason)) return;
    const mine = gen.current;
    const signal = controller.current.signal;
    const label = (l: RoleLevel): string => LEVEL_LABELS[l];
    savingRef.current = true;
    setSaving(roleId);
    promptStepUp(null);
    setStatus(roleId, 'saving', 'Saving to the server…', current.level);
    try {
      const s = await ensure(uid);
      if (mine !== gen.current) return;
      if (s.kind !== 'ok') {
        if (s.kind === 'refused' || s.kind === 'no-identity') {
          setReconnect(true);
          return setStatus(roleId, 'signed-out', 'Not saved: your server session ended. Reconnect, then save again.', current.level);
        }
        return setStatus(roleId, 'failed', 'Not saved: the store server could not be reached. Try again.', current.level);
      }
      const held = keysFor(roleId);
      const change = { roleId, level, reason: reason.value };
      const key = held.keyFor(JSON.stringify([roleId, level, reason.value]));
      let answer = await levels.put(change, key, s.csrf, signal);
      if (mine !== gen.current) return;
      const lost = answer.kind === 'unknown' && !answer.responded;
      if (lost) {
        // No answer at all: retry the identical payload once under the same key — it replays or executes once.
        answer = await levels.put(change, key, s.csrf, signal);
        if (mine !== gen.current) return;
      }
      const unanswered = answer.kind === 'unknown' && !answer.responded;
      const keyHeld = answer.kind === 'in-progress' || unanswered;
      if (!keyHeld) held.settle(); // any other answer settles the key

      if (answer.kind === 'ok') {
        const back = await readBack(roleId, mine, signal);
        if (back === null || mine !== gen.current) return; // superseded, even after the read-back returned
        if ('level' in back) {
          if (back.level === level) {
            setReasons((prev) => ({ ...prev, [roleId]: '' }));
            return setStatus(roleId, 'saved', 'Saved', back.level);
          }
          return setStatus(roleId, 'stale', `Changed elsewhere — the server now has ${label(back.level)}. Your change is not saved.`, back.level);
        }
        if (back.failed === 'signed-out') setReconnect(true);
        return setStatus(roleId, 'failed', 'Not confirmed: the server answered, but the level could not be read back. Refresh before relying on it.', null);
      }

      // Undecided (a 409, a 5xx, an unexpected body, silence), or a refusal after a first attempt that got no answer:
      // what the server now has is read back and said as such — never "Saved".
      let shown: RoleLevel | null = current.level; // the server level a refusal's status describes
      if (answer.kind === 'in-progress' || answer.kind === 'unknown' || lost) {
        const back = await readBack(roleId, mine, signal);
        if (back === null || mine !== gen.current) return; // superseded, even after the read-back returned
        const now = 'level' in back ? back.level : null;
        shown = now;
        if (!('level' in back) && back.failed === 'signed-out') setReconnect(true);
        if (keyHeld) {
          if (now === level) {
            setDrafts((prev) => ({ ...prev, [roleId]: level })); // the held payload stays for the confirming replay
            return setStatus(roleId, 'confirm', `The server now has ${label(now)}, but this save is not confirmed yet. Press Save again to confirm.`, now);
          }
          return setStatus(roleId, 'failed', now === null
            ? 'Not confirmed: the server has not confirmed this save, and the level could not be read back. Press Save again to check.'
            : answer.kind === 'in-progress'
              ? `Not saved yet: the server is still working on this save and has ${label(now)}. Press Save again to check.`
              : `Not confirmed: the server did not answer, and it has ${label(now)}. Press Save again to check.`, now);
        }
        if (answer.kind === 'unknown') {
          return setStatus(roleId, 'failed', now === null
            ? 'Not saved by this attempt, and the level could not be read back. Try again.'
            : `Not saved by this attempt. The server has ${label(now)}${now === level ? ' — it may have been set elsewhere' : ''}.`, now);
        }
        // a refusal after a lost first attempt: it speaks below with its own text, whatever the read-back shows (AM6)
      }
      if (answer.kind === 'signed-out') {
        setReconnect(true);
        return setStatus(roleId, 'signed-out', 'Not saved: your server session ended. Reconnect, then save again.', shown);
      }
      if (answer.kind === 'step-up-required') {
        promptStepUp({ roleId, method: identity.reauthMethod(uid) });
        return setStatus(roleId, 'step-up', 'Not saved: sign in again to save this change.', shown);
      }
      if (answer.kind === 'denied') {
        return setStatus(roleId, 'denied', 'Not saved: the server refused this change. Only the store owner can change these levels.', shown);
      }
      if (answer.kind === 'invalid') {
        return setStatus(roleId, 'failed', `Not saved: the server refused this change. The reason must be ${REASON_MIN}–${REASON_MAX} characters.`, shown);
      }
      return setStatus(roleId, 'failed', 'Not saved: the server could not match this attempt. Try again.', shown); // key-reused
    } finally {
      if (mine === gen.current) {
        savingRef.current = false;
        setSaving(null);
      }
    }
  }

  async function confirmSignIn(): Promise<void> {
    if (uid === null || stepUp === null || confirmingRef.current) return;
    const mine = gen.current;
    const { roleId, method } = stepUp;
    const shown = roles.find((r) => r.roleId === roleId)?.level ?? null;
    const secret = method === 'password' ? password : null;
    setPassword('');
    confirmingRef.current = true;
    setConfirming(true);
    try {
      let fresh: string | null;
      try {
        fresh = await identity.reauthenticate(uid, secret);
      } catch {
        fresh = null;
      }
      if (mine !== gen.current) return;
      if (fresh === null) return setStatus(roleId, 'step-up', 'Not saved: your sign-in was not confirmed. Try again.', shown);
      const renewed = await session.reauthenticate(uid, fresh);
      if (mine !== gen.current) return;
      if (renewed.kind !== 'ok') return setStatus(roleId, 'step-up', 'Not saved: the store server did not confirm your sign-in. Try again.', shown);
      promptStepUp(null);
      setStatus(roleId, 'idle', 'Signed in again. Press "Save to server" to save this change.', shown);
    } finally {
      if (mine === gen.current) {
        confirmingRef.current = false;
        setConfirming(false);
      }
    }
  }

  const ready = phase === 'ready';
  return (
    <section
      data-testid="server-customer-levels"
      aria-labelledby="server-customer-levels-title"
      className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 p-8 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <h2 id="server-customer-levels-title" className="text-2xl font-black text-primary tracking-tight">Server-enforced Customers access</h2>
        <span
          data-testid="server-levels-state"
          data-state={phase}
          className="px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border bg-slate-50 text-slate-600 border-slate-200"
        >
          {PHASE_LABELS[phase]}
        </span>
      </div>
      <p className="text-slate-500 text-sm font-medium mb-4">
        Stored on the store server and enforced on every customer view and create request. Covers the Customers module of the built-in roles only.
      </p>
      {notice !== '' && (
        <p data-testid="server-levels-notice" role="alert" className="text-sm font-bold text-amber-800 mb-4">{notice}</p>
      )}
      <p role="status" aria-live="polite" className="text-sm font-bold text-slate-600 mb-4">{note}</p>

      {(phase === 'unavailable' || phase === 'signed-out' || reconnect) && uid !== null && (
        <button
          type="button"
          data-testid="server-levels-retry"
          onClick={() => { setReconnect(false); void load('initial'); }}
          disabled={saving !== null}
          className="mb-4 px-4 py-2 bg-primary text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50"
        >
          {phase === 'unavailable' ? 'Try again' : 'Reconnect'}
        </button>
      )}

      {ready && (
        <div className="space-y-3">
          {roles.map((entry) => {
            if (!entry.editable) {
              return (
                <div key={entry.roleId} data-testid={`server-level-row-${entry.roleId}`} className="flex flex-wrap items-center gap-3 p-4 rounded-2xl border border-slate-100 bg-slate-50/50">
                  <span className="text-sm font-bold text-slate-700 w-40">{roleName(entry.roleId)}</span>
                  <span className="text-xs font-black text-slate-600">Full — fixed</span>
                </div>
              );
            }
            const roleId = entry.roleId as EditableRoleId;
            const draft = drafts[roleId] ?? entry.level;
            const reason = reasons[roleId] ?? '';
            const reasonOk = 'value' in checkReason(reason);
            const options = PERMISSION_HIERARCHY.filter((l) => CUSTOMER_LEVELS.includes(l) || l === entry.level) as RoleLevel[];
            const status = statuses[roleId];
            const busy = saving !== null || confirming;
            const changed = draft !== entry.level || status?.tone === 'confirm';
            const canSave = !busy && changed && reasonOk;
            const selectId = `server-level-select-${roleId}`;
            const reasonId = `server-level-reason-${roleId}`;
            const hintId = `server-level-hint-${roleId}`;
            const reasonRule = `a reason of ${REASON_MIN}–${REASON_MAX} characters`;
            const hint = busy ? '' : !changed && !reasonOk ? `To save, choose a new level and enter ${reasonRule}.`
              : !changed ? 'To save, choose a new level.' : !reasonOk ? `To save, enter ${reasonRule}.` : '';
            return (
              <div key={roleId} data-testid={`server-level-row-${roleId}`} className="p-4 rounded-2xl border border-slate-100 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-bold text-slate-700 w-40">{roleName(roleId)}</span>
                  <span className="text-xs font-bold text-slate-600">Server level: <span className="font-black">{LEVEL_LABELS[entry.level]}</span></span>
                  <span className="px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border bg-slate-50 text-slate-500 border-slate-200">
                    {entry.source === 'stored' ? 'Custom' : 'Default'}
                  </span>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={selectId} className="text-[10px] font-black text-slate-400 uppercase tracking-widest">New level</label>
                    <select
                      id={selectId}
                      data-testid={selectId}
                      value={draft}
                      disabled={busy}
                      onChange={(e) => {
                        const value = e.target.value as RoleLevel;
                        if (!options.includes(value)) return;
                        setDrafts((prev) => ({ ...prev, [roleId]: value }));
                        setStatus(roleId, 'idle', value === entry.level ? '' : 'Not saved yet.', entry.level);
                      }}
                      className="text-xs font-bold px-3 py-2 rounded-lg border border-slate-200 bg-white disabled:opacity-50"
                    >
                      {options.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1 flex-1 min-w-[14rem]">
                    <label htmlFor={reasonId} className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Reason (required, {REASON_MIN}–{REASON_MAX} characters)</label>
                    <input
                      id={reasonId}
                      data-testid={reasonId}
                      type="text"
                      value={reason}
                      disabled={busy}
                      onChange={(e) => setReasons((prev) => ({ ...prev, [roleId]: e.target.value }))}
                      className="text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white disabled:opacity-50"
                    />
                  </div>
                  <button
                    type="button"
                    data-testid={`server-level-save-${roleId}`}
                    disabled={!canSave}
                    aria-describedby={hintId}
                    onClick={() => { void save(roleId); }}
                    className="px-4 py-2 bg-primary text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Save to server
                  </button>
                </div>
                <p id={hintId} data-testid={hintId} className="text-[11px] font-medium text-slate-500 min-h-[1rem]">{hint}</p>
                <p
                  data-testid={`server-level-status-${roleId}`}
                  data-status={status?.tone ?? 'idle'}
                  aria-live="polite"
                  className="text-xs font-bold text-slate-600 min-h-[1rem]"
                >
                  {status?.text ?? ''}
                </p>
                {stepUp?.roleId === roleId && (
                  <div
                    role="group"
                    aria-labelledby={`server-level-reauth-title-${roleId}`}
                    data-testid="server-level-reauth-group"
                    className="flex flex-wrap items-end gap-3 p-3 rounded-xl bg-amber-50 border border-amber-100"
                  >
                    <p id={`server-level-reauth-title-${roleId}`} className="w-full text-xs font-black text-amber-900">Confirm your sign-in to save this change</p>
                    {stepUp.method === 'password' && (
                      <div className="flex flex-col gap-1">
                        <label htmlFor={`server-level-reauth-password-${roleId}`} className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Your password</label>
                        <input
                          ref={passwordRef}
                          id={`server-level-reauth-password-${roleId}`}
                          data-testid="server-level-reauth-password"
                          type="password"
                          autoComplete="current-password"
                          value={password}
                          disabled={confirming}
                          onChange={(e) => setPassword(e.target.value)}
                          className="text-xs px-3 py-2 rounded-lg border border-slate-200 bg-white"
                        />
                      </div>
                    )}
                    {stepUp.method === null ? (
                      <p className="text-xs font-bold text-amber-800">Sign out and sign in again, then save this change.</p>
                    ) : (
                      <>
                        <button
                          ref={confirmRef}
                          type="button"
                          data-testid="server-level-reauth-confirm"
                          disabled={confirming || (stepUp.method === 'password' && password.length === 0)}
                          aria-describedby="server-level-reauth-hint"
                          onClick={() => { void confirmSignIn(); }}
                          className="px-4 py-2 bg-amber-600 text-white text-xs font-black uppercase tracking-widest rounded-xl disabled:opacity-50"
                        >
                          {stepUp.method === 'password' ? 'Confirm sign-in' : 'Sign in with Google again'}
                        </button>
                        <p id="server-level-reauth-hint" data-testid="server-level-reauth-hint" className="w-full text-[11px] font-medium text-amber-800 min-h-[1rem]">
                          {stepUp.method === 'google'
                            ? 'A Google sign-in window opens.'
                            : password.length === 0 ? 'Enter your password to confirm your sign-in.' : ''}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
