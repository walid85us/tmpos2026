import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import { getAvailableProviders, getProvider } from '../shipping/providerRegistry';
import type { ShippingProviderConfig, ShippingProviderCredentials } from '../types';
import PageShell from './PageShell';

function maskSecret(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••••••' + value.slice(-4);
}

function buildMaskedDisplay(creds: ShippingProviderCredentials) {
  return {
    apiKey: creds.apiKey ? maskSecret(creds.apiKey) : undefined,
    apiSecret: creds.apiSecret ? maskSecret(creds.apiSecret) : undefined,
    accountId: creds.accountId ? maskSecret(creds.accountId) : undefined,
  };
}

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

export default function ShippingProvidersPage() {
  const { shippingProviderConfig, setShippingProviderConfig } = useStoreLocalState();
  const { checkSubPermission, isWriteBlocked } = useAccess();
  const canManage = checkSubPermission('manage_shipping_settings');

  const availableProviders = getAvailableProviders();

  const [providersState, setProvidersState] = useState<{
    providers: ShippingProviderConfig[];
    activeProviderId: string | null;
  }>(() => {
    try {
      const stored = sessionStorage.getItem('shipping_providers_state');
      if (stored) return JSON.parse(stored);
    } catch {}
    return { providers: [], activeProviderId: null };
  });

  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [credentialInputs, setCredentialInputs] = useState<Record<string, string>>({});
  const [environmentInput, setEnvironmentInput] = useState<'test' | 'production'>('test');
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ providerId: string; success: boolean; message: string } | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const persistState = useCallback((newState: typeof providersState) => {
    setProvidersState(newState);
    const sanitized = {
      ...newState,
      providers: newState.providers.map(p => ({
        ...p,
        credentials: {} as ShippingProviderCredentials,
      })),
    };
    sessionStorage.setItem('shipping_providers_state', JSON.stringify(sanitized));
    const active = newState.providers.find(p => p.providerId === newState.activeProviderId);
    setShippingProviderConfig(active || null);
  }, [setShippingProviderConfig]);

  function getProviderConfig(providerId: string): ShippingProviderConfig | undefined {
    return providersState.providers.find(p => p.providerId === providerId);
  }

  function openConfigurePanel(providerId: string) {
    const existing = getProviderConfig(providerId);
    setCredentialInputs({});
    setEnvironmentInput(existing?.environment || 'test');
    setEditingProvider(providerId);
    setTestResult(null);
  }

  function handleSaveCredentials(providerId: string) {
    if (isWriteBlocked || !canManage) return;

    const providerDef = availableProviders.find(p => p.id === providerId);
    if (!providerDef) return;

    const existing = getProviderConfig(providerId);
    const newCredentials: ShippingProviderCredentials = {
      ...(existing?.credentials || {}),
      environment: environmentInput,
    };

    for (const field of providerDef.requiredFields) {
      const inputValue = credentialInputs[field.key];
      if (inputValue && inputValue.trim()) {
        (newCredentials as Record<string, string>)[field.key] = inputValue.trim();
      } else if (!existing?.credentials?.[field.key as keyof ShippingProviderCredentials]) {
        return;
      }
    }

    const hasAllRequired = providerDef.requiredFields.every(
      f => (newCredentials as Record<string, string>)[f.key]
    );

    const now = new Date().toISOString();
    const updatedConfig: ShippingProviderConfig = {
      providerId,
      providerName: providerDef.name,
      status: hasAllRequired ? 'configured' : 'not_configured',
      isDefault: false,
      credentials: newCredentials,
      credentialsMasked: buildMaskedDisplay(newCredentials),
      environment: environmentInput,
      configuredAt: existing?.configuredAt || now,
      configuredBy: 'Current User',
      updatedAt: now,
      lastTestedAt: existing?.lastTestedAt,
      testResult: existing?.testResult,
      testMessage: existing?.testMessage,
    };

    sessionStorage.setItem(`shipping_provider_${providerId}`, JSON.stringify(newCredentials));

    const newProviders = providersState.providers.filter(p => p.providerId !== providerId);
    newProviders.push(updatedConfig);

    persistState({
      ...providersState,
      providers: newProviders,
    });

    setCredentialInputs({});
    setSaveSuccess(providerId);
    setTimeout(() => setSaveSuccess(null), 2500);
  }

  function handleSetActive(providerId: string) {
    if (isWriteBlocked || !canManage) return;

    const config = getProviderConfig(providerId);
    if (!config || config.status === 'not_configured') return;

    persistState({
      ...providersState,
      activeProviderId: providerId,
    });
  }

  function handleDeactivate() {
    if (isWriteBlocked || !canManage) return;

    persistState({
      ...providersState,
      activeProviderId: null,
    });
  }

  async function handleTestConnection(providerId: string) {
    if (isWriteBlocked) return;

    setTestingProvider(providerId);
    setTestResult(null);

    const config = getProviderConfig(providerId);
    if (!config || config.status === 'not_configured') {
      setTestResult({
        providerId,
        success: false,
        message: 'Provider credentials are not configured. Save credentials first.',
      });
      setTestingProvider(null);
      return;
    }

    const provider = getProvider(providerId);
    if (!provider) {
      setTestResult({
        providerId,
        success: false,
        message: 'Provider adapter not available.',
      });
      setTestingProvider(null);
      return;
    }

    const testAddress = {
      name: 'Test User',
      line1: '417 Montgomery St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94104',
      country: 'US',
    };

    const result = await provider.validateAddress(testAddress);

    const now = new Date().toISOString();
    const success = result.success;
    const message = success
      ? 'Connection successful — provider responded to address validation test.'
      : result.error?.message || 'Connection test failed.';

    setTestResult({ providerId, success, message });

    const newProviders = providersState.providers.map(p =>
      p.providerId === providerId
        ? {
            ...p,
            lastTestedAt: now,
            testResult: (success ? 'success' : 'failure') as 'success' | 'failure',
            testMessage: message,
            status: (success ? 'configured' : p.status) as ShippingProviderConfig['status'],
          }
        : p
    );

    persistState({ ...providersState, providers: newProviders });
    setTestingProvider(null);
  }

  function handleRemoveConfig(providerId: string) {
    if (isWriteBlocked || !canManage) return;

    sessionStorage.removeItem(`shipping_provider_${providerId}`);

    const newProviders = providersState.providers.filter(p => p.providerId !== providerId);
    const newActive = providersState.activeProviderId === providerId ? null : providersState.activeProviderId;

    persistState({ providers: newProviders, activeProviderId: newActive });
    setEditingProvider(null);
  }

  const activeProvider = providersState.providers.find(
    p => p.providerId === providersState.activeProviderId
  );

  return (
    <PageShell title="Shipping Providers">
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

      <div className="mb-8 bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-lg">check_circle</span>
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Active Provider</p>
              {activeProvider ? (
                <p className="text-sm font-black text-primary">{activeProvider.providerName}</p>
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
                {canManage && !isWriteBlocked && (
                  <button onClick={handleDeactivate}
                    className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-red-500 bg-red-50 border border-red-200 rounded-xl hover:bg-red-100 transition-all">
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
          const isConfigured = config && config.status !== 'not_configured';
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
                  {isConfigured && (
                    <span className={`px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-md ${
                      config.testResult === 'success' ? 'bg-emerald-100 text-emerald-700'
                      : config.testResult === 'failure' ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                    }`}>
                      {config.testResult === 'success' ? 'Connected' : config.testResult === 'failure' ? 'Error' : 'Configured'}
                    </span>
                  )}
                  {!isConfigured && (
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

                  {canManage && !isWriteBlocked && isConfigured && !isActive && (
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
                      {isConfigured && config.credentialsMasked && (
                        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
                          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Current Credentials</p>
                          {providerDef.requiredFields.map(field => {
                            const maskedVal = config.credentialsMasked?.[field.key as keyof typeof config.credentialsMasked];
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
                              disabled={isWriteBlocked || !canManage}
                            />
                          </div>
                        ))}
                      </div>

                      <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 block ml-4">Environment</label>
                        <div className="flex gap-2">
                          {(['test', 'production'] as const).map(env => (
                            <button key={env} onClick={() => setEnvironmentInput(env)}
                              disabled={isWriteBlocked || !canManage}
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
                        {canManage && !isWriteBlocked && (
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
                                className="px-4 py-3 text-[10px] font-black uppercase tracking-widest rounded-xl bg-white border border-red-200 text-red-500 hover:bg-red-50 transition-all ml-auto">
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
    </PageShell>
  );
}
