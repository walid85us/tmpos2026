import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import { getAvailableProviders } from '../shipping/providerRegistry';
import * as shippingApi from '../shipping/shippingApiClient';
import type { ShippingProviderConfig, ShippingProviderCredentials } from '../types';
import PageShell from './PageShell';

const PROVIDER_ICONS: Record<string, string> = {
  easypost: 'local_shipping',
  shippo: 'package_2',
  shipstation: 'hub',
};

const PROVIDER_COLORS: Record<string, { bg: string; border: string; text: string; activeBg: string }> = {
  easypost: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', activeBg: 'bg-blue-600' },
  shippo: { bg: 'bg-teal-50', border: 'border-teal-200', text: 'text-teal-700', activeBg: 'bg-teal-600' },
  shipstation: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', activeBg: 'bg-orange-600' },
};

export default function ShippingProvidersPage({ embedded = false, onProviderChange }: { embedded?: boolean; onProviderChange?: () => void }) {
  const { setShippingProviderConfig, shippingServiceAvailability, setShippingServiceAvailability } = useStoreLocalState();
  const { checkSubPermission, isWriteBlocked } = useAccess();
  const canManage = checkSubPermission('manage_shipping_settings');
  // Phase 4.0 M3 — the backend that served provider configuration was eliminated.
  // Every write here (save / test / activate / deactivate / delete) needed it, so
  // unavailability is folded into the same gate that already blocks writes.
  //
  // Availability is read from shared state and is THREE-valued. It was a local
  // `useState(false)`, which cannot tell "not probed yet" from "probed, and reachable" —
  // so the entire pre-probe window read as available and let writes through. Only an
  // explicit `available` opens the gate; `unknown` fails closed.
  const serviceUnavailable = shippingServiceAvailability === 'unavailable';
  const writesBlocked = isWriteBlocked || shippingServiceAvailability !== 'available';
  const location = useLocation();
  const navigate = useNavigate();
  const isShippingContext = location.pathname.startsWith('/shipping/');

  // Phase 4.0 M3 — memoised: this returned a fresh array literal on every
  // render, which made `fetchStatus` unstable, which refired its effect every
  // render — an unbounded request loop. Static catalog data, so [] deps.
  const availableProviders = useMemo(() => getAvailableProviders(), []);

  const [providersState, setProvidersState] = useState<{
    providers: {
      providerId: string;
      providerName: string;
      status: 'configured' | 'not_configured';
      environment?: string;
      configuredAt?: string;
      updatedAt?: string;
      maskedCredentials?: Record<string, string>;
      testResult?: 'success' | 'failure';
      testMessage?: string;
      lastTestedAt?: string;
    }[];
    activeProviderId: string | null;
  }>({ providers: [], activeProviderId: null });

  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [credentialInputs, setCredentialInputs] = useState<Record<string, string>>({});
  const [environmentInput, setEnvironmentInput] = useState<'test' | 'production'>('test');
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ providerId: string; success: boolean; message: string } | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A mutating action is in flight. Cleared in `finally` on every path, so the controls
  // can never be left permanently inert by a failure.
  const [actionPending, setActionPending] = useState(false);
  // A real action failure that is NOT the migration condition — kept distinct so the two
  // are never conflated in the UI.
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const status = await shippingApi.getProvidersStatus();
      // Phase 4.0 M3 — an unavailable service returns an EMPTY provider list, which
      // is byte-identical to a genuinely unconfigured store. Reading `success` is
      // the only way to tell them apart, and the operator must be told which it is:
      // "not configured" invites them to configure something that cannot be saved.
      if (status.success === false) {
        setShippingServiceAvailability('unavailable');
        // `providersState` is this page's view of what the SERVICE reported, so clearing
        // it is correct — the service reported nothing. `shippingProviderConfig` is what
        // the STORE configured, which an outage cannot change. Nulling it here recorded
        // "service down" as "no provider configured" and made recovery require re-entering
        // credentials that were never lost.
        setProvidersState({ providers: [], activeProviderId: null });
        setLoading(false);
        return;
      }
      setShippingServiceAvailability('available');
      setProvidersState({
        providers: status.providers.map(p => ({
          providerId: p.providerId,
          providerName: availableProviders.find(ap => ap.id === p.providerId)?.name || p.providerId,
          status: 'configured' as const,
          environment: p.environment,
          configuredAt: p.configuredAt,
          updatedAt: p.updatedAt,
          maskedCredentials: p.maskedCredentials,
          testResult: p.lastTestResult === 'success' ? 'success' as const : p.lastTestResult === 'failed' ? 'failure' as const : undefined,
          lastTestedAt: p.lastTestedAt,
        })),
        activeProviderId: status.activeProviderId,
      });

      if (status.activeProviderId) {
        const activeProv = status.providers.find(p => p.providerId === status.activeProviderId);
        if (activeProv) {
          setShippingProviderConfig({
            providerId: activeProv.providerId,
            providerName: availableProviders.find(ap => ap.id === activeProv.providerId)?.name || activeProv.providerId,
            status: 'configured',
            isDefault: false,
            credentials: {} as ShippingProviderCredentials,
            credentialsMasked: activeProv.maskedCredentials || {},
            environment: (activeProv.environment as 'test' | 'production') || 'test',
            configuredAt: activeProv.configuredAt || '',
            configuredBy: 'Current User',
            updatedAt: activeProv.updatedAt || '',
          });
        }
      } else {
        setShippingProviderConfig(null);
      }
    } catch {
      // Never swallow: a failure here is reported as unavailable, not as an
      // empty (and therefore "unconfigured-looking") store. Same rule as above —
      // the stored configuration is not touched.
      setShippingServiceAvailability('unavailable');
      setProvidersState({ providers: [], activeProviderId: null });
    } finally {
      setLoading(false);
    }
  }, [availableProviders, setShippingProviderConfig, setShippingServiceAvailability]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  function getProviderConfig(providerId: string) {
    return providersState.providers.find(p => p.providerId === providerId);
  }

  function openConfigurePanel(providerId: string) {
    const existing = getProviderConfig(providerId);
    setCredentialInputs({});
    setEnvironmentInput((existing?.environment as 'test' | 'production') || 'test');
    setEditingProvider(providerId);
    setTestResult(null);
  }

  async function handleSaveCredentials(providerId: string) {
    if (writesBlocked || !canManage) return;

    const providerDef = availableProviders.find(p => p.id === providerId);
    if (!providerDef) return;

    const existing = getProviderConfig(providerId);
    const credentials: Record<string, string> = {};

    for (const field of providerDef.requiredFields) {
      const inputValue = credentialInputs[field.key];
      if (inputValue && inputValue.trim()) {
        credentials[field.key] = inputValue.trim();
      } else if (!existing) {
        return;
      }
    }

    if (!existing && !providerDef.requiredFields.every(f => credentials[f.key])) {
      return;
    }

    try {
      const result = await shippingApi.storeProviderCredentials(
        providerId,
        credentials as { apiKey?: string; apiSecret?: string; accountId?: string },
        environmentInput,
      );

      if (result.success === false) {
        // `if (result.success) {…}` with no else made a failed save a SILENT no-op:
        // no message, no error, no state change. Indistinguishable from a save that
        // worked. Nothing here echoes the submitted credential values.
        reportActionFailure(result.error);
        return;
      }
      setCredentialInputs({});
      setSaveSuccess(providerId);
      setTimeout(() => setSaveSuccess(null), 2500);
      await fetchStatus();
      onProviderChange?.();
    } catch (e) {
      const err = (e ?? {}) as { code?: string; message?: string };
      reportActionFailure({ code: err.code, message: e instanceof Error ? e.message : err.message });
    }
  }

  async function handleSetActive(providerId: string) {
    if (writesBlocked || !canManage) return;
    const config = getProviderConfig(providerId);
    if (!config) return;
    try {
      // The result was never bound, so refetch + parent notification ran unconditionally.
      // Both are success signals for a call that may have changed nothing.
      const result = await shippingApi.setActiveProvider(providerId);
      if (result.success === false) {
        reportActionFailure(result.error);
        return;
      }
      await fetchStatus();
      onProviderChange?.();
    } catch (e) {
      const err = (e ?? {}) as { code?: string; message?: string };
      reportActionFailure({ code: err.code, message: e instanceof Error ? e.message : err.message });
    }
  }

  // Phase 4.0 M3 — `handleDeactivate` and `handleRemoveConfig` ignored the client result
  // entirely and swallowed throws, so a failed call ran the success path: refetch (which
  // CLEARS the configured state) and the parent notification. With the containment client
  // every call fails, so "ignored result" means "always lies". They are gated off today;
  // the gate is temporary, and these two must be safe when it lifts.
  //
  // `handleSaveCredentials`, `handleSetActive` and `handleTestConnection` carried the
  // SAME defect class (no else-branch on `success:false`; unconditional
  // `onProviderChange?.()`) and are now closed alongside these two. Every handler in
  // this file routes a failed result through `reportActionFailure` and returns early.
  //
  // Routes a failed action to the state that is actually true. SHIPPING_UNAVAILABLE is the
  // migration condition; anything else is a real error and must not be dressed up as one.
  // A provider can reflect a rejected key back inside its own error text, and that text
  // is rendered. Suppressing the message entirely would destroy a real diagnostic, and a
  // fixed generic string would hide genuine provider errors — but we know exactly what
  // was submitted, so scrub those values and keep the rest of the message.
  // Literal split/join, not a regex: a credential can contain regex metacharacters.
  function redactSubmittedSecrets(message?: string): string | undefined {
    if (!message) return message;
    return Object.values(credentialInputs)
      .map(v => v?.trim())
      // Very short values would redact incidental substrings out of ordinary prose.
      .filter((v): v is string => !!v && v.length >= 4)
      .reduce((msg, secret) => msg.split(secret).join('[redacted]'), message);
  }

  function reportActionFailure(error?: { code?: string; message?: string }) {
    if (error?.code === shippingApi.SHIPPING_UNAVAILABLE_CODE) {
      setShippingServiceAvailability('unavailable');
      setActionError(null);
    } else {
      setActionError(redactSubmittedSecrets(error?.message) || 'The action could not be completed.');
    }
  }

  async function handleDeactivate() {
    if (writesBlocked || !canManage || actionPending) return;
    setActionPending(true);
    setActionError(null);
    try {
      const result = await shippingApi.setActiveProvider(null);
      if (result.success === false) {
        // No refetch and no parent notification: both are success signals, and the
        // refetch would clear configured state that this failed call never changed.
        reportActionFailure(result.error);
        return;
      }
      await fetchStatus();
      onProviderChange?.();
    } catch (e) {
      // Preserve a coded error. Dropping `code` here downgraded a THROWN
      // SHIPPING_UNAVAILABLE into a generic action error, so the same condition
      // reported two different states depending on whether it was thrown or returned.
      const err = (e ?? {}) as { code?: string; message?: string };
      reportActionFailure({ code: err.code, message: e instanceof Error ? e.message : err.message });
    } finally {
      // Always terminates, on every path — including the early return above.
      setActionPending(false);
    }
  }

  // Stamps a test verdict onto one provider card. Functional update: the previous
  // inline version closed over `providersState`, so a verdict arriving after any other
  // state change would write back a stale provider list.
  function recordTestOutcome(providerId: string, success: boolean, message: string) {
    setProvidersState(prev => ({
      ...prev,
      providers: prev.providers.map(p =>
        p.providerId === providerId
          ? {
              ...p,
              lastTestedAt: new Date().toISOString(),
              testResult: (success ? 'success' : 'failure') as 'success' | 'failure',
              testMessage: message,
            }
          : p,
      ),
    }));
  }

  async function handleTestConnection(providerId: string) {
    if (writesBlocked) return;

    setTestingProvider(providerId);
    setTestResult(null);

    const config = getProviderConfig(providerId);
    if (!config) {
      setTestResult({
        providerId,
        success: false,
        message: 'Provider credentials are not configured. Save credentials first.',
      });
      setTestingProvider(null);
      return;
    }

    try {
      const result = await shippingApi.testConnection(providerId);

      if (result.success === false) {
        // `success:false` carries two different facts, told apart only by the code.
        // SHIPPING_UNAVAILABLE is OUR outage — reporting it as "connection test failed"
        // blames the carrier for our downtime and stamps a failure verdict on the
        // provider card that no test ever produced. Anything else is a real verdict.
        if (result.error.code === shippingApi.SHIPPING_UNAVAILABLE_CODE) {
          reportActionFailure(result.error);
        } else {
          const message = redactSubmittedSecrets(result.error.message) || 'Connection test failed.';
          setTestResult({ providerId, success: false, message });
          recordTestOutcome(providerId, false, message);
        }
        // No parent notification on either path — nothing changed.
        setTestingProvider(null);
        return;
      }

      const message = result.message || 'Connection successful.';
      setTestResult({ providerId, success: true, message });
      recordTestOutcome(providerId, true, message);
      onProviderChange?.();
    } catch (e) {
      // Match the other four handlers: a THROWN coded error must land in the same state
      // as a RETURNED one, or the identical condition reports two different UIs. This
      // catch discarded the error entirely and hardcoded a carrier-blaming message.
      const err = (e ?? {}) as { code?: string; message?: string };
      if (err.code === shippingApi.SHIPPING_UNAVAILABLE_CODE) {
        reportActionFailure(err);
      } else {
        // Phase 4.0 M3 — a THROWN genuine failure must stamp the provider card just as the
        // RETURNED path does (recordTestOutcome), or the identical verdict shows in the
        // inline banner while the card keeps a stale "Connected/Not Tested" badge.
        const message = redactSubmittedSecrets(e instanceof Error ? e.message : err.message)
          || 'Connection test failed — could not reach server.';
        setTestResult({ providerId, success: false, message });
        recordTestOutcome(providerId, false, message);
      }
    }
    setTestingProvider(null);
  }

  async function handleRemoveConfig(providerId: string) {
    if (writesBlocked || !canManage || actionPending) return;
    setActionPending(true);
    setActionError(null);
    try {
      const result = await shippingApi.removeProviderCredentials(providerId);
      if (result.success === false) {
        // Closing the panel is THE success signal for this action — it must not fire on
        // failure, and the config must stay exactly as it was.
        reportActionFailure(result.error);
        return;
      }
      setEditingProvider(null);
      await fetchStatus();
      onProviderChange?.();
    } catch (e) {
      // Preserve a coded error. Dropping `code` here downgraded a THROWN
      // SHIPPING_UNAVAILABLE into a generic action error, so the same condition
      // reported two different states depending on whether it was thrown or returned.
      const err = (e ?? {}) as { code?: string; message?: string };
      reportActionFailure({ code: err.code, message: e instanceof Error ? e.message : err.message });
    } finally {
      setActionPending(false);
    }
  }

  const activeProvider = providersState.providers.find(
    p => p.providerId === providersState.activeProviderId
  );

  const Wrapper = embedded ? React.Fragment : ({ children }: { children: React.ReactNode }) => <PageShell title="Shipping Providers">{children}</PageShell>;

  if (loading) {
    return (
      <Wrapper>
        <div className="flex items-center justify-center py-20">
          <span className="material-symbols-outlined text-slate-300 animate-spin text-2xl">progress_activity</span>
        </div>
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      {!embedded && isShippingContext && (
        <div className="mb-4 flex items-center gap-2">
          <button onClick={() => navigate('/shipping')}
            className="flex items-center gap-1 text-xs font-bold text-primary hover:text-primary/80 transition-all">
            <span className="material-symbols-outlined text-sm">arrow_back</span>
            Back to Shipping Center
          </button>
          <span className="text-slate-300">|</span>
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Shipping &gt; Settings &gt; Providers</span>
        </div>
      )}

      {isWriteBlocked && (
        <div className="mb-6 px-5 py-3 bg-amber-50 border border-amber-200 rounded-2xl flex items-center gap-2">
          <span className="material-symbols-outlined text-amber-500 text-sm">visibility</span>
          <span className="text-xs font-bold text-amber-700">Preview Mode — configuration changes will not be saved.</span>
        </div>
      )}

      {!canManage && (
        <div className="mb-6 px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl flex items-center gap-2">
          <span className="material-symbols-outlined text-slate-400 text-sm">lock</span>
          <span className="text-xs font-bold text-slate-500">You do not have permission to manage shipping settings. Contact your store owner or manager.</span>
        </div>
      )}

      {/* Phase 4.0 M3 — states the real condition: the service is unavailable, NOT
          that this store has no provider configured. Icon + words, no retry offered. */}
      {serviceUnavailable && (
        <div
          data-testid="shipping-service-unavailable"
          role="status"
          aria-live="polite"
          className="mb-6 px-5 py-3 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-2"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-amber-500 text-sm">cloud_off</span>
          <span className="text-xs font-bold text-amber-800">
            Shipping provider services are unavailable while the shipping backend is being rebuilt.
            Saving, testing, activating, and removing provider connections are disabled. This does not
            mean your store has no provider configured — existing settings are untouched. Provider
            configuration will return in Store Settings, managed by the store owner or a store user
            holding the shipping-provider permission.
          </span>
        </div>
      )}

      {/* A genuine action failure that is NOT the migration condition. Assertive, because
          it reports the outcome of something the operator just did. */}
      {actionError && (
        <div
          data-testid="shipping-action-error"
          role="alert"
          className="mb-6 px-5 py-3 bg-red-50 border border-red-200 rounded-2xl flex items-start gap-2"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-red-500 text-sm">error</span>
          <span className="text-xs font-bold text-red-800">{actionError}</span>
        </div>
      )}

      <div className="mb-8 bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-lg">check_circle</span>
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Active Provider</p>
              {activeProvider ? (
                <p className="text-sm font-black text-primary">{activeProvider.providerName}</p>
              ) : serviceUnavailable ? (
                // Unavailable takes precedence: "No provider selected" is a claim about
                // the store's configuration that an unreachable service cannot support.
                <p data-testid="active-provider-unavailable"
                  className="text-sm font-bold text-amber-700 inline-flex items-center gap-1">
                  <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 14 }}>cloud_off</span>
                  Active provider unknown — service unavailable
                </p>
              ) : (
                <p className="text-sm font-bold text-slate-400">No provider selected</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {activeProvider && (
              <>
                <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg ${
                  activeProvider.testResult === 'success'
                    ? 'bg-emerald-100 text-emerald-700'
                    : activeProvider.testResult === 'failure'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-slate-100 text-slate-500'
                }`}>
                  {activeProvider.testResult === 'success' ? 'Verified' : activeProvider.testResult === 'failure' ? 'Test Failed' : 'Not Tested'}
                </span>
                {activeProvider.environment && (
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg ${
                    activeProvider.environment === 'production'
                      ? 'bg-red-50 text-red-600 border border-red-200'
                      : 'bg-sky-50 text-sky-600 border border-sky-200'
                  }`}>
                    {activeProvider.environment}
                  </span>
                )}
                {canManage && !writesBlocked && (
                  <button onClick={handleDeactivate} disabled={actionPending}
                    className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-red-500 bg-red-50 border border-red-200 rounded-xl hover:bg-red-100 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                    Deactivate
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {availableProviders.map(providerDef => {
          const config = getProviderConfig(providerDef.id);
          const isActive = providersState.activeProviderId === providerDef.id;
          const isConfigured = !!config;
          const isEditing = editingProvider === providerDef.id;
          const colors = PROVIDER_COLORS[providerDef.id] || PROVIDER_COLORS.easypost;

          return (
            <div key={providerDef.id} className={`bg-white/80 backdrop-blur-xl rounded-[2.5rem] border shadow-sm overflow-hidden transition-all ${
              isActive ? `${colors.border} ring-2 ring-primary/20` : 'border-slate-200'
            }`}>
              <div className="p-6 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isActive ? colors.activeBg + ' text-white' : colors.bg + ' ' + colors.text}`}>
                    <span className="material-symbols-outlined">{PROVIDER_ICONS[providerDef.id] || 'local_shipping'}</span>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-black text-primary tracking-tight">{providerDef.name}</h3>
                      {isActive && (
                        <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest bg-primary text-white rounded-md">Active</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">{providerDef.description}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Phase 4.0 M3 — an unavailable service returns an EMPTY provider list,
                      so `isConfigured` is false for every provider and this badge asserted
                      "Not Configured" — a claim about the STORE that is not known to be
                      true. Unavailability takes precedence: the badge reports what is
                      actually known. Icon + words, never colour alone. */}
                  {serviceUnavailable ? (
                    <span
                      data-testid="provider-status-unavailable"
                      className="px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md bg-amber-100 text-amber-700 inline-flex items-center gap-1"
                    >
                      <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 11 }}>cloud_off</span>
                      Status Unavailable
                    </span>
                  ) : isConfigured ? (
                    <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md ${
                      config.testResult === 'success' ? 'bg-emerald-100 text-emerald-700'
                      : config.testResult === 'failure' ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                    }`}>
                      {config.testResult === 'success' ? 'Connected' : config.testResult === 'failure' ? 'Error' : 'Configured'}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md bg-slate-100 text-slate-400">
                      Not Configured
                    </span>
                  )}

                  {canManage && (
                    <button onClick={() => isEditing ? setEditingProvider(null) : openConfigurePanel(providerDef.id)}
                      className="px-4 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-600 rounded-xl hover:bg-slate-200 transition-all">
                      {isEditing ? 'Close' : isConfigured ? 'Edit' : 'Configure'}
                    </button>
                  )}

                  {canManage && !writesBlocked && isConfigured && !isActive && (
                    <button onClick={() => handleSetActive(providerDef.id)}
                      className="px-4 py-2 text-[10px] font-black uppercase tracking-widest bg-primary text-white rounded-xl hover:bg-primary/90 transition-all shadow-sm">
                      Set Active
                    </button>
                  )}
                </div>
              </div>

              <AnimatePresence>
                {isEditing && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="px-6 pb-6 pt-2 border-t border-slate-100 space-y-5">
                      {isConfigured && config.maskedCredentials && (
                        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Current Credentials</p>
                          {providerDef.requiredFields.map(field => {
                            const maskedVal = config.maskedCredentials?.[field.key];
                            return maskedVal ? (
                              <div key={field.key} className="flex items-center justify-between">
                                <span className="text-xs text-slate-500 font-bold">{field.label}</span>
                                <span className="text-xs font-mono text-slate-400">{maskedVal}</span>
                              </div>
                            ) : null;
                          })}
                          {config.configuredAt && (
                            <p className="text-[10px] text-slate-400 pt-1">Configured: {new Date(config.configuredAt).toLocaleDateString()}</p>
                          )}
                          {config.updatedAt && config.updatedAt !== config.configuredAt && (
                            <p className="text-[10px] text-slate-400">Last updated: {new Date(config.updatedAt).toLocaleDateString()}</p>
                          )}
                        </div>
                      )}

                      <div className="space-y-3">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                          {isConfigured ? 'Update Credentials' : 'Enter Credentials'}
                        </p>
                        {providerDef.requiredFields.map(field => (
                          <div key={field.key}>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block ml-4">{field.label}</label>
                            <input
                              type={field.type}
                              value={credentialInputs[field.key] || ''}
                              onChange={e => setCredentialInputs(prev => ({ ...prev, [field.key]: e.target.value }))}
                              placeholder={isConfigured ? 'Enter new value to replace' : field.placeholder}
                              className="w-full px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 text-sm"
                              disabled={writesBlocked || !canManage}
                            />
                          </div>
                        ))}
                      </div>

                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block ml-4">Environment</label>
                        <div className="flex gap-2">
                          {(['test', 'production'] as const).map(env => (
                            <button key={env} onClick={() => setEnvironmentInput(env)}
                              disabled={writesBlocked || !canManage}
                              className={`px-4 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${
                                environmentInput === env
                                  ? env === 'production'
                                    ? 'bg-red-600 text-white'
                                    : 'bg-sky-600 text-white'
                                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                              }`}>
                              {env}
                            </button>
                          ))}
                        </div>
                        {environmentInput === 'production' && (
                          <p className="text-[10px] text-red-500 font-medium mt-1.5 ml-4">Production credentials will process real shipments and incur charges.</p>
                        )}
                      </div>

                      {testResult && testResult.providerId === providerDef.id && (
                        <div className={`px-4 py-3 rounded-xl flex items-start gap-2 ${
                          testResult.success
                            ? 'bg-emerald-50 border border-emerald-200'
                            : 'bg-red-50 border border-red-200'
                        }`}>
                          <span className={`material-symbols-outlined text-sm mt-0.5 ${testResult.success ? 'text-emerald-500' : 'text-red-500'}`}>
                            {testResult.success ? 'check_circle' : 'error'}
                          </span>
                          <p className={`text-xs font-medium ${testResult.success ? 'text-emerald-700' : 'text-red-700'}`}>
                            {testResult.message}
                          </p>
                        </div>
                      )}

                      <div className="flex items-center gap-2 pt-2">
                        {canManage && !writesBlocked && (
                          <>
                            <button
                              onClick={() => handleSaveCredentials(providerDef.id)}
                              disabled={
                                !isConfigured && !providerDef.requiredFields.every(f => credentialInputs[f.key]?.trim())
                              }
                              className={`px-6 py-3 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all shadow-sm active:scale-95 ${
                                saveSuccess === providerDef.id
                                  ? 'bg-emerald-500 text-white'
                                  : 'bg-primary text-white hover:bg-primary/90 shadow-primary/20'
                              } disabled:opacity-40 disabled:cursor-not-allowed`}>
                              {saveSuccess === providerDef.id ? 'Saved!' : 'Save Credentials'}
                            </button>

                            <button
                              onClick={() => handleTestConnection(providerDef.id)}
                              disabled={!isConfigured || testingProvider === providerDef.id}
                              className="px-6 py-3 text-[10px] font-black uppercase tracking-widest rounded-xl bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1">
                              <span className="material-symbols-outlined text-sm">
                                {testingProvider === providerDef.id ? 'hourglass_top' : 'wifi_tethering'}
                              </span>
                              {testingProvider === providerDef.id ? 'Testing...' : 'Test Connection'}
                            </button>

                            {isConfigured && (
                              <button
                                onClick={() => handleRemoveConfig(providerDef.id)}
                                disabled={actionPending}
                                className="px-4 py-3 text-[10px] font-black uppercase tracking-widest rounded-xl bg-white border border-red-200 text-red-500 hover:bg-red-50 transition-all ml-auto disabled:opacity-40 disabled:cursor-not-allowed">
                                Remove
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </Wrapper>
  );
}
