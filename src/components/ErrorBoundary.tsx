import React from 'react';
import { useRouteError, isRouteErrorResponse } from 'react-router-dom';

export default function ErrorBoundary() {
  const error = useRouteError();
  console.error('Route error:', error);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-8">
      <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm max-w-md w-full text-center">
        <h1 className="text-2xl font-black text-primary tracking-tight mb-2">Something went wrong</h1>
        <p className="text-slate-500 font-medium mb-6">
          {isRouteErrorResponse(error) 
            ? `${error.status} ${error.statusText}` 
            : 'An unexpected error occurred. Please try again later.'}
        </p>
        <button 
          onClick={() => window.location.href = '/'}
          className="px-6 py-3 bg-primary text-white font-black text-[10px] rounded-xl hover:bg-primary/90 transition-all uppercase tracking-widest"
        >
          Return Home
        </button>
      </div>
    </div>
  );
}
