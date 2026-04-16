import { useState } from 'react';

/**
 * TrackingNumber — the single source of truth for rendering a carrier tracking
 * number anywhere in the app (Shipping Center list, Shipping Center detail,
 * Provider & Operations, Returns Portal linked-shipment chip, webhook log, etc.).
 *
 * Invariants enforced by this component:
 *   1. The full tracking number is always rendered verbatim — no masking, no
 *      truncation, no slice/substring, no padding. Whatever string the provider
 *      returned is exactly what the operator sees.
 *   2. There is NO carrier conditional. UPS, FedEx, USPS, DHL, and any other
 *      carrier all render through the identical code path. Carrier-specific
 *      masking is impossible by construction — there is no branch to insert it
 *      into.
 *   3. The value is `select-all` monospace so the operator can copy the full
 *      carrier reference with one gesture, and an explicit copy button is
 *      rendered when `copyable` is true.
 *   4. Permission safety is enforced upstream by the caller (canAccess /
 *      canSyncTracking / returns RBAC). This component assumes the caller has
 *      already decided the current operator is authorized to see the tracking
 *      value — it never gates or obscures on its own.
 */
export interface TrackingNumberProps {
  value: string;
  /** Visual size token. `sm` = list chip, `md` = detail rows. Default `md`. */
  size?: 'sm' | 'md';
  /** Tailwind color class for the tracking text. Default `text-slate-700`. */
  colorClass?: string;
  /** When true, renders a copy-to-clipboard icon button next to the value. */
  copyable?: boolean;
  /** Optional label (e.g. "Tracking"). When provided, the label is rendered before the value. */
  label?: string;
  /** Optional extra className on the outer wrapper. */
  className?: string;
}

export function TrackingNumber({
  value,
  size = 'md',
  colorClass = 'text-slate-700',
  copyable = false,
  label,
  className = '',
}: TrackingNumberProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* noop */ });
  }

  const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs';
  const weight = size === 'sm' ? '' : 'font-black';

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {label && <span className="text-xs text-slate-400 font-bold">{label}</span>}
      <span
        data-testid="tracking-number"
        data-full-value={value}
        className={`font-mono ${textSize} ${weight} ${colorClass} select-all break-all`}
      >
        {value}
      </span>
      {copyable && (
        <button
          type="button"
          onClick={handleCopy}
          title="Copy full tracking number"
          className="p-0.5 rounded hover:bg-slate-100 transition-all"
        >
          <span className="material-symbols-outlined text-xs text-slate-400 hover:text-slate-600">
            {copied ? 'check' : 'content_copy'}
          </span>
        </button>
      )}
    </span>
  );
}

export default TrackingNumber;
