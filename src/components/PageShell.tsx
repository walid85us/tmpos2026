import React from 'react';

interface PageShellProps {
  title: string;
  primaryAction?: { label: string; onClick: () => void; icon?: string };
  children: React.ReactNode;
  searchPlaceholder?: string;
  onSearch?: (query: string) => void;
}

export default function PageShell({ title, primaryAction, children, searchPlaceholder, onSearch }: PageShellProps) {
  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-2xl font-extrabold text-primary tracking-tight font-headline">{title}</h2>
        {primaryAction && (
          <button 
            onClick={primaryAction.onClick}
            className="bg-secondary text-white px-6 py-2 rounded-xl font-bold text-sm shadow-lg flex items-center gap-2 active:scale-95 transition-transform"
          >
            {primaryAction.icon && <span className="material-symbols-outlined text-sm">{primaryAction.icon}</span>}
            {primaryAction.label}
          </button>
        )}
      </header>

      {(searchPlaceholder || onSearch) && (
        <div className="relative w-full max-w-md focus-within:ring-2 focus-within:ring-lime-500 rounded-lg transition-all">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
          <input 
            className="w-full bg-slate-100 border-none rounded-lg py-2 pl-10 text-sm focus:ring-0" 
            placeholder={searchPlaceholder || "Search..."} 
            type="text"
            onChange={(e) => onSearch?.(e.target.value)}
          />
        </div>
      )}

      <div className="bg-white rounded-2xl ghost-border shadow-sm p-6">
        {children}
      </div>
    </div>
  );
}
