import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RepairTicket, TicketComment, TicketAttachment, TicketHistory } from '../types';
import ContextualHelp from './ContextualHelp';

const MOCK_TICKETS: RepairTicket[] = [
  {
    id: '1',
    ticketNumber: 'T-1001',
    customerId: 'c1',
    customerName: 'Alexander Wright',
    device: 'iPhone 14 Pro',
    issue: 'Screen Replacement',
    status: 'In Progress',
    priority: 'High',
    createdAt: '2026-03-15T10:00:00Z',
    updatedAt: '2026-03-15T10:00:00Z',
    estimatedCost: 249,
    technicianName: 'John D.',
    location: 'Shelf A-1',
    diagnosticNotes: 'Screen is cracked, digitizer unresponsive. FaceID seems intact.',
    preRepairCondition: ['Cracked Screen', 'Scratched Frame', 'Power On'],
    imei: '351234567890123',
    network: 'Verizon',
    history: [
      { id: 'h1', action: 'Ticket Created', performedBy: 'System', timestamp: '2026-03-15T10:00:00Z' },
      { id: 'h2', action: 'Assigned to John D.', performedBy: 'Admin', timestamp: '2026-03-15T10:05:00Z' }
    ],
    comments: [
      { id: 'com1', authorId: 'tech1', authorName: 'John D.', text: 'Part ordered from primary supplier.', createdAt: '2026-03-15T11:00:00Z', isInternal: true }
    ]
  },
  {
    id: '2',
    ticketNumber: 'T-1002',
    customerId: 'c2',
    customerName: 'Sarah Jenkins',
    device: 'MacBook Air M2',
    issue: 'Liquid Damage',
    status: 'Pending',
    priority: 'Medium',
    createdAt: '2026-03-16T14:30:00Z',
    updatedAt: '2026-03-16T14:30:00Z',
    estimatedCost: 450,
    technicianName: 'Sarah L.',
    location: 'Shelf B-2',
    imei: 'SN-M2-987654',
    network: 'N/A'
  },
  {
    id: '3',
    ticketNumber: 'T-1003',
    customerId: 'c3',
    customerName: 'Michael Chen',
    device: 'iPad Pro 12.9',
    issue: 'Battery Service',
    status: 'Awaiting Parts',
    priority: 'Rush',
    createdAt: '2026-03-18T09:15:00Z',
    updatedAt: '2026-03-18T09:15:00Z',
    estimatedCost: 129,
    isRushJob: true,
    technicianName: 'Mike R.',
    location: 'Repair Bench 3'
  },
  {
    id: '4',
    ticketNumber: 'T-1004',
    customerId: 'c4',
    customerName: 'Emma Watson',
    device: 'Samsung S23 Ultra',
    issue: 'Back Glass',
    status: 'Completed',
    priority: 'Low',
    createdAt: '2026-03-19T11:20:00Z',
    updatedAt: '2026-03-19T16:45:00Z',
    estimatedCost: 89,
    technicianName: 'John D.',
    location: 'Ready Bin 4'
  }
];

export default function RepairTickets() {
  const [tickets, setTickets] = useState<RepairTicket[]>(MOCK_TICKETS);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [selectedTicket, setSelectedTicket] = useState<RepairTicket | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isNewTicketModalOpen, setIsNewTicketModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'history' | 'comments' | 'attachments'>('details');

  // Stats
  const stats = useMemo(() => ({
    pending: tickets.filter(t => t.status === 'Pending').length,
    inProgress: tickets.filter(t => t.status === 'In Progress').length,
    awaitingParts: tickets.filter(t => t.status === 'Awaiting Parts').length,
    ready: tickets.filter(t => t.status === 'Completed').length,
  }), [tickets]);

  // Filtered tickets
  const filteredTickets = useMemo(() => {
    return tickets.filter(ticket => {
      const matchesSearch = 
        ticket.ticketNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        ticket.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        ticket.device.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (ticket.imei && ticket.imei.toLowerCase().includes(searchQuery.toLowerCase()));
      
      const matchesStatus = statusFilter === 'All' || ticket.status === statusFilter;
      
      return matchesSearch && matchesStatus;
    });
  }, [tickets, searchQuery, statusFilter]);

  const handleViewDetails = (ticket: RepairTicket) => {
    setSelectedTicket(ticket);
    setIsDetailModalOpen(true);
    setActiveTab('details');
  };

  const handleStatusChange = (id: string, newStatus: RepairTicket['status']) => {
    const timestamp = new Date().toISOString();
    setTickets(tickets.map(t => t.id === id ? { 
      ...t, 
      status: newStatus, 
      updatedAt: timestamp,
      history: [...(t.history || []), {
        id: `h-${Date.now()}`,
        action: `Status changed to ${newStatus}`,
        performedBy: 'Current User',
        timestamp
      }]
    } : t));
    
    if (selectedTicket?.id === id) {
      setSelectedTicket(prev => prev ? { 
        ...prev, 
        status: newStatus, 
        updatedAt: timestamp,
        history: [...(prev.history || []), {
          id: `h-${Date.now()}`,
          action: `Status changed to ${newStatus}`,
          performedBy: 'Current User',
          timestamp
        }]
      } : null);
    }
  };

  const exportToExcel = () => {
    alert('Exporting tickets to Excel format (CSV simulation)...');
    console.log('Exporting data:', tickets);
  };

  const handleAddComment = (text: string) => {
    if (!selectedTicket || !text.trim()) return;
    const newComment: TicketComment = {
      id: `c-${Date.now()}`,
      authorId: 'u1',
      authorName: 'Current User',
      text,
      createdAt: new Date().toISOString(),
      isInternal: true
    };
    
    setTickets(tickets.map(t => t.id === selectedTicket.id ? {
      ...t,
      comments: [...(t.comments || []), newComment]
    } : t));
    
    setSelectedTicket(prev => prev ? {
      ...prev,
      comments: [...(prev.comments || []), newComment]
    } : null);
  };

  return (
    <div className="space-y-8 font-sans antialiased">
      {/* Header */}
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Operational Ledger</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Manage Tickets</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative w-64">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
            <input
              type="text"
              placeholder="Search tickets..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-100 border-none rounded-xl pl-10 pr-4 py-2 text-sm focus:ring-secondary"
            />
          </div>
          <button 
            onClick={exportToExcel}
            className="p-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl transition-all"
            title="Export to Excel"
          >
            <span className="material-symbols-outlined">download</span>
          </button>
          <button 
            onClick={() => setIsNewTicketModalOpen(true)}
            className="bg-lime-400 text-teal-950 px-6 py-2 rounded-xl font-bold text-sm shadow-lg active:scale-95 transition-transform flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            New Ticket
          </button>
        </div>
      </header>

      {/* Stats Bento */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[
          { label: 'Pending', count: stats.pending, color: 'bg-amber-500', icon: 'pending' },
          { label: 'Awaiting Parts', count: stats.awaitingParts, color: 'bg-blue-500', icon: 'inventory' },
          { label: 'In Progress', count: stats.inProgress, color: 'bg-primary', icon: 'build' },
          { label: 'Ready', count: stats.ready, color: 'bg-lime-500', icon: 'check_circle' },
        ].map((stat, i) => (
          <div key={i} className="bg-white p-6 rounded-3xl ghost-border shadow-sm flex items-center justify-between group hover:shadow-md transition-all">
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{stat.label}</p>
              <p className="text-3xl font-black text-primary mt-1">{stat.count}</p>
            </div>
            <div className={`w-12 h-12 rounded-2xl ${stat.color}/10 flex items-center justify-center text-${stat.color.split('-')[1]}-600`}>
              <span className="material-symbols-outlined">{stat.icon}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="flex gap-2 overflow-x-auto pb-2 custom-scrollbar">
        {['All', 'Pending', 'In Progress', 'Awaiting Parts', 'Completed', 'Delivered', 'Cancelled'].map(status => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
              statusFilter === status 
                ? 'bg-primary text-white shadow-md' 
                : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-100'
            }`}
          >
            {status}
          </button>
        ))}
      </div>

      {/* Tickets Table */}
      <div className="bg-white rounded-[2rem] ghost-border shadow-sm overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Ticket #</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Device / Issue</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Customer</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Technician</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Priority</th>
              <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Quote</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filteredTickets.map((ticket, i) => (
              <tr 
                key={ticket.id} 
                className="hover:bg-slate-50 transition-colors group cursor-pointer"
                onClick={() => handleViewDetails(ticket)}
              >
                <td className="p-6">
                  <span className="font-black text-primary">{ticket.ticketNumber}</span>
                </td>
                <td className="p-6">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-primary">
                      <span className="material-symbols-outlined text-xl">
                        {ticket.device.toLowerCase().includes('macbook') ? 'laptop_mac' : 'smartphone'}
                      </span>
                    </div>
                    <div>
                      <p className="font-bold text-slate-900">{ticket.device}</p>
                      <p className="text-[10px] font-medium text-slate-400 uppercase truncate max-w-[150px]">{ticket.issue}</p>
                    </div>
                  </div>
                </td>
                <td className="p-6">
                  <p className="font-bold text-slate-900">{ticket.customerName}</p>
                </td>
                <td className="p-6">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-slate-200 overflow-hidden">
                      <img src={`https://i.pravatar.cc/100?img=${i+20}`} alt="tech" referrerPolicy="no-referrer" />
                    </div>
                    <span className="text-sm font-medium text-slate-600">{ticket.technicianName || 'Unassigned'}</span>
                  </div>
                </td>
                <td className="p-6">
                  <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter ${
                    ticket.status === 'Completed' ? 'bg-lime-100 text-lime-800' :
                    ticket.status === 'In Progress' ? 'bg-primary text-white' :
                    ticket.status === 'Pending' ? 'bg-amber-100 text-amber-800' :
                    ticket.status === 'Awaiting Parts' ? 'bg-blue-100 text-blue-800' :
                    'bg-slate-100 text-slate-800'
                  }`}>
                    {ticket.status}
                  </span>
                </td>
                <td className="p-6">
                  <span className={`text-[10px] font-black uppercase tracking-widest ${
                    ticket.priority === 'Rush' ? 'text-red-600 animate-pulse' :
                    ticket.priority === 'High' ? 'text-orange-600' :
                    'text-slate-400'
                  }`}>
                    {ticket.priority}
                  </span>
                </td>
                <td className="p-6">
                  <span className="font-black text-primary">${ticket.estimatedCost.toFixed(2)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredTickets.length === 0 && (
          <div className="p-20 text-center text-slate-400">
            <span className="material-symbols-outlined text-5xl mb-4">search_off</span>
            <p className="font-bold">No tickets found matching your criteria</p>
          </div>
        )}
      </div>

      {/* Ticket Detail Modal */}
      <AnimatePresence>
        {isDetailModalOpen && selectedTicket && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsDetailModalOpen(false)}
              className="absolute inset-0 bg-teal-950/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative w-full max-w-6xl bg-white rounded-[3rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              {/* Modal Header */}
              <div className="signature-gradient p-8 text-white flex justify-between items-center">
                <div className="flex items-center gap-6">
                  <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center backdrop-blur-md">
                    <span className="material-symbols-outlined text-3xl">confirmation_number</span>
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-3xl font-black tracking-tight">{selectedTicket.ticketNumber}</h2>
                      {selectedTicket.isRushJob && (
                        <span className="bg-red-500 text-white text-[10px] font-black px-2 py-0.5 rounded uppercase animate-pulse">Rush Job</span>
                      )}
                    </div>
                    <p className="text-teal-100/70 font-bold uppercase tracking-widest text-xs">
                      {selectedTicket.device} • {selectedTicket.customerName}
                    </p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button className="w-12 h-12 bg-white/10 hover:bg-white/20 rounded-2xl flex items-center justify-center transition-all">
                    <span className="material-symbols-outlined">print</span>
                  </button>
                  <button className="w-12 h-12 bg-white/10 hover:bg-white/20 rounded-2xl flex items-center justify-center transition-all">
                    <span className="material-symbols-outlined">share</span>
                  </button>
                  <button 
                    onClick={() => setIsDetailModalOpen(false)}
                    className="w-12 h-12 bg-white/10 hover:bg-white/20 rounded-2xl flex items-center justify-center transition-all"
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              </div>

              {/* Modal Tabs */}
              <div className="flex border-b border-slate-100 px-8 bg-slate-50/50">
                {[
                  { id: 'details', label: 'Ticket Details', icon: 'info' },
                  { id: 'history', label: 'History Log', icon: 'history' },
                  { id: 'comments', label: 'Staff Comments', icon: 'forum' },
                  { id: 'attachments', label: 'Attachments', icon: 'attachment' },
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`flex items-center gap-2 px-6 py-4 text-xs font-black uppercase tracking-widest transition-all border-b-4 ${
                      activeTab === tab.id 
                        ? 'border-primary text-primary' 
                        : 'border-transparent text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    <span className="material-symbols-outlined text-sm">{tab.icon}</span>
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto p-10 custom-scrollbar bg-white">
                {activeTab === 'details' && (
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
                    {/* Main Info */}
                    <div className="lg:col-span-8 space-y-10">
                      {/* Status & Assignment */}
                      <div className="grid grid-cols-2 gap-6">
                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Workflow Status</label>
                          <select 
                            value={selectedTicket.status}
                            onChange={(e) => handleStatusChange(selectedTicket.id, e.target.value as any)}
                            className="w-full bg-slate-50 border-none rounded-2xl px-5 py-4 text-sm font-bold focus:ring-secondary shadow-inner"
                          >
                            <option value="Pending">Pending</option>
                            <option value="In Progress">In Progress</option>
                            <option value="Awaiting Parts">Awaiting Parts</option>
                            <option value="Completed">Completed</option>
                            <option value="Delivered">Delivered</option>
                            <option value="Cancelled">Cancelled</option>
                          </select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Assigned Technician</label>
                          <div className="flex items-center gap-4 bg-slate-50 border-none rounded-2xl px-5 py-3 shadow-inner">
                            <div className="w-10 h-10 rounded-full bg-slate-200 overflow-hidden">
                              <img src="https://i.pravatar.cc/100?img=25" alt="tech" />
                            </div>
                            <div>
                              <p className="text-sm font-bold text-primary">{selectedTicket.technicianName || 'Unassigned'}</p>
                              <p className="text-[10px] font-bold text-slate-400 uppercase">Primary Tech</p>
                            </div>
                            <button className="ml-auto text-primary hover:underline text-[10px] font-black uppercase">Change</button>
                          </div>
                        </div>
                      </div>

                      {/* Device & Issue */}
                      <div className="bg-slate-50 rounded-[2.5rem] p-8 space-y-6 shadow-inner">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-primary">devices</span>
                            <h3 className="text-lg font-black text-primary tracking-tight">Device Specifications</h3>
                          </div>
                          <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-xl border border-slate-100 shadow-sm">
                            <span className="material-symbols-outlined text-xs text-slate-400">location_on</span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-primary">{selectedTicket.location || 'Not Set'}</span>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-8">
                          <div>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Model Name</p>
                            <p className="font-bold text-slate-900">{selectedTicket.device}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Reported Issue</p>
                            <p className="font-bold text-slate-900">{selectedTicket.issue}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">IMEI / Serial Number</p>
                            <p className="font-mono text-sm font-bold text-primary">{selectedTicket.imei || 'N/A'}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Network / Carrier</p>
                            <p className="font-bold text-slate-900">{selectedTicket.network || 'N/A'}</p>
                          </div>
                        </div>
                      </div>

                      {/* Parts Used Section */}
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-primary">inventory_2</span>
                            <h3 className="text-lg font-black text-primary tracking-tight">Inventory Parts Used</h3>
                          </div>
                          <button className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1 hover:underline">
                            <span className="material-symbols-outlined text-sm">add</span>
                            Add Part
                          </button>
                        </div>
                        <div className="bg-slate-50 rounded-[2rem] p-6 shadow-inner">
                          {selectedTicket.partsUsed && selectedTicket.partsUsed.length > 0 ? (
                            <div className="space-y-3">
                              {selectedTicket.partsUsed.map((part, i) => (
                                <div key={i} className="flex justify-between items-center bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
                                  <div>
                                    <p className="text-sm font-bold text-primary">{part.name}</p>
                                    <p className="text-[10px] text-slate-400 uppercase font-bold">Qty: {part.quantity}</p>
                                  </div>
                                  <span className="font-black text-primary">${part.price.toFixed(2)}</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-center py-6 text-slate-400">
                              <p className="text-xs italic">No parts linked to this repair yet.</p>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Diagnostic Notes */}
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-primary">description</span>
                            <h3 className="text-lg font-black text-primary tracking-tight">Diagnostic & Repair Notes</h3>
                          </div>
                          <button className="text-[10px] font-black text-secondary uppercase tracking-widest flex items-center gap-1 hover:underline">
                            <span className="material-symbols-outlined text-sm">auto_awesome</span>
                            Polish with AI
                          </button>
                        </div>
                        <textarea 
                          className="w-full bg-slate-50 border-none rounded-[2rem] p-6 text-sm font-medium focus:ring-secondary shadow-inner min-h-[150px]"
                          placeholder="Enter detailed diagnostic findings and repair steps taken..."
                          defaultValue={selectedTicket.diagnosticNotes}
                        />
                      </div>

                      {/* Pre/Post Conditions */}
                      <div className="grid grid-cols-2 gap-8">
                        <div className="space-y-4">
                          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Pre-Repair Conditions</h4>
                          <div className="flex flex-wrap gap-2">
                            {selectedTicket.preRepairCondition?.map((cond, i) => (
                              <span key={i} className="px-4 py-2 bg-amber-50 text-amber-800 rounded-xl text-[10px] font-black uppercase border border-amber-100">{cond}</span>
                            )) || <p className="text-xs text-slate-400 italic">No conditions recorded</p>}
                            <button className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-400 hover:bg-slate-200 transition-all">
                              <span className="material-symbols-outlined text-sm">add</span>
                            </button>
                          </div>
                        </div>
                        <div className="space-y-4">
                          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Post-Repair Conditions</h4>
                          <div className="flex flex-wrap gap-2">
                            {selectedTicket.postRepairCondition?.map((cond, i) => (
                              <span key={i} className="px-4 py-2 bg-lime-50 text-lime-800 rounded-xl text-[10px] font-black uppercase border border-lime-100">{cond}</span>
                            )) || <p className="text-xs text-slate-400 italic">Awaiting completion</p>}
                            <button className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-400 hover:bg-slate-200 transition-all">
                              <span className="material-symbols-outlined text-sm">add</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Sidebar Info */}
                    <div className="lg:col-span-4 space-y-8">
                      {/* Customer Card */}
                      <div className="bg-primary text-white p-8 rounded-[2.5rem] shadow-xl relative overflow-hidden">
                        <div className="relative z-10">
                          <span className="text-teal-100/50 uppercase text-[10px] font-black tracking-widest">Customer Profile</span>
                          <h4 className="text-xl font-black mt-2">{selectedTicket.customerName}</h4>
                          <div className="mt-6 space-y-3">
                            <div className="flex items-center gap-3 text-sm font-medium text-teal-100">
                              <span className="material-symbols-outlined text-sm">phone</span>
                              (555) 012-3456
                            </div>
                            <div className="flex items-center gap-3 text-sm font-medium text-teal-100">
                              <span className="material-symbols-outlined text-sm">mail</span>
                              {selectedTicket.customerName.toLowerCase().replace(' ', '.')}@example.com
                            </div>
                          </div>
                          <button className="mt-8 w-full py-3 bg-white/10 hover:bg-white/20 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all">
                            View Customer History
                          </button>
                        </div>
                        <span className="material-symbols-outlined absolute -right-6 -bottom-6 text-9xl opacity-10">group</span>
                      </div>

                      {/* Financials */}
                      <div className="bg-slate-50 rounded-[2.5rem] p-8 space-y-6 shadow-inner">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Financial Summary</h3>
                        <div className="space-y-4">
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-bold text-slate-500">Service Quote</span>
                            <span className="text-sm font-black text-primary">${selectedTicket.estimatedCost.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-bold text-slate-500">Parts Cost</span>
                            <span className="text-sm font-black text-primary">$0.00</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-bold text-slate-500">Billable Hours</span>
                            <span className="text-sm font-black text-primary">0.0</span>
                          </div>
                          <div className="pt-4 border-t border-slate-200 flex justify-between items-center">
                            <span className="text-lg font-black text-primary">Total Due</span>
                            <span className="text-2xl font-black text-primary">${selectedTicket.estimatedCost.toFixed(2)}</span>
                          </div>
                          <div className="p-4 bg-lime-400/10 rounded-2xl flex justify-between items-center border border-lime-400/20">
                            <span className="text-[10px] font-black text-lime-800 uppercase tracking-widest">Estimated Profit</span>
                            <span className="text-sm font-black text-lime-700">${(selectedTicket.estimatedCost * 0.6).toFixed(2)}</span>
                          </div>
                        </div>
                        <button className="w-full py-4 bg-lime-400 hover:bg-lime-300 text-teal-950 font-black text-sm rounded-2xl shadow-lg transition-all active:scale-95 uppercase tracking-widest">
                          Collect Payment
                        </button>
                      </div>

                      {/* Location & Tracking */}
                      <div className="bg-slate-50 rounded-[2.5rem] p-8 space-y-4 shadow-inner">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Storage Location</h3>
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 rounded-2xl bg-white flex items-center justify-center text-primary shadow-sm border border-slate-100">
                            <span className="material-symbols-outlined">location_on</span>
                          </div>
                          <div>
                            <p className="text-lg font-black text-primary">{selectedTicket.location || 'Not Set'}</p>
                            <p className="text-[10px] font-bold text-slate-400 uppercase">Physical Bin</p>
                          </div>
                        </div>
                      </div>

                      {/* Danger Zone */}
                      <div className="pt-4">
                        <button className="w-full py-4 bg-red-50 text-red-600 hover:bg-red-100 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2">
                          <span className="material-symbols-outlined text-sm">delete</span>
                          Delete Repair Ticket
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'history' && (
                  <div className="max-w-3xl mx-auto space-y-8">
                    <h3 className="text-xl font-black text-primary tracking-tight">Activity Timeline</h3>
                    <div className="relative space-y-8 before:absolute before:left-6 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-100">
                      {selectedTicket.history?.map((log, i) => (
                        <div key={log.id} className="relative pl-16">
                          <div className="absolute left-4 top-1 w-4 h-4 rounded-full bg-white border-4 border-primary z-10" />
                          <div className="bg-slate-50 p-6 rounded-3xl shadow-inner">
                            <div className="flex justify-between items-start mb-2">
                              <h4 className="font-bold text-primary">{log.action}</h4>
                              <span className="text-[10px] font-bold text-slate-400 uppercase">{new Date(log.timestamp).toLocaleString()}</span>
                            </div>
                            <p className="text-xs text-slate-500">Performed by <span className="font-bold text-slate-700">{log.performedBy}</span></p>
                            {log.details && <p className="mt-2 text-xs text-slate-400 italic">{log.details}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeTab === 'comments' && (
                  <div className="max-w-3xl mx-auto space-y-8">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xl font-black text-primary tracking-tight">Staff Communication</h3>
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Internal Only</span>
                    </div>
                    
                    <div className="space-y-6">
                      {selectedTicket.comments?.map(comment => (
                        <div key={comment.id} className="flex gap-4">
                          <div className="w-10 h-10 rounded-full bg-slate-200 overflow-hidden flex-shrink-0">
                            <img src={`https://i.pravatar.cc/100?u=${comment.authorId}`} alt="author" />
                          </div>
                          <div className="flex-1 bg-slate-50 p-6 rounded-3xl shadow-inner">
                            <div className="flex justify-between items-center mb-2">
                              <span className="font-bold text-primary">{comment.authorName}</span>
                              <span className="text-[10px] font-bold text-slate-400 uppercase">{new Date(comment.createdAt).toLocaleString()}</span>
                            </div>
                            <p className="text-sm text-slate-600">{comment.text}</p>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="pt-6 border-t border-slate-100">
                      <div className="relative">
                        <textarea 
                          id="comment-input"
                          className="w-full bg-slate-50 border-none rounded-[2rem] p-6 text-sm font-medium focus:ring-secondary shadow-inner min-h-[120px] pr-20"
                          placeholder="Type an internal comment for the team..."
                        />
                        <button 
                          onClick={() => {
                            const input = document.getElementById('comment-input') as HTMLTextAreaElement;
                            handleAddComment(input.value);
                            input.value = '';
                          }}
                          className="absolute right-4 bottom-4 w-12 h-12 bg-primary text-white rounded-2xl flex items-center justify-center shadow-lg active:scale-95 transition-all"
                        >
                          <span className="material-symbols-outlined">send</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'attachments' && (
                  <div className="space-y-8">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xl font-black text-primary tracking-tight">Device Media & Documents</h3>
                      <button className="bg-slate-100 hover:bg-slate-200 text-slate-600 px-6 py-2 rounded-xl font-bold text-xs flex items-center gap-2 transition-all">
                        <span className="material-symbols-outlined text-sm">upload</span>
                        Upload Files
                      </button>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
                      {/* Placeholder for attachments */}
                      <div className="aspect-square bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-400 group hover:border-primary hover:text-primary transition-all cursor-pointer">
                        <span className="material-symbols-outlined text-3xl mb-2">add_a_photo</span>
                        <span className="text-[10px] font-black uppercase tracking-widest">Add Image</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="p-8 bg-slate-50 border-t border-slate-100 flex justify-between items-center">
                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full bg-lime-400"></span>
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Last Sync: Just Now</span>
                  </div>
                </div>
                <div className="flex gap-4">
                  <button 
                    onClick={() => setIsDetailModalOpen(false)}
                    className="px-8 py-4 bg-white text-slate-500 border border-slate-200 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-50 transition-all"
                  >
                    Close View
                  </button>
                  <button className="px-8 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-teal-900/20 active:scale-95 transition-all">
                    Save All Changes
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* New Ticket Modal (Simplified for now) */}
      <AnimatePresence>
        {isNewTicketModalOpen && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsNewTicketModalOpen(false)}
              className="absolute inset-0 bg-teal-950/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl overflow-hidden"
            >
              <div className="signature-gradient p-8 text-white">
                <h2 className="text-2xl font-black tracking-tight">Create New Repair Order</h2>
                <p className="text-teal-100/70 text-sm font-bold uppercase tracking-widest mt-1">Operational Intake Flow</p>
              </div>
              <div className="p-10 space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Customer Search</label>
                    <input type="text" className="w-full bg-slate-50 border-none rounded-2xl px-5 py-4 text-sm font-bold focus:ring-secondary shadow-inner" placeholder="Name, Phone or Email..." />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Device Model</label>
                    <input type="text" className="w-full bg-slate-50 border-none rounded-2xl px-5 py-4 text-sm font-bold focus:ring-secondary shadow-inner" placeholder="e.g. iPhone 15 Pro Max" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Issue / Service Required</label>
                  <textarea className="w-full bg-slate-50 border-none rounded-2xl px-5 py-4 text-sm font-bold focus:ring-secondary shadow-inner h-24" placeholder="Describe the problem or select a service..." />
                </div>
                <div className="flex gap-4 pt-4">
                  <button 
                    onClick={() => setIsNewTicketModalOpen(false)}
                    className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={() => {
                      alert('Ticket created successfully!');
                      setIsNewTicketModalOpen(false);
                    }}
                    className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-teal-900/20 active:scale-95 transition-all"
                  >
                    Generate Ticket
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ContextualHelp 
        title="Repair Workflow Guide"
        items={[
          { title: 'Device & Repair Logic', description: 'Link specific devices to repair services to track common issues and successful fixes over time.', icon: 'build' },
          { title: 'Ticket Status Flow', description: 'Manage the lifecycle of a repair from "Pending" to "Delivered" with automated notifications.', icon: 'sync' },
          { title: 'Internal Communication', description: 'Use staff comments to document repair progress and collaborate with other technicians.', icon: 'forum' },
          { title: 'Diagnostic Documentation', description: 'Record pre-repair and post-repair conditions to protect against liability and ensure quality.', icon: 'fact_check' }
        ]}
        accentColor="primary"
      />
    </div>
  );
}
