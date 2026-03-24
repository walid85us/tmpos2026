import React from 'react';
import { auditLogs } from './mockData';

const AuditSecurityPage: React.FC = () => {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-black text-primary tracking-tight">Audit & Security</h2>
        <p className="text-slate-500 font-medium">Monitor platform activity and security events.</p>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Actor</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Target</th>
              <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Severity</th>
            </tr>
          </thead>
          <tbody>
            {auditLogs.map((log) => (
              <tr key={log.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                <td className="px-8 py-4 text-sm font-bold text-slate-600">{log.date}</td>
                <td className="px-8 py-4 font-bold text-slate-900">{log.actor}</td>
                <td className="px-8 py-4 text-sm text-slate-600">{log.action}</td>
                <td className="px-8 py-4 font-bold text-slate-900">{log.target}</td>
                <td className="px-8 py-4">
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${
                    log.severity === 'info' ? 'bg-blue-400/10 text-blue-700 border-blue-400/20' : 'bg-orange-400/10 text-orange-700 border-orange-400/20'
                  }`}>
                    {log.severity}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AuditSecurityPage;
