import React from 'react';

export default function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-slate-400">
      <div className="p-4 bg-slate-100 rounded-full mb-4 text-slate-300">
        <span className="material-symbols-outlined text-5xl">construction</span>
      </div>
      <h2 className="text-xl font-bold text-slate-600">{title} Page</h2>
      <p className="text-sm">This page is under construction.</p>
    </div>
  );
}
