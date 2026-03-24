import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Invoice } from '../types';

const MOCK_INVOICES: Invoice[] = [
  {
    id: '1',
    invoiceNumber: 'INV-2024-001',
    customerId: 'c1',
    customerName: 'John Doe',
    customerEmail: 'john@example.com',
    customerPhone: '555-0101',
    items: [
      { id: 'p1', name: 'iPhone 13 Screen Repair', quantity: 1, price: 129.99, type: 'repair' },
      { id: 'p2', name: 'Tempered Glass', quantity: 1, price: 15.00, type: 'product' }
    ],
    subtotal: 144.99,
    tax: 11.60,
    total: 156.59,
    amountPaid: 156.59,
    balance: 0,
    status: 'Paid',
    createdAt: '2024-03-15',
    dueDate: '2024-03-15',
    paymentHistory: [
      { id: 'pay1', amount: 156.59, method: 'Credit Card', timestamp: '2024-03-15 14:30' }
    ],
    remindersSent: 0
  },
  {
    id: '2',
    invoiceNumber: 'INV-2024-002',
    customerId: 'c2',
    customerName: 'Jane Smith',
    customerEmail: 'jane@example.com',
    items: [
      { id: 'p3', name: 'MacBook Battery Replacement', quantity: 1, price: 199.99, type: 'repair' }
    ],
    subtotal: 199.99,
    tax: 16.00,
    total: 215.99,
    amountPaid: 100.00,
    balance: 115.99,
    status: 'Partially Paid',
    createdAt: '2024-03-18',
    dueDate: '2024-03-25',
    paymentHistory: [
      { id: 'pay2', amount: 100.00, method: 'Cash', timestamp: '2024-03-18 10:15' }
    ],
    remindersSent: 1
  },
  {
    id: '3',
    invoiceNumber: 'INV-2024-003',
    customerId: 'c3',
    customerName: 'Robert Brown',
    items: [
      { id: 'p4', name: 'Monthly Maintenance Plan', quantity: 1, price: 49.99, type: 'service' }
    ],
    subtotal: 49.99,
    tax: 4.00,
    total: 53.99,
    amountPaid: 0,
    balance: 53.99,
    status: 'Unpaid',
    createdAt: '2024-03-20',
    dueDate: '2024-03-27',
    isRecurring: true,
    recurringInterval: 'monthly',
    paymentHistory: [],
    remindersSent: 0
  }
];

export default function Invoices() {
  const [invoices, setInvoices] = useState<Invoice[]>(MOCK_INVOICES);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [pin, setPin] = useState('');
  const [pendingAction, setPendingAction] = useState<'create' | 'payment' | null>(null);

  const handleActionWithPin = (action: 'create' | 'payment', invoice?: Invoice) => {
    setPendingAction(action);
    if (invoice) setSelectedInvoice(invoice);
    setShowPinModal(true);
  };

  const verifyPin = () => {
    if (pin === '1234') {
      setShowPinModal(false);
      setPin('');
      if (pendingAction === 'create') setShowAddModal(true);
      if (pendingAction === 'payment') setShowPaymentModal(true);
    } else {
      alert('Invalid PIN');
      setPin('');
    }
  };

  const filteredInvoices = invoices.filter(inv => 
    inv.invoiceNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
    inv.customerName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Paid': return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';
      case 'Partially Paid': return 'bg-amber-500/10 text-amber-600 border-amber-500/20';
      case 'Unpaid': return 'bg-slate-500/10 text-slate-600 border-slate-500/20';
      case 'Overdue': return 'bg-rose-500/10 text-rose-600 border-rose-500/20';
      default: return 'bg-slate-500/10 text-slate-600 border-slate-500/20';
    }
  };

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Billing & Sales</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Manage Invoices</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
            <input 
              type="text" 
              placeholder="Search invoices..."
              className="pl-11 pr-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-900 w-64 shadow-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <button 
            onClick={() => handleActionWithPin('create')}
            className="bg-primary text-white px-6 py-3 rounded-2xl font-black text-xs shadow-lg shadow-primary/20 flex items-center gap-2 uppercase tracking-widest hover:bg-primary/90 transition-all"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Create Invoice
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[
          { label: 'Total Outstanding', value: '$1,240.50', color: 'text-rose-500', icon: 'account_balance_wallet' },
          { label: 'Paid Today', value: '$450.00', color: 'text-emerald-500', icon: 'payments' },
          { label: 'Overdue Invoices', value: '5', color: 'text-amber-500', icon: 'event_busy' },
          { label: 'Recurring Revenue', value: '$2,400/mo', color: 'text-primary', icon: 'sync' }
        ].map((stat, i) => (
          <div key={i} className="bg-white/80 backdrop-blur-xl p-6 rounded-[2.5rem] border border-slate-200 shadow-sm flex items-center gap-4">
            <div className={`w-12 h-12 rounded-2xl bg-slate-50 flex items-center justify-center ${stat.color}`}>
              <span className="material-symbols-outlined">{stat.icon}</span>
            </div>
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{stat.label}</p>
              <p className={`text-2xl font-black ${stat.color}`}>{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Invoice #</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Customer</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Total</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Balance</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredInvoices.map((inv) => (
              <tr key={inv.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0 group">
                <td className="px-8 py-6">
                  <span className="font-black text-primary text-xs">{inv.invoiceNumber}</span>
                  {inv.isRecurring && (
                    <span className="ml-2 px-2 py-0.5 bg-primary/10 text-primary text-[8px] font-black uppercase rounded-full">Recurring</span>
                  )}
                </td>
                <td className="px-8 py-6">
                  <p className="text-sm font-bold text-slate-900">{inv.customerName}</p>
                  <p className="text-[10px] text-slate-400 font-medium">{inv.customerEmail}</p>
                </td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{inv.createdAt}</td>
                <td className="px-8 py-6 text-sm font-black text-slate-900">${inv.total.toFixed(2)}</td>
                <td className="px-8 py-6 text-sm font-black text-rose-500">${inv.balance.toFixed(2)}</td>
                <td className="px-8 py-6">
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${getStatusColor(inv.status)}`}>
                    {inv.status}
                  </span>
                </td>
                <td className="px-8 py-6 text-right">
                  <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={() => handleActionWithPin('payment', inv)}
                      className="p-2 hover:bg-emerald-50 text-emerald-600 rounded-xl transition-colors"
                      title="Add Payment"
                    >
                      <span className="material-symbols-outlined text-sm">payments</span>
                    </button>
                    <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Print">
                      <span className="material-symbols-outlined text-sm">print</span>
                    </button>
                    <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Download PDF">
                      <span className="material-symbols-outlined text-sm">picture_as_pdf</span>
                    </button>
                    <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Send SMS">
                      <span className="material-symbols-outlined text-sm">sms</span>
                    </button>
                    <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Send Email">
                      <span className="material-symbols-outlined text-sm">mail</span>
                    </button>
                    <button className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors" title="Duplicate">
                      <span className="material-symbols-outlined text-sm">content_copy</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* PIN Modal */}
      <AnimatePresence>
        {showPinModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowPinModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="relative w-full max-w-xs bg-white rounded-[2rem] shadow-2xl border border-slate-200 overflow-hidden p-8"
            >
              <div className="text-center space-y-4">
                <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto">
                  <span className="material-symbols-outlined text-primary text-3xl">lock</span>
                </div>
                <div>
                  <h3 className="text-xl font-black text-primary">Enter PIN</h3>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Security access required</p>
                </div>
                <input 
                  type="password" 
                  maxLength={4}
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && verifyPin()}
                  autoFocus
                  className="w-full text-center text-3xl font-black tracking-[0.5em] py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
                <button 
                  onClick={verifyPin}
                  className="w-full py-4 bg-primary text-white font-black text-xs rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all"
                >
                  Verify Access
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Payment Modal */}
      <AnimatePresence>
        {showPaymentModal && selectedInvoice && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowPaymentModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Add Payment</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Invoice: {selectedInvoice.invoiceNumber}</p>
                </div>
                <button onClick={() => setShowPaymentModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              
              <div className="p-8 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Amount</p>
                    <p className="text-xl font-black text-slate-900">${selectedInvoice.total.toFixed(2)}</p>
                  </div>
                  <div className="p-4 bg-rose-50 rounded-2xl border border-rose-100">
                    <p className="text-[10px] font-black text-rose-400 uppercase tracking-widest">Remaining Balance</p>
                    <p className="text-xl font-black text-rose-600">${selectedInvoice.balance.toFixed(2)}</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Payment Amount</label>
                    <div className="relative">
                      <span className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 font-bold">$</span>
                      <input 
                        type="number" 
                        defaultValue={selectedInvoice.balance}
                        className="w-full pl-10 pr-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-black text-primary"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Payment Method</label>
                    <select className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 appearance-none">
                      <option>Cash</option>
                      <option>Credit Card</option>
                      <option>Debit Card</option>
                      <option>Bank Transfer</option>
                      <option>Check</option>
                    </select>
                  </div>
                </div>

                <div className="pt-4">
                  <button className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all">
                    Apply Payment
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Add Invoice Modal Placeholder */}
      <AnimatePresence>
        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAddModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-4xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Create New Invoice</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Fill in the details below</p>
                </div>
                <button onClick={() => setShowAddModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              
              <div className="p-8 grid grid-cols-2 gap-8">
                <div className="space-y-6">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Customer</label>
                    <select className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                      <option>Select Customer...</option>
                      <option>John Doe</option>
                      <option>Jane Smith</option>
                      <option>+ Add New Customer</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Invoice Date</label>
                      <input type="date" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" />
                    </div>
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Due Date</label>
                      <input type="date" className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" />
                    </div>
                  </div>
                  <div className="flex items-center gap-4 p-4 bg-primary/5 rounded-2xl border border-primary/10">
                    <input type="checkbox" className="w-5 h-5 rounded border-primary text-primary focus:ring-primary" />
                    <div>
                      <p className="text-xs font-black text-primary uppercase tracking-widest">Recurring Invoice</p>
                      <p className="text-[10px] text-primary/60 font-bold">Automatically generate this invoice every month</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-6">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Items & Services</label>
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
                      <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100">
                        <span className="text-xs font-bold text-slate-700">iPhone 13 Screen Repair</span>
                        <span className="text-xs font-black text-primary">$129.99</span>
                      </div>
                      <button className="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 text-[10px] font-black uppercase tracking-widest hover:border-primary/40 hover:text-primary transition-all">
                        + Add Item or Service
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4 mb-2 block">Terms & Conditions</label>
                    <textarea 
                      placeholder="Enter terms and conditions..."
                      className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-medium text-sm h-24 resize-none"
                    />
                  </div>
                </div>
              </div>

              <div className="p-8 bg-slate-50/50 border-t border-slate-100 flex justify-between items-center">
                <div className="flex gap-4">
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Subtotal</p>
                    <p className="text-lg font-black text-slate-900">$0.00</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Tax (8%)</p>
                    <p className="text-lg font-black text-slate-900">$0.00</p>
                  </div>
                  <div className="text-right px-6 border-l border-slate-200">
                    <p className="text-[10px] font-black text-primary uppercase tracking-widest">Total</p>
                    <p className="text-2xl font-black text-primary">$0.00</p>
                  </div>
                </div>
                <button className="px-12 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all">
                  Generate Invoice
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
