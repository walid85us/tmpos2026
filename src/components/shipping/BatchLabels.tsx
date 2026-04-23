import React, { useMemo, useState } from 'react';
import type { Shipment, ShipmentBatch, BatchLabelResult } from '../../types';

export interface BatchEligibility {
  eligible: boolean;
  reasons: string[];
}

interface Props {
  shipments: Shipment[];
  batches: ShipmentBatch[];
  canManage: boolean;
  canPurchase: boolean;
  currentUser: string;
  evaluateEligibility: (s: Shipment) => BatchEligibility;
  onCreateBatch: (batch: ShipmentBatch) => void;
  onUpdateBatch: (id: string, updates: Partial<ShipmentBatch>) => void;
  onPurchaseSingle: (shipmentId: string) => Promise<{ ok: boolean; reason?: string; trackingNumber?: string; carrier?: string; service?: string; cost?: number }>;
  planAllowsShippingProviders: boolean;
}

export default function BatchLabels({
  shipments, batches, canManage, canPurchase, currentUser,
  evaluateEligibility, onCreateBatch, onUpdateBatch, onPurchaseSingle, planAllowsShippingProviders,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set<string>());
  const [batchName, setBatchName] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const [filter, setFilter] = useState<'eligible' | 'ready_for_batch' | 'ineligible' | 'all'>('eligible');

  const evaluated = useMemo(() => {
    return shipments
      .filter(s => !s.label && s.status !== 'Cancelled' && s.status !== 'Delivered')
      .map(s => ({ shipment: s, eligibility: evaluateEligibility(s) }));
  }, [shipments, evaluateEligibility]);

  const filtered = useMemo(() => {
    if (filter === 'all') return evaluated;
    if (filter === 'eligible') return evaluated.filter(x => x.eligibility.eligible);
    if (filter === 'ineligible') return evaluated.filter(x => !x.eligibility.eligible);
    if (filter === 'ready_for_batch') return evaluated.filter(x => x.shipment.batchQueueState === 'ready_for_batch');
    return evaluated;
  }, [evaluated, filter]);

  const eligibleCount = evaluated.filter(x => x.eligibility.eligible).length;
  const readyCount = evaluated.filter(x => x.shipment.batchQueueState === 'ready_for_batch').length;
  const ineligibleCount = evaluated.filter(x => !x.eligibility.eligible).length;

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAllEligible() {
    setSelected(new Set(evaluated.filter(x => x.eligibility.eligible).map(x => x.shipment.id)));
  }

  function clearSelection() { setSelected(new Set()); }

  async function processBatch() {
    if (selected.size === 0) return;
    const ids: string[] = Array.from(selected) as string[];
    const now = new Date().toISOString();
    const batch: ShipmentBatch = {
      id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: batchName.trim() || `Batch ${new Date().toLocaleString()}`,
      status: 'processing',
      shipmentIds: ids,
      results: [],
      createdAt: now,
      createdBy: currentUser,
      startedAt: now,
    };
    onCreateBatch(batch);
    setRunning(batch.id);

    const results: BatchLabelResult[] = [];
    for (const id of ids) {
      const ship = shipments.find(s => s.id === id);
      if (!ship) {
        results.push({ shipmentId: id, shipmentNumber: id, outcome: 'skipped', reason: 'Shipment not found', timestamp: new Date().toISOString() });
        continue;
      }
      const elig = evaluateEligibility(ship);
      if (!elig.eligible) {
        results.push({
          shipmentId: id, shipmentNumber: ship.shipmentNumber, outcome: 'skipped',
          reason: elig.reasons.join('; '), timestamp: new Date().toISOString(),
        });
        onUpdateBatch(batch.id, { results: [...results] });
        continue;
      }
      try {
        const r = await onPurchaseSingle(id);
        results.push({
          shipmentId: id, shipmentNumber: ship.shipmentNumber,
          outcome: r.ok ? 'success' : 'failed',
          reason: r.ok ? undefined : (r.reason || 'Label purchase failed'),
          trackingNumber: r.trackingNumber, carrier: r.carrier, service: r.service, cost: r.cost,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        results.push({
          shipmentId: id, shipmentNumber: ship.shipmentNumber, outcome: 'failed',
          reason: err?.message || 'Unexpected error', timestamp: new Date().toISOString(),
        });
      }
      onUpdateBatch(batch.id, { results: [...results] });
    }

    const hasFailed = results.some(r => r.outcome === 'failed');
    const finalStatus = hasFailed ? 'completed_with_errors' : 'completed';
    onUpdateBatch(batch.id, {
      status: finalStatus, results, completedAt: new Date().toISOString(),
    });
    setRunning(null);
    setSelected(new Set());
    setBatchName('');
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">layers</span>Batch Labels
            </p>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">
              Multi-shipment label purchase. The batch is processed as an itemized, app-level iteration over each
              shipment's individual label purchase — there is no provider-native bulk API. Each shipment's
              eligibility is evaluated with the same prerequisites as the single-shipment flow, and per-shipment
              outcomes (success / failed / skipped) are reported individually.
            </p>
          </div>
        </div>

        {!planAllowsShippingProviders && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-xs text-amber-700">
            <span className="font-black">Provider not included in plan.</span> Batch label purchase requires the
            Shipping Provider Configuration plan feature. You can still assemble batches and view eligibility, but
            execution is disabled until the provider feature is enabled.
          </div>
        )}

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <button onClick={() => setFilter('eligible')} className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${filter === 'eligible' ? 'bg-primary text-white border-primary' : 'border-slate-200 text-slate-500'}`}>Eligible ({eligibleCount})</button>
          <button onClick={() => setFilter('ready_for_batch')} className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${filter === 'ready_for_batch' ? 'bg-primary text-white border-primary' : 'border-slate-200 text-slate-500'}`}>Ready-for-Batch ({readyCount})</button>
          <button onClick={() => setFilter('ineligible')} className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${filter === 'ineligible' ? 'bg-primary text-white border-primary' : 'border-slate-200 text-slate-500'}`}>Ineligible ({ineligibleCount})</button>
          <button onClick={() => setFilter('all')} className={`px-2.5 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${filter === 'all' ? 'bg-primary text-white border-primary' : 'border-slate-200 text-slate-500'}`}>All ({evaluated.length})</button>
          <div className="flex-1" />
          {canManage && (
            <>
              <button onClick={selectAllEligible} className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline">Select All Eligible</button>
              <button onClick={clearSelection} className="text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-700">Clear</button>
            </>
          )}
        </div>

        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left">{canManage && <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Sel</span>}</th>
                <th className="px-3 py-2 text-left text-[9px] font-black uppercase tracking-widest text-slate-400">Shipment</th>
                <th className="px-3 py-2 text-left text-[9px] font-black uppercase tracking-widest text-slate-400">Status</th>
                <th className="px-3 py-2 text-left text-[9px] font-black uppercase tracking-widest text-slate-400">Carrier</th>
                <th className="px-3 py-2 text-left text-[9px] font-black uppercase tracking-widest text-slate-400">Eligibility</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400 italic">No shipments in this view.</td></tr>
              ) : filtered.map(({ shipment: s, eligibility }) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    {canManage && eligibility.eligible && (
                      <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-bold text-slate-700">{s.shipmentNumber}</div>
                    <div className="text-[10px] text-slate-400">{s.sourceType} · {s.sourceNumber}</div>
                    {s.batchQueueState === 'ready_for_batch' && (
                      <span className="inline-block mt-1 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded bg-indigo-50 text-indigo-700 border border-indigo-100">Ready for Batch</span>
                    )}
                    {s.priority && s.priority !== 'normal' && (
                      <span className={`ml-1 inline-block mt-1 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded ${s.priority === 'urgent' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>{s.priority}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{s.status}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {s.carrier || s.selectedRate?.carrier || '—'}
                    {(s.serviceLevel || s.selectedRate?.serviceName) && <div className="text-[10px] text-slate-400">{s.serviceLevel || s.selectedRate?.serviceName}</div>}
                  </td>
                  <td className="px-3 py-2">
                    {eligibility.eligible ? (
                      <span className="px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-emerald-100 text-emerald-700">Eligible</span>
                    ) : (
                      <div>
                        <span className="px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-amber-100 text-amber-700">Not Eligible</span>
                        <ul className="text-[10px] text-slate-500 mt-1 list-disc list-inside">
                          {eligibility.reasons.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canManage && (
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            <input value={batchName} onChange={e => setBatchName(e.target.value)} placeholder="Batch name (optional)"
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 flex-1 min-w-[200px]" />
            <span className="text-xs text-slate-500">{selected.size} selected</span>
            <button
              onClick={processBatch}
              disabled={!canPurchase || !planAllowsShippingProviders || selected.size === 0 || running !== null}
              className="px-3 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg bg-primary text-white disabled:opacity-40 flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">play_arrow</span>
              {running ? 'Processing…' : `Purchase ${selected.size} Label${selected.size === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
        {canManage && !canPurchase && selected.size > 0 && (
          <p className="text-[11px] text-amber-600 mt-2">You can assemble a batch but lack the Purchase Batch Labels permission to execute it.</p>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6">
        <p className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1.5">
          <span className="material-symbols-outlined text-sm">history</span>Batch History ({batches.length})
        </p>
        {batches.length === 0 ? (
          <p className="text-xs text-slate-400 italic mt-2">No batches run yet.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {batches.map(batch => {
              const successCount = batch.results.filter(r => r.outcome === 'success').length;
              const failedCount = batch.results.filter(r => r.outcome === 'failed').length;
              const skippedCount = batch.results.filter(r => r.outcome === 'skipped').length;
              return (
                <div key={batch.id} className="border border-slate-200 rounded-xl p-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <div className="text-sm font-bold text-slate-700">{batch.name}</div>
                      <div className="text-[11px] text-slate-500">
                        {new Date(batch.createdAt).toLocaleString()} · {batch.shipmentIds.length} shipment{batch.shipmentIds.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={`px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded ${batch.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : batch.status === 'completed_with_errors' ? 'bg-amber-100 text-amber-700' : batch.status === 'processing' ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-500'}`}>{batch.status.replace(/_/g, ' ')}</span>
                      {batch.status !== 'processing' && (
                        <>
                          <span className="text-[10px] text-emerald-700">✓ {successCount}</span>
                          <span className="text-[10px] text-rose-700">✗ {failedCount}</span>
                          <span className="text-[10px] text-slate-500">⊘ {skippedCount}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {batch.results.length > 0 && (
                    <details className="mt-2">
                      <summary className="text-[10px] font-black uppercase tracking-widest text-primary cursor-pointer">Itemized Results</summary>
                      <div className="mt-2 max-h-60 overflow-y-auto">
                        <table className="w-full text-[11px]">
                          <thead className="bg-slate-50">
                            <tr>
                              <th className="px-2 py-1 text-left text-[9px] font-black uppercase tracking-widest text-slate-400">Shipment</th>
                              <th className="px-2 py-1 text-left text-[9px] font-black uppercase tracking-widest text-slate-400">Outcome</th>
                              <th className="px-2 py-1 text-left text-[9px] font-black uppercase tracking-widest text-slate-400">Detail</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {batch.results.map((r, i) => (
                              <tr key={i}>
                                <td className="px-2 py-1 font-mono">{r.shipmentNumber}</td>
                                <td className="px-2 py-1">
                                  <span className={`px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded ${r.outcome === 'success' ? 'bg-emerald-100 text-emerald-700' : r.outcome === 'failed' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500'}`}>{r.outcome}</span>
                                </td>
                                <td className="px-2 py-1 text-slate-600">
                                  {r.outcome === 'success' && r.trackingNumber ? `${r.carrier || ''} ${r.service || ''} · ${r.trackingNumber}` : (r.reason || '')}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
