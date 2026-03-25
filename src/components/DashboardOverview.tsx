import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useAccess } from '../context/AccessContext';
import ApprovalQueue from './ApprovalQueue';

export default function DashboardOverview({ onNewRepair }: { onNewRepair: () => void }) {
  const { session } = useAccess();
  const navigate = useNavigate();
  const [showPrintLabelModal, setShowPrintLabelModal] = useState(false);
  const [showScanQRModal, setShowScanQRModal] = useState(false);
  const [printLabelText, setPrintLabelText] = useState('');
  const [printLabelQty, setPrintLabelQty] = useState(1);
  const [scanResult, setScanResult] = useState('');

  const handleQuickAction = (label: string) => {
    switch (label) {
      case 'New Sale':
        navigate('/sales');
        break;
      case 'Add Stock':
        navigate('/inventory');
        break;
      case 'New Customer':
        navigate('/customers');
        break;
      case 'Print Label':
        setShowPrintLabelModal(true);
        break;
      case 'Hold Sale':
        navigate('/sales');
        break;
      case 'Scan QR':
        setShowScanQRModal(true);
        break;
    }
  };

  return (
    <div className="space-y-8">
      {(session?.role === 'store_owner' || session?.role === 'system_owner' || session?.role === 'manager') && <ApprovalQueue />}
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Operational Overview</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Welcome back, Architect</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-500 bg-slate-100 px-4 py-2 rounded-xl ghost-border">
            <span className="material-symbols-outlined text-sm">calendar_today</span>
            <span className="text-sm font-semibold">Today, Oct 24</span>
          </div>
          <button 
            onClick={onNewRepair}
            className="bg-secondary text-white px-6 py-2 rounded-xl font-bold text-sm shadow-lg flex items-center gap-2 active:scale-95 transition-transform"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Quick Intake
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {[
          { label: 'New Sale', icon: 'shopping_cart', color: 'bg-primary' },
          { label: 'Add Stock', icon: 'inventory_2', color: 'bg-teal-800' },
          { label: 'New Customer', icon: 'person_add', color: 'bg-secondary' },
          { label: 'Print Label', icon: 'print', color: 'bg-slate-800' },
          { label: 'Hold Sale', icon: 'pause_circle', color: 'bg-slate-600' },
          { label: 'Scan QR', icon: 'qr_code_scanner', color: 'bg-lime-600' },
        ].map((action, i) => (
          <button key={i} onClick={() => handleQuickAction(action.label)} className="flex flex-col items-center justify-center p-4 bg-white rounded-2xl ghost-border shadow-sm hover:shadow-md transition-all group active:scale-95">
            <div className={`w-10 h-10 ${action.color} text-white rounded-xl flex items-center justify-center mb-2 group-hover:scale-110 transition-transform`}>
              <span className="material-symbols-outlined text-xl">{action.icon}</span>
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">{action.label}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="signature-gradient p-8 rounded-[2rem] shadow-xl text-white relative overflow-hidden flex flex-col justify-between h-52">
          <div className="z-10">
            <span className="text-teal-100/60 uppercase text-[10px] font-bold tracking-widest">Today's Revenue</span>
            <div className="text-5xl font-black mt-2 tracking-tighter">$4,285.50</div>
          </div>
          <div className="z-10 flex items-center gap-2">
            <span className="bg-lime-400 text-teal-950 px-2 py-0.5 rounded text-[10px] font-bold">+12.5%</span>
            <span className="text-teal-100/50 text-xs">vs yesterday</span>
          </div>
          <span className="material-symbols-outlined absolute -right-4 -bottom-4 text-9xl opacity-10">payments</span>
        </div>

        <div className="bg-white p-8 rounded-[2rem] shadow-sm border border-outline-variant/10 flex flex-col justify-between h-52">
          <div>
            <span className="text-slate-500 uppercase text-[10px] font-bold tracking-widest">Active Repairs</span>
            <div className="text-5xl font-black text-primary mt-2 tracking-tighter">18</div>
          </div>
          <div className="flex -space-x-2">
            {[1,2,3].map(i => (
              <div key={i} className="w-10 h-10 rounded-full border-4 border-white bg-slate-200 overflow-hidden">
                <img src={`https://i.pravatar.cc/100?img=${i+10}`} alt="avatar" />
              </div>
            ))}
            <div className="w-10 h-10 rounded-full border-4 border-white bg-primary text-[10px] flex items-center justify-center text-white font-bold">+15</div>
          </div>
        </div>

        <div className="bg-red-50 p-8 rounded-[2rem] border border-red-100 flex flex-col justify-between h-52">
          <div>
            <span className="text-red-800 uppercase text-[10px] font-bold tracking-widest">Critical Stock</span>
            <div className="text-5xl font-black text-red-700 mt-2 tracking-tighter">04</div>
          </div>
          <div className="flex items-center gap-2 text-red-700">
            <span className="material-symbols-outlined text-sm">warning</span>
            <span className="text-xs font-bold uppercase tracking-wider">Immediate reorder required</span>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showPrintLabelModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              onClick={() => setShowPrintLabelModal(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Print Label</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Generate barcode / price labels</p>
                </div>
                <button onClick={() => setShowPrintLabelModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Label Text / SKU</label>
                  <input
                    value={printLabelText}
                    onChange={(e) => setPrintLabelText(e.target.value)}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    placeholder="Enter SKU or product name..."
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Quantity</label>
                  <input
                    type="number"
                    min={1}
                    value={printLabelQty}
                    onChange={(e) => setPrintLabelQty(Number(e.target.value))}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                  />
                </div>
                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 flex items-center justify-center">
                  <div className="text-center">
                    <span className="material-symbols-outlined text-5xl text-slate-300 mb-2">qr_code_2</span>
                    <p className="text-xs font-bold text-slate-400">Label preview will appear here</p>
                  </div>
                </div>
                <button
                  onClick={() => { setShowPrintLabelModal(false); setPrintLabelText(''); setPrintLabelQty(1); }}
                  disabled={!printLabelText.trim()}
                  className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-sm">print</span>
                  Print {printLabelQty} Label{printLabelQty > 1 ? 's' : ''}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showScanQRModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
              onClick={() => setShowScanQRModal(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Scan QR / Barcode</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Look up products or tickets</p>
                </div>
                <button onClick={() => { setShowScanQRModal(false); setScanResult(''); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              <div className="p-8 space-y-6">
                <div className="bg-slate-900 rounded-2xl p-12 flex flex-col items-center justify-center">
                  <span className="material-symbols-outlined text-6xl text-teal-400 mb-4">qr_code_scanner</span>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Camera scanner ready</p>
                  <p className="text-[10px] text-slate-500 mt-1">Point camera at barcode or QR code</p>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Or enter code manually</label>
                  <div className="flex gap-3">
                    <input
                      value={scanResult}
                      onChange={(e) => setScanResult(e.target.value)}
                      className="flex-1 px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                      placeholder="Enter barcode or QR value..."
                    />
                    <button
                      onClick={() => { if (scanResult.trim()) { setShowScanQRModal(false); navigate('/sales'); setScanResult(''); } }}
                      disabled={!scanResult.trim()}
                      className="px-6 py-4 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Look Up
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
