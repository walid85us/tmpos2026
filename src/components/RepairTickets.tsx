import React, { useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { RepairTicket, RepairTicketStatus, TicketComment, RepairServiceLineItem, Invoice } from '../types';
import { useStoreLocalState, SEED_POS_OPERATORS } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import ContextualHelp from './ContextualHelp';

const ALL_STATUSES: RepairTicketStatus[] = ['Pending', 'Diagnosed', 'In Progress', 'Awaiting Parts', 'Ready for Pickup', 'Completed', 'Delivered', 'Cancelled'];

const VALID_TRANSITIONS: Record<RepairTicketStatus, RepairTicketStatus[]> = {
  'Pending': ['Diagnosed', 'In Progress', 'Cancelled'],
  'Diagnosed': ['In Progress', 'Awaiting Parts', 'Cancelled'],
  'In Progress': ['Awaiting Parts', 'Ready for Pickup', 'Completed', 'Cancelled'],
  'Awaiting Parts': ['In Progress', 'Cancelled'],
  'Ready for Pickup': ['Completed', 'Delivered'],
  'Completed': ['Delivered'],
  'Delivered': [],
  'Cancelled': ['Pending'],
};

const STATUS_COLORS: Record<RepairTicketStatus, string> = {
  'Pending': 'bg-amber-100 text-amber-800',
  'Diagnosed': 'bg-violet-100 text-violet-800',
  'In Progress': 'bg-primary text-white',
  'Awaiting Parts': 'bg-blue-100 text-blue-800',
  'Ready for Pickup': 'bg-lime-100 text-lime-800',
  'Completed': 'bg-emerald-100 text-emerald-800',
  'Delivered': 'bg-slate-200 text-slate-600',
  'Cancelled': 'bg-red-100 text-red-700',
};

const STATUS_ICONS: Record<RepairTicketStatus, string> = {
  'Pending': 'pending', 'Diagnosed': 'biotech', 'In Progress': 'build',
  'Awaiting Parts': 'inventory', 'Ready for Pickup': 'check_circle', 'Completed': 'task_alt',
  'Delivered': 'local_shipping', 'Cancelled': 'cancel',
};

const PRE_REPAIR_CONDITIONS = ['Power On', 'Power Off', 'Cracked Screen', 'Scratched Frame', 'Liquid Indicator Triggered', 'Battery Swelling', 'Keyboard Intermittent', 'Cosmetic Only', 'No Video Output', 'Audio OK', 'Slow Performance', 'WiFi Issues', 'Charging Issues', 'Camera Broken', 'Speaker Broken', 'Microphone Issues'];

const DEVICE_CATEGORIES = ['Smartphones', 'Laptops', 'Tablets', 'Game Consoles', 'Desktops', 'Wearables', 'Other'];

interface NewTicketForm {
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  device: string;
  deviceCategory: string;
  brand: string;
  model: string;
  issue: string;
  intakeNotes: string;
  priority: 'Low' | 'Medium' | 'High' | 'Rush';
  technicianId: string;
  technicianName: string;
  location: string;
  imei: string;
  serialNumber: string;
  passcode: string;
  network: string;
  preRepairCondition: string[];
  selectedServiceIds: string[];
}

const EMPTY_FORM: NewTicketForm = {
  customerId: '', customerName: '', customerPhone: '', customerEmail: '',
  device: '', deviceCategory: '', brand: '', model: '', issue: '', intakeNotes: '',
  priority: 'Medium', technicianId: '', technicianName: '', location: '',
  imei: '', serialNumber: '', passcode: '', network: '',
  preRepairCondition: [], selectedServiceIds: [],
};

export default function RepairTickets() {
  const {
    repairTickets, addRepairTicket, updateRepairTicket, deleteRepairTicket,
    warrantyRepairTickets, updateWarrantyRepairTicket,
    warrantyClaims, updateWarrantyClaim,
    customers, services, serviceCategories, approvedStockItems,
    invoices, addInvoice, posOperator,
  } = useStoreLocalState();
  const navigate = useNavigate();
  const { checkPermission, checkSubPermission, effectiveRole, session } = useAccess();
  const canCreateTickets = checkPermission('repairs', 'create');
  const canEditTickets = checkPermission('repairs', 'edit');
  const canManageTickets = checkPermission('repairs', 'manage');
  const canAssignTechnician = checkSubPermission('assign_technician');

  const isTechnicianRole = effectiveRole === 'technician';
  const currentOperatorId = posOperator?.id || session?.user?.id || '';
  const currentOperatorName = posOperator?.name || session?.user?.name || 'Current User';

  const allTickets = useMemo(() => [...repairTickets, ...warrantyRepairTickets], [repairTickets, warrantyRepairTickets]);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [priorityFilter, setPriorityFilter] = useState<string>('All');
  const [techFilter, setTechFilter] = useState<string>('All');
  const [sortBy, setSortBy] = useState<'newest' | 'priority' | 'status'>('newest');
  const [selectedTicket, setSelectedTicket] = useState<RepairTicket | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [isNewTicketModalOpen, setIsNewTicketModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'history' | 'comments' | 'attachments'>('details');
  const [newForm, setNewForm] = useState<NewTicketForm>(EMPTY_FORM);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [serviceSearch, setServiceSearch] = useState('');
  const [showServiceDropdown, setShowServiceDropdown] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [commentIsInternal, setCommentIsInternal] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [partSearch, setPartSearch] = useState('');
  const [showPartDropdown, setShowPartDropdown] = useState(false);
  const [formSaved, setFormSaved] = useState(false);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);

  const stats = useMemo(() => ({
    pending: allTickets.filter(t => t.status === 'Pending').length,
    diagnosed: allTickets.filter(t => t.status === 'Diagnosed').length,
    inProgress: allTickets.filter(t => t.status === 'In Progress').length,
    awaitingParts: allTickets.filter(t => t.status === 'Awaiting Parts').length,
    readyForPickup: allTickets.filter(t => t.status === 'Ready for Pickup').length,
  }), [allTickets]);

  const technicians = useMemo(() => {
    const techSet = new Map<string, string>();
    allTickets.forEach(t => { if (t.technicianId && t.technicianName) techSet.set(t.technicianId, t.technicianName); });
    SEED_POS_OPERATORS.forEach(op => techSet.set(op.id, op.name));
    return Array.from(techSet.entries()).map(([id, name]) => ({ id, name }));
  }, [allTickets]);

  const filteredTickets = useMemo(() => {
    let result = allTickets.filter(ticket => {
      const q = searchQuery.toLowerCase();
      const matchesSearch = !q ||
        ticket.ticketNumber.toLowerCase().includes(q) ||
        ticket.customerName.toLowerCase().includes(q) ||
        ticket.device.toLowerCase().includes(q) ||
        ticket.issue.toLowerCase().includes(q) ||
        (ticket.imei && ticket.imei.toLowerCase().includes(q)) ||
        (ticket.serialNumber && ticket.serialNumber.toLowerCase().includes(q));
      const matchesStatus = statusFilter === 'All' || ticket.status === statusFilter;
      const matchesPriority = priorityFilter === 'All' || ticket.priority === priorityFilter;
      const matchesTech = techFilter === 'All' || ticket.technicianId === techFilter;
      return matchesSearch && matchesStatus && matchesPriority && matchesTech;
    });
    if (sortBy === 'newest') result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    else if (sortBy === 'priority') {
      const pOrder = { Rush: 0, High: 1, Medium: 2, Low: 3 };
      result.sort((a, b) => pOrder[a.priority] - pOrder[b.priority]);
    } else if (sortBy === 'status') {
      result.sort((a, b) => ALL_STATUSES.indexOf(a.status) - ALL_STATUSES.indexOf(b.status));
    }
    return result;
  }, [allTickets, searchQuery, statusFilter, priorityFilter, techFilter, sortBy]);

  const customerMatches = useMemo(() => {
    if (!customerSearch.trim()) return [];
    const q = customerSearch.toLowerCase();
    return customers.filter(c =>
      c.name.toLowerCase().includes(q) || c.phone.includes(q) || (c.email && c.email.toLowerCase().includes(q))
    ).slice(0, 8);
  }, [customerSearch, customers]);

  const serviceMatches = useMemo(() => {
    if (!serviceSearch.trim()) return services.filter(s => s.status === 'Active').slice(0, 8);
    const q = serviceSearch.toLowerCase();
    return services.filter(s => s.status === 'Active' && (s.name.toLowerCase().includes(q) || s.categoryName.toLowerCase().includes(q))).slice(0, 8);
  }, [serviceSearch, services]);

  const partMatches = useMemo(() => {
    if (!partSearch.trim()) return approvedStockItems.slice(0, 8);
    const q = partSearch.toLowerCase();
    return approvedStockItems.filter(s => s.name.toLowerCase().includes(q) || s.sku.toLowerCase().includes(q)).slice(0, 8);
  }, [partSearch, approvedStockItems]);

  const selectedServices = useMemo(() => {
    return newForm.selectedServiceIds.map(sid => services.find(s => s.id === sid)).filter(Boolean) as typeof services;
  }, [newForm.selectedServiceIds, services]);

  const estimatedTotal = useMemo(() => selectedServices.reduce((sum, s) => sum + s.price, 0), [selectedServices]);

  const handleSelectCustomer = useCallback((c: typeof customers[0]) => {
    setNewForm(prev => ({ ...prev, customerId: c.id, customerName: c.name, customerPhone: c.phone, customerEmail: c.email || '' }));
    setCustomerSearch(c.name);
    setShowCustomerDropdown(false);
  }, []);

  const handleToggleService = useCallback((serviceId: string) => {
    setNewForm(prev => ({
      ...prev,
      selectedServiceIds: prev.selectedServiceIds.includes(serviceId)
        ? prev.selectedServiceIds.filter(id => id !== serviceId)
        : [...prev.selectedServiceIds, serviceId]
    }));
  }, []);

  const handleToggleCondition = useCallback((condition: string) => {
    setNewForm(prev => ({
      ...prev,
      preRepairCondition: prev.preRepairCondition.includes(condition)
        ? prev.preRepairCondition.filter(c => c !== condition)
        : [...prev.preRepairCondition, condition]
    }));
  }, []);

  const handleCreateTicket = useCallback(() => {
    if (!newForm.customerName.trim() || !newForm.device.trim() || !newForm.issue.trim()) return;
    const now = new Date().toISOString();
    const ticketNum = `T-${(1000 + allTickets.length + 1)}`;
    const lineItems: RepairServiceLineItem[] = selectedServices.map(s => ({
      id: `sli-${Date.now()}-${s.id}`,
      serviceId: s.id, name: s.name, price: s.price, cost: s.cost || 0, warrantyPeriod: s.warrantyPeriod,
    }));
    const autoAssignTech = isTechnicianRole && !newForm.technicianId;
    const finalTechId = newForm.technicianId || (autoAssignTech ? currentOperatorId : undefined);
    const finalTechName = newForm.technicianName || (autoAssignTech ? currentOperatorName : undefined);
    const ticket: RepairTicket = {
      id: `rt-${Date.now()}`, ticketNumber: ticketNum,
      customerId: newForm.customerId || `walk-in-${Date.now()}`, customerName: newForm.customerName,
      customerPhone: newForm.customerPhone, customerEmail: newForm.customerEmail,
      device: newForm.device, deviceCategory: newForm.deviceCategory, brand: newForm.brand, model: newForm.model,
      issue: newForm.issue, intakeNotes: newForm.intakeNotes,
      status: 'Pending', priority: newForm.priority, isRushJob: newForm.priority === 'Rush',
      createdAt: now, updatedAt: now, estimatedCost: estimatedTotal || 0,
      technicianId: finalTechId, technicianName: finalTechName,
      location: newForm.location || 'Intake Shelf',
      imei: newForm.imei || undefined, serialNumber: newForm.serialNumber || undefined,
      passcode: newForm.passcode || undefined, network: newForm.network || undefined,
      preRepairCondition: newForm.preRepairCondition.length > 0 ? newForm.preRepairCondition : undefined,
      serviceLineItems: lineItems.length > 0 ? lineItems : undefined,
      history: [
        { id: `h-${Date.now()}`, action: 'Ticket Created', performedBy: currentOperatorName, timestamp: now },
        ...(finalTechName ? [{ id: `h-${Date.now()}-a`, action: `Assigned to ${finalTechName}${autoAssignTech ? ' (auto)' : ''}`, performedBy: currentOperatorName, timestamp: now }] : []),
      ],
      comments: [],
    };
    addRepairTicket(ticket);
    setNewForm(EMPTY_FORM);
    setCustomerSearch('');
    setServiceSearch('');
    setIsNewTicketModalOpen(false);
  }, [newForm, selectedServices, estimatedTotal, allTickets.length, addRepairTicket, isTechnicianRole, currentOperatorId, currentOperatorName]);

  const generateRepairInvoice = useCallback((ticket: RepairTicket) => {
    if (ticket.linkedInvoiceId) return;
    const now = new Date().toISOString();
    const serviceItems = (ticket.serviceLineItems || []).map(sli => ({
      id: `inv-item-${sli.id}`, name: sli.name, quantity: 1, price: sli.price, type: 'service' as const,
    }));
    const partItems = (ticket.partsUsed || []).map(p => ({
      id: `inv-item-${p.itemId}`, name: p.name, quantity: p.quantity, price: p.price, type: 'repair' as const,
    }));
    const allItems = [...serviceItems, ...partItems];
    if (allItems.length === 0) return;
    const subtotal = allItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const tax = Math.round(subtotal * 0.08 * 100) / 100;
    const total = subtotal + tax;
    const invNum = `INV-R-${(1000 + invoices.length + 1)}`;
    const invoiceId = `inv-repair-${Date.now()}`;
    const invoice: Invoice = {
      id: invoiceId, invoiceNumber: invNum,
      customerId: ticket.customerId, customerName: ticket.customerName,
      customerEmail: ticket.customerEmail, customerPhone: ticket.customerPhone,
      items: allItems, subtotal, discount: 0, tax, total,
      amountPaid: 0, balance: total,
      status: 'Unpaid', createdAt: now,
      dueDate: new Date(Date.now() + 30 * 86400000).toISOString(),
      notes: `Repair invoice for ${ticket.ticketNumber} — ${ticket.device}`,
      paymentHistory: [],
      statusHistory: [{ id: `sh-${Date.now()}`, action: 'created', fromStatus: '', toStatus: 'Unpaid', timestamp: now, actor: 'System', note: `Auto-generated from completed repair ${ticket.ticketNumber}` }],
      remindersSent: 0,
    };
    addInvoice(invoice);
    return invoiceId;
  }, [invoices.length, addInvoice]);

  const handleStatusChange = useCallback((id: string, newStatus: RepairTicketStatus) => {
    if (!canEditTickets) return;
    const now = new Date().toISOString();
    const ticket = allTickets.find(t => t.id === id);
    if (!ticket) return;
    const allowed = VALID_TRANSITIONS[ticket.status];
    if (!allowed.includes(newStatus)) return;
    const updates: Partial<RepairTicket> = {
      status: newStatus,
      updatedAt: now,
      history: [...(ticket.history || []), { id: `h-${Date.now()}`, action: `Status → ${newStatus}`, performedBy: currentOperatorName, timestamp: now }],
    };
    if (newStatus === 'Completed' && !ticket.linkedInvoiceId) {
      const invoiceId = generateRepairInvoice(ticket);
      if (invoiceId) {
        updates.linkedInvoiceId = invoiceId;
        updates.history = [...(updates.history || []), { id: `h-${Date.now()}-inv`, action: 'Invoice generated', performedBy: 'System', timestamp: now }];
      }
    }
    const isWarranty = warrantyRepairTickets.some(wt => wt.id === id);
    if (isWarranty) {
      updateWarrantyRepairTicket(id, updates);
      if (newStatus === 'Completed' || newStatus === 'Delivered') {
        const linkedClaim = warrantyClaims.find(wc => wc.linkedRepairId === id);
        if (linkedClaim && linkedClaim.status === 'In Repair') {
          updateWarrantyClaim(linkedClaim.id, {
            status: 'Completed',
            statusHistory: [...linkedClaim.statusHistory, { status: 'Completed', date: now, by: ticket.technicianName || 'Technician', note: `Warranty repair ${newStatus.toLowerCase()}` }],
          });
        }
      }
    } else {
      updateRepairTicket(id, updates);
    }
    if (selectedTicket?.id === id) {
      setSelectedTicket(prev => prev ? { ...prev, ...updates } : null);
    }
  }, [canEditTickets, allTickets, warrantyRepairTickets, warrantyClaims, updateRepairTicket, updateWarrantyRepairTicket, updateWarrantyClaim, selectedTicket, generateRepairInvoice]);

  const handleAssignTechnician = useCallback((ticketId: string, techId: string, techName: string) => {
    if (!canAssignTechnician) return;
    const now = new Date().toISOString();
    const ticket = allTickets.find(t => t.id === ticketId);
    if (!ticket) return;
    const updates: Partial<RepairTicket> = {
      technicianId: techId, technicianName: techName, updatedAt: now,
      history: [...(ticket.history || []), { id: `h-${Date.now()}`, action: `Assigned to ${techName}`, performedBy: currentOperatorName, timestamp: now }],
    };
    const isWarranty = warrantyRepairTickets.some(wt => wt.id === ticketId);
    if (isWarranty) updateWarrantyRepairTicket(ticketId, updates);
    else updateRepairTicket(ticketId, updates);
    if (selectedTicket?.id === ticketId) setSelectedTicket(prev => prev ? { ...prev, ...updates } : null);
  }, [canAssignTechnician, allTickets, warrantyRepairTickets, updateRepairTicket, updateWarrantyRepairTicket, selectedTicket]);

  const handleAddComment = useCallback(() => {
    if (!selectedTicket || !commentText.trim()) return;
    const now = new Date().toISOString();
    const newComment: TicketComment = {
      id: `c-${Date.now()}`, authorId: currentOperatorId || 'u1', authorName: currentOperatorName,
      text: commentText.trim(), createdAt: now, isInternal: commentIsInternal,
    };
    const updates: Partial<RepairTicket> = {
      comments: [...(selectedTicket.comments || []), newComment],
      history: [...(selectedTicket.history || []), { id: `h-${Date.now()}`, action: `${commentIsInternal ? 'Internal' : 'Customer'} note added`, performedBy: currentOperatorName, timestamp: now }],
      updatedAt: now,
    };
    const isWarranty = warrantyRepairTickets.some(wt => wt.id === selectedTicket.id);
    if (isWarranty) updateWarrantyRepairTicket(selectedTicket.id, updates);
    else updateRepairTicket(selectedTicket.id, updates);
    setSelectedTicket(prev => prev ? { ...prev, ...updates } : null);
    setCommentText('');
  }, [selectedTicket, commentText, commentIsInternal, warrantyRepairTickets, updateRepairTicket, updateWarrantyRepairTicket]);

  const handleAddPartToTicket = useCallback((itemId: string, itemName: string, itemPrice: number) => {
    if (!selectedTicket) return;
    const now = new Date().toISOString();
    const existing = selectedTicket.partsUsed || [];
    const found = existing.find(p => p.itemId === itemId);
    const newParts = found
      ? existing.map(p => p.itemId === itemId ? { ...p, quantity: p.quantity + 1 } : p)
      : [...existing, { itemId, name: itemName, price: itemPrice, quantity: 1 }];
    const updates: Partial<RepairTicket> = {
      partsUsed: newParts, updatedAt: now,
      history: [...(selectedTicket.history || []), { id: `h-${Date.now()}`, action: `Part Added: ${itemName}`, performedBy: currentOperatorName, timestamp: now }],
    };
    const isWarranty = warrantyRepairTickets.some(wt => wt.id === selectedTicket.id);
    if (isWarranty) updateWarrantyRepairTicket(selectedTicket.id, updates);
    else updateRepairTicket(selectedTicket.id, updates);
    setSelectedTicket(prev => prev ? { ...prev, ...updates } : null);
    setPartSearch('');
    setShowPartDropdown(false);
  }, [selectedTicket, warrantyRepairTickets, updateRepairTicket, updateWarrantyRepairTicket]);

  const handleAddServiceToTicket = useCallback((svc: typeof services[0]) => {
    if (!selectedTicket) return;
    const now = new Date().toISOString();
    const existing = selectedTicket.serviceLineItems || [];
    if (existing.some(s => s.serviceId === svc.id)) return;
    const newItem: RepairServiceLineItem = { id: `sli-${Date.now()}`, serviceId: svc.id, name: svc.name, price: svc.price, cost: svc.cost || 0, warrantyPeriod: svc.warrantyPeriod };
    const updates: Partial<RepairTicket> = {
      serviceLineItems: [...existing, newItem], updatedAt: now,
      estimatedCost: (selectedTicket.estimatedCost || 0) + svc.price,
      history: [...(selectedTicket.history || []), { id: `h-${Date.now()}`, action: `Service Added: ${svc.name}`, performedBy: currentOperatorName, timestamp: now }],
    };
    const isWarranty = warrantyRepairTickets.some(wt => wt.id === selectedTicket.id);
    if (isWarranty) updateWarrantyRepairTicket(selectedTicket.id, updates);
    else updateRepairTicket(selectedTicket.id, updates);
    setSelectedTicket(prev => prev ? { ...prev, ...updates } : null);
  }, [selectedTicket, warrantyRepairTickets, updateRepairTicket, updateWarrantyRepairTicket]);

  const handleRemoveServiceFromTicket = useCallback((sliId: string) => {
    if (!selectedTicket) return;
    const now = new Date().toISOString();
    const removed = (selectedTicket.serviceLineItems || []).find(s => s.id === sliId);
    const updated = (selectedTicket.serviceLineItems || []).filter(s => s.id !== sliId);
    const updates: Partial<RepairTicket> = {
      serviceLineItems: updated, updatedAt: now,
      estimatedCost: Math.max(0, (selectedTicket.estimatedCost || 0) - (removed?.price || 0)),
      history: [...(selectedTicket.history || []), { id: `h-${Date.now()}`, action: `Service Removed: ${removed?.name || 'Unknown'}`, performedBy: currentOperatorName, timestamp: now }],
    };
    const isWarranty = warrantyRepairTickets.some(wt => wt.id === selectedTicket.id);
    if (isWarranty) updateWarrantyRepairTicket(selectedTicket.id, updates);
    else updateRepairTicket(selectedTicket.id, updates);
    setSelectedTicket(prev => prev ? { ...prev, ...updates } : null);
  }, [selectedTicket, warrantyRepairTickets, updateRepairTicket, updateWarrantyRepairTicket]);

  const handleRemovePartFromTicket = useCallback((itemId: string) => {
    if (!selectedTicket) return;
    const now = new Date().toISOString();
    const removed = (selectedTicket.partsUsed || []).find(p => p.itemId === itemId);
    const updated = (selectedTicket.partsUsed || []).filter(p => p.itemId !== itemId);
    const updates: Partial<RepairTicket> = {
      partsUsed: updated, updatedAt: now,
      history: [...(selectedTicket.history || []), { id: `h-${Date.now()}`, action: `Part Removed: ${removed?.name || 'Unknown'}`, performedBy: currentOperatorName, timestamp: now }],
    };
    const isWarranty = warrantyRepairTickets.some(wt => wt.id === selectedTicket.id);
    if (isWarranty) updateWarrantyRepairTicket(selectedTicket.id, updates);
    else updateRepairTicket(selectedTicket.id, updates);
    setSelectedTicket(prev => prev ? { ...prev, ...updates } : null);
  }, [selectedTicket, warrantyRepairTickets, updateRepairTicket, updateWarrantyRepairTicket]);

  const handleSaveTicketFields = useCallback((updates: Partial<RepairTicket>) => {
    if (!selectedTicket) return;
    const now = new Date().toISOString();
    const fullUpdates = { ...updates, updatedAt: now };
    const isWarranty = warrantyRepairTickets.some(wt => wt.id === selectedTicket.id);
    if (isWarranty) updateWarrantyRepairTicket(selectedTicket.id, fullUpdates);
    else updateRepairTicket(selectedTicket.id, fullUpdates);
    setSelectedTicket(prev => prev ? { ...prev, ...fullUpdates } : null);
    setFormSaved(true);
    setTimeout(() => setFormSaved(false), 1500);
  }, [selectedTicket, warrantyRepairTickets, updateRepairTicket, updateWarrantyRepairTicket]);

  const handleToggleConditionOnTicket = useCallback((condition: string, type: 'pre' | 'post') => {
    if (!selectedTicket) return;
    const field = type === 'pre' ? 'preRepairCondition' : 'postRepairCondition';
    const current = selectedTicket[field] || [];
    const updated = current.includes(condition) ? current.filter(c => c !== condition) : [...current, condition];
    handleSaveTicketFields({ [field]: updated });
  }, [selectedTicket, handleSaveTicketFields]);

  const handleDeleteTicket = useCallback((id: string) => {
    deleteRepairTicket(id);
    setDeleteConfirm(null);
    setIsDetailModalOpen(false);
    setSelectedTicket(null);
  }, [deleteRepairTicket]);

  const handleViewDetails = useCallback((ticket: RepairTicket) => {
    setSelectedTicket(ticket);
    setIsDetailModalOpen(true);
    setActiveTab('details');
    setPartSearch('');
    setShowPartDropdown(false);
  }, []);

  const exportToCSV = useCallback(() => {
    const header = 'Ticket #,Customer,Device,Issue,Status,Priority,Technician,Est. Cost,Created\n';
    const rows = filteredTickets.map(t =>
      `${t.ticketNumber},"${t.customerName}","${t.device}","${t.issue}",${t.status},${t.priority},${t.technicianName || 'Unassigned'},${t.estimatedCost.toFixed(2)},${t.createdAt}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `repair-tickets-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }, [filteredTickets]);

  const servicesTotal = (selectedTicket?.serviceLineItems || []).reduce((s, i) => s + i.price, 0);
  const partsTotal = (selectedTicket?.partsUsed || []).reduce((s, p) => s + p.price * p.quantity, 0);
  const ticketTotal = servicesTotal + partsTotal;

  return (
    <div className="space-y-8 font-sans antialiased">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Operational Ledger</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Manage Tickets</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative w-64">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
            <input type="text" placeholder="Search tickets..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-slate-100 border-none rounded-xl pl-10 pr-4 py-2 text-sm focus:ring-secondary" />
          </div>
          <button onClick={exportToCSV} className="p-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl transition-all" title="Export to CSV">
            <span className="material-symbols-outlined">download</span>
          </button>
          {canCreateTickets && (
            <button onClick={() => { setNewForm(EMPTY_FORM); setCustomerSearch(''); setServiceSearch(''); setIsNewTicketModalOpen(true); }}
              className="bg-lime-400 text-teal-950 px-6 py-2 rounded-xl font-bold text-sm shadow-lg active:scale-95 transition-transform flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">add</span> New Ticket
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { label: 'Pending', count: stats.pending, icon: 'pending', color: 'bg-amber-500' },
          { label: 'Diagnosed', count: stats.diagnosed, icon: 'biotech', color: 'bg-violet-500' },
          { label: 'In Progress', count: stats.inProgress, icon: 'build', color: 'bg-primary' },
          { label: 'Awaiting Parts', count: stats.awaitingParts, icon: 'inventory', color: 'bg-blue-500' },
          { label: 'Ready', count: stats.readyForPickup, icon: 'check_circle', color: 'bg-lime-500' },
        ].map((stat, i) => (
          <div key={i} className="bg-white p-5 rounded-3xl ghost-border shadow-sm flex items-center justify-between group hover:shadow-md transition-all cursor-pointer"
            onClick={() => setStatusFilter(stat.label === 'Ready' ? 'Ready for Pickup' : stat.label)}>
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{stat.label}</p>
              <p className="text-3xl font-black text-primary mt-1">{stat.count}</p>
            </div>
            <div className={`w-10 h-10 rounded-2xl ${stat.color}/10 flex items-center justify-center`}>
              <span className="material-symbols-outlined text-slate-500">{stat.icon}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar flex-1">
          {['All', ...ALL_STATUSES].map(status => (
            <button key={status} onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${statusFilter === status ? 'bg-primary text-white shadow-md' : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-100'}`}>
              {status}
            </button>
          ))}
        </div>
        <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}
          className="bg-white border border-slate-100 rounded-xl px-3 py-2 text-xs font-bold text-slate-500 focus:ring-secondary">
          <option value="All">All Priorities</option>
          {['Rush', 'High', 'Medium', 'Low'].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={techFilter} onChange={e => setTechFilter(e.target.value)}
          className="bg-white border border-slate-100 rounded-xl px-3 py-2 text-xs font-bold text-slate-500 focus:ring-secondary">
          <option value="All">All Technicians</option>
          {technicians.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}
          className="bg-white border border-slate-100 rounded-xl px-3 py-2 text-xs font-bold text-slate-500 focus:ring-secondary">
          <option value="newest">Newest First</option>
          <option value="priority">By Priority</option>
          <option value="status">By Status</option>
        </select>
      </div>

      <div className="bg-white rounded-[2rem] ghost-border shadow-sm overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="p-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Ticket #</th>
              <th className="p-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Device / Issue</th>
              <th className="p-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Customer</th>
              <th className="p-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Technician</th>
              <th className="p-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="p-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">Priority</th>
              <th className="p-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Quote</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filteredTickets.map(ticket => (
              <tr key={ticket.id} className="hover:bg-slate-50 transition-colors group cursor-pointer" onClick={() => handleViewDetails(ticket)}>
                <td className="p-5">
                  <div className="flex items-center gap-2">
                    <span className="font-black text-primary">{ticket.ticketNumber}</span>
                    {ticket.isWarrantyRepair && <span className="text-[8px] font-black bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded uppercase">Warranty</span>}
                    {ticket.isRushJob && <span className="text-[8px] font-black bg-red-100 text-red-600 px-1.5 py-0.5 rounded uppercase animate-pulse">Rush</span>}
                  </div>
                </td>
                <td className="p-5">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center text-primary">
                      <span className="material-symbols-outlined text-lg">
                        {ticket.deviceCategory === 'Laptops' ? 'laptop_mac' : ticket.deviceCategory === 'Tablets' ? 'tablet_mac' : ticket.deviceCategory === 'Game Consoles' ? 'videogame_asset' : 'smartphone'}
                      </span>
                    </div>
                    <div>
                      <p className="font-bold text-slate-900 text-sm">{ticket.device}</p>
                      <p className="text-[10px] font-medium text-slate-400 uppercase truncate max-w-[180px]">{ticket.issue}</p>
                    </div>
                  </div>
                </td>
                <td className="p-5"><p className="font-bold text-slate-900 text-sm">{ticket.customerName}</p></td>
                <td className="p-5">
                  <span className="text-sm font-medium text-slate-600">{ticket.technicianName || <span className="text-slate-400 italic">Unassigned</span>}</span>
                </td>
                <td className="p-5">
                  <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-tighter ${STATUS_COLORS[ticket.status]}`}>{ticket.status}</span>
                </td>
                <td className="p-5">
                  <span className={`text-[10px] font-black uppercase tracking-widest ${ticket.priority === 'Rush' ? 'text-red-600 animate-pulse' : ticket.priority === 'High' ? 'text-orange-600' : 'text-slate-400'}`}>
                    {ticket.priority}
                  </span>
                </td>
                <td className="p-5 text-right"><span className="font-black text-primary">${ticket.estimatedCost.toFixed(2)}</span></td>
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

      {/* ===== TICKET DETAIL MODAL ===== */}
      <AnimatePresence>
        {isDetailModalOpen && selectedTicket && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsDetailModalOpen(false)} className="absolute inset-0 bg-teal-950/60 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.95, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative w-full max-w-6xl bg-white rounded-[3rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
              <div className="signature-gradient p-7 text-white flex justify-between items-center shrink-0">
                <div className="flex items-center gap-5">
                  <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center backdrop-blur-md">
                    <span className="material-symbols-outlined text-2xl">confirmation_number</span>
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-2xl font-black tracking-tight">{selectedTicket.ticketNumber}</h2>
                      {selectedTicket.isRushJob && <span className="bg-red-500 text-white text-[10px] font-black px-2 py-0.5 rounded uppercase animate-pulse">Rush</span>}
                      {selectedTicket.isWarrantyRepair && <span className="bg-amber-400 text-amber-900 text-[10px] font-black px-2 py-0.5 rounded uppercase">Warranty</span>}
                    </div>
                    <p className="text-teal-100/70 font-bold uppercase tracking-widest text-xs">{selectedTicket.device} • {selectedTicket.customerName}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setIsDetailModalOpen(false)} className="w-11 h-11 bg-white/10 hover:bg-white/20 rounded-2xl flex items-center justify-center transition-all">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              </div>

              <div className="flex border-b border-slate-100 px-7 bg-slate-50/50 shrink-0">
                {[
                  { id: 'details', label: 'Details', icon: 'info' },
                  { id: 'history', label: 'Timeline', icon: 'history' },
                  { id: 'comments', label: 'Notes', icon: 'forum' },
                  { id: 'attachments', label: 'Attachments', icon: 'attachment' },
                ].map(tab => (
                  <button key={tab.id} onClick={() => setActiveTab(tab.id as any)}
                    className={`flex items-center gap-2 px-5 py-3.5 text-xs font-black uppercase tracking-widest transition-all border-b-4 ${activeTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
                    <span className="material-symbols-outlined text-sm">{tab.icon}</span> {tab.label}
                    {tab.id === 'comments' && (selectedTicket.comments?.length || 0) > 0 && (
                      <span className="bg-primary text-white text-[8px] font-black w-5 h-5 rounded-full flex items-center justify-center">{selectedTicket.comments?.length}</span>
                    )}
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-white">
                {activeTab === 'details' && (
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                    <div className="lg:col-span-8 space-y-8">
                      <div className="grid grid-cols-2 gap-5">
                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Workflow Status</label>
                          <select value={selectedTicket.status} onChange={e => handleStatusChange(selectedTicket.id, e.target.value as RepairTicketStatus)} disabled={!canEditTickets}
                            className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner disabled:opacity-50 disabled:cursor-not-allowed">
                            <option value={selectedTicket.status}>{selectedTicket.status}</option>
                            {VALID_TRANSITIONS[selectedTicket.status].map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Assigned Technician</label>
                          {canAssignTechnician ? (
                            <select value={selectedTicket.technicianId || ''} onChange={e => {
                              const tech = technicians.find(t => t.id === e.target.value);
                              if (tech) handleAssignTechnician(selectedTicket.id, tech.id, tech.name);
                            }} disabled={!canEditTickets}
                              className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner disabled:opacity-50">
                              <option value="">Unassigned</option>
                              {technicians.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                          ) : (
                            <p className="bg-slate-50 rounded-2xl px-5 py-3.5 text-sm font-bold text-slate-600 shadow-inner">
                              {selectedTicket.technicianName || <span className="text-slate-400 italic">Unassigned</span>}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="bg-slate-50 rounded-[2.5rem] p-7 space-y-5 shadow-inner">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="material-symbols-outlined text-primary">devices</span>
                          <h3 className="text-lg font-black text-primary tracking-tight">Device Information</h3>
                        </div>
                        <div className="grid grid-cols-3 gap-5">
                          {[
                            ['Device', selectedTicket.device],
                            ['Brand', selectedTicket.brand || 'N/A'],
                            ['Model', selectedTicket.model || 'N/A'],
                            ['Category', selectedTicket.deviceCategory || 'N/A'],
                            ['IMEI / Serial', selectedTicket.imei || selectedTicket.serialNumber || 'N/A'],
                            ['Network', selectedTicket.network || 'N/A'],
                          ].map(([label, val]) => (
                            <div key={label}>
                              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{label}</p>
                              <p className={`font-bold text-slate-900 text-sm ${label === 'IMEI / Serial' ? 'font-mono text-primary' : ''}`}>{val}</p>
                            </div>
                          ))}
                        </div>
                        {selectedTicket.passcode && (
                          <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                            <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-1">Device Passcode</p>
                            <p className="font-mono font-bold text-amber-800 text-sm">{selectedTicket.passcode}</p>
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-2">
                          <span className="material-symbols-outlined text-xs text-slate-400">location_on</span>
                          <span className="text-[10px] font-black uppercase tracking-widest text-primary">{selectedTicket.location || 'Not Set'}</span>
                          {canEditTickets && (
                            <input type="text" placeholder="Update location..." defaultValue={selectedTicket.location || ''}
                              onBlur={e => { if (e.target.value !== (selectedTicket.location || '')) handleSaveTicketFields({ location: e.target.value }); }}
                              className="ml-2 bg-white border border-slate-200 rounded-lg px-3 py-1 text-xs font-bold focus:ring-secondary w-40" />
                          )}
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-primary">build</span>
                            <h3 className="text-lg font-black text-primary tracking-tight">Service Line Items</h3>
                          </div>
                          {canEditTickets && (
                            <div className="relative">
                              <button onClick={() => setShowServiceDropdown(!showServiceDropdown)} className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1 hover:underline">
                                <span className="material-symbols-outlined text-sm">add</span> Add Service
                              </button>
                              {showServiceDropdown && (
                                <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-2xl shadow-2xl border border-slate-200 z-20 p-3 max-h-64 overflow-y-auto">
                                  <input type="text" placeholder="Search services..." value={serviceSearch} onChange={e => setServiceSearch(e.target.value)}
                                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-2 text-xs font-bold focus:ring-secondary mb-2" autoFocus />
                                  {serviceMatches.map(s => (
                                    <button key={s.id} onClick={() => { handleAddServiceToTicket(s); setShowServiceDropdown(false); setServiceSearch(''); }}
                                      className="w-full text-left p-3 hover:bg-slate-50 rounded-xl transition-all flex justify-between items-center">
                                      <div><p className="text-xs font-bold text-slate-900">{s.name}</p><p className="text-[10px] text-slate-400">{s.categoryName}</p></div>
                                      <span className="text-xs font-black text-primary">${s.price.toFixed(2)}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="bg-slate-50 rounded-[2rem] p-5 shadow-inner">
                          {(selectedTicket.serviceLineItems || []).length > 0 ? (
                            <div className="space-y-2">
                              {(selectedTicket.serviceLineItems || []).map(sli => (
                                <div key={sli.id} className="flex justify-between items-center bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
                                  <div>
                                    <p className="text-sm font-bold text-primary">{sli.name}</p>
                                    {sli.warrantyPeriod && <p className="text-[10px] text-slate-400 uppercase font-bold">Warranty: {sli.warrantyPeriod}</p>}
                                  </div>
                                  <div className="flex items-center gap-3">
                                    <span className="font-black text-primary">${sli.price.toFixed(2)}</span>
                                    {canEditTickets && (
                                      <button onClick={() => handleRemoveServiceFromTicket(sli.id)} className="w-7 h-7 rounded-lg bg-red-50 text-red-400 hover:bg-red-100 flex items-center justify-center transition-all">
                                        <span className="material-symbols-outlined text-sm">close</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-center py-5 text-slate-400"><p className="text-xs italic">No services linked yet.</p></div>
                          )}
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-primary">inventory_2</span>
                            <h3 className="text-lg font-black text-primary tracking-tight">Parts Used</h3>
                          </div>
                          {canEditTickets && (
                            <div className="relative">
                              <button onClick={() => setShowPartDropdown(!showPartDropdown)} className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1 hover:underline">
                                <span className="material-symbols-outlined text-sm">add</span> Add Part
                              </button>
                              {showPartDropdown && (
                                <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-2xl shadow-2xl border border-slate-200 z-20 p-3 max-h-64 overflow-y-auto">
                                  <input type="text" placeholder="Search inventory..." value={partSearch} onChange={e => setPartSearch(e.target.value)}
                                    className="w-full bg-slate-50 border-none rounded-xl px-4 py-2 text-xs font-bold focus:ring-secondary mb-2" autoFocus />
                                  {partMatches.map(p => (
                                    <button key={p.id} onClick={() => handleAddPartToTicket(p.id, p.name, p.price)}
                                      className="w-full text-left p-3 hover:bg-slate-50 rounded-xl transition-all flex justify-between items-center">
                                      <div><p className="text-xs font-bold text-slate-900">{p.name}</p><p className="text-[10px] text-slate-400">{p.sku} • {p.qty} in stock</p></div>
                                      <span className="text-xs font-black text-primary">${p.price.toFixed(2)}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="bg-slate-50 rounded-[2rem] p-5 shadow-inner">
                          {(selectedTicket.partsUsed || []).length > 0 ? (
                            <div className="space-y-2">
                              {(selectedTicket.partsUsed || []).map(part => (
                                <div key={part.itemId} className="flex justify-between items-center bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
                                  <div>
                                    <p className="text-sm font-bold text-primary">{part.name}</p>
                                    <p className="text-[10px] text-slate-400 uppercase font-bold">Qty: {part.quantity}</p>
                                  </div>
                                  <div className="flex items-center gap-3">
                                    <span className="font-black text-primary">${(part.price * part.quantity).toFixed(2)}</span>
                                    {canEditTickets && (
                                      <button onClick={() => handleRemovePartFromTicket(part.itemId)} className="w-7 h-7 rounded-lg bg-red-50 text-red-400 hover:bg-red-100 flex items-center justify-center transition-all">
                                        <span className="material-symbols-outlined text-sm">close</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-center py-5 text-slate-400"><p className="text-xs italic">No parts linked yet.</p></div>
                          )}
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div className="flex items-center gap-3">
                          <span className="material-symbols-outlined text-primary">description</span>
                          <h3 className="text-lg font-black text-primary tracking-tight">Notes & Diagnostics</h3>
                        </div>
                        <div className="grid grid-cols-1 gap-4">
                          {[
                            { label: 'Intake Notes', field: 'intakeNotes' as const, placeholder: 'Notes from customer intake...' },
                            { label: 'Diagnostic Findings', field: 'diagnosticNotes' as const, placeholder: 'Enter diagnostic findings...' },
                            { label: 'Internal Notes', field: 'internalNotes' as const, placeholder: 'Internal team notes...' },
                          ].map(n => (
                            <div key={n.field}>
                              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">{n.label}</label>
                              <textarea className="w-full bg-slate-50 border-none rounded-2xl p-4 text-sm font-medium focus:ring-secondary shadow-inner min-h-[80px]"
                                placeholder={n.placeholder} defaultValue={selectedTicket[n.field] || ''} disabled={!canEditTickets}
                                onBlur={e => { if (e.target.value !== (selectedTicket[n.field] || '')) handleSaveTicketFields({ [n.field]: e.target.value }); }} />
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-6">
                        <div className="space-y-3">
                          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Pre-Repair Conditions</h4>
                          <div className="flex flex-wrap gap-2">
                            {(selectedTicket.preRepairCondition || []).map(cond => (
                              <span key={cond} className="px-3 py-1.5 bg-amber-50 text-amber-800 rounded-xl text-[10px] font-black uppercase border border-amber-100 flex items-center gap-1">
                                {cond}
                                {canEditTickets && <button onClick={() => handleToggleConditionOnTicket(cond, 'pre')} className="text-amber-400 hover:text-amber-600"><span className="material-symbols-outlined text-[12px]">close</span></button>}
                              </span>
                            ))}
                            {canEditTickets && (
                              <div className="relative group">
                                <button className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-400 hover:bg-slate-200 transition-all">
                                  <span className="material-symbols-outlined text-sm">add</span>
                                </button>
                                <div className="absolute left-0 top-full mt-1 w-52 bg-white rounded-xl shadow-xl border border-slate-200 z-10 hidden group-focus-within:block p-2 max-h-48 overflow-y-auto">
                                  {PRE_REPAIR_CONDITIONS.filter(c => !(selectedTicket.preRepairCondition || []).includes(c)).map(c => (
                                    <button key={c} onClick={() => handleToggleConditionOnTicket(c, 'pre')} className="w-full text-left px-3 py-1.5 text-[10px] font-bold text-slate-600 hover:bg-slate-50 rounded-lg">{c}</button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="space-y-3">
                          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Post-Repair Conditions</h4>
                          <div className="flex flex-wrap gap-2">
                            {(selectedTicket.postRepairCondition || []).map(cond => (
                              <span key={cond} className="px-3 py-1.5 bg-lime-50 text-lime-800 rounded-xl text-[10px] font-black uppercase border border-lime-100 flex items-center gap-1">
                                {cond}
                                {canEditTickets && <button onClick={() => handleToggleConditionOnTicket(cond, 'post')} className="text-lime-400 hover:text-lime-600"><span className="material-symbols-outlined text-[12px]">close</span></button>}
                              </span>
                            ))}
                            {canEditTickets && (
                              <div className="relative group">
                                <button className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-400 hover:bg-slate-200 transition-all">
                                  <span className="material-symbols-outlined text-sm">add</span>
                                </button>
                                <div className="absolute left-0 top-full mt-1 w-52 bg-white rounded-xl shadow-xl border border-slate-200 z-10 hidden group-focus-within:block p-2 max-h-48 overflow-y-auto">
                                  {PRE_REPAIR_CONDITIONS.filter(c => !(selectedTicket.postRepairCondition || []).includes(c)).map(c => (
                                    <button key={c} onClick={() => handleToggleConditionOnTicket(c, 'post')} className="w-full text-left px-3 py-1.5 text-[10px] font-bold text-slate-600 hover:bg-slate-50 rounded-lg">{c}</button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="lg:col-span-4 space-y-6">
                      <div className="bg-primary text-white p-7 rounded-[2.5rem] shadow-xl relative overflow-hidden">
                        <div className="relative z-10">
                          <span className="text-teal-100/50 uppercase text-[10px] font-black tracking-widest">Customer</span>
                          <h4 className="text-lg font-black mt-1">{selectedTicket.customerName}</h4>
                          <div className="mt-4 space-y-2">
                            {selectedTicket.customerPhone && (
                              <div className="flex items-center gap-3 text-sm font-medium text-teal-100">
                                <span className="material-symbols-outlined text-sm">phone</span> {selectedTicket.customerPhone}
                              </div>
                            )}
                            {selectedTicket.customerEmail && (
                              <div className="flex items-center gap-3 text-sm font-medium text-teal-100">
                                <span className="material-symbols-outlined text-sm">mail</span> {selectedTicket.customerEmail}
                              </div>
                            )}
                          </div>
                        </div>
                        <span className="material-symbols-outlined absolute -right-4 -bottom-4 text-8xl opacity-10">person</span>
                      </div>

                      <div className="bg-slate-50 rounded-[2.5rem] p-7 space-y-4 shadow-inner">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Financial Summary</h3>
                        <div className="space-y-3">
                          <div className="flex justify-between items-center"><span className="text-sm font-bold text-slate-500">Services</span><span className="text-sm font-black text-primary">${servicesTotal.toFixed(2)}</span></div>
                          <div className="flex justify-between items-center"><span className="text-sm font-bold text-slate-500">Parts</span><span className="text-sm font-black text-primary">${partsTotal.toFixed(2)}</span></div>
                          <div className="pt-3 border-t border-slate-200 flex justify-between items-center">
                            <span className="text-base font-black text-primary">Total</span>
                            <span className="text-xl font-black text-primary">${ticketTotal.toFixed(2)}</span>
                          </div>
                          {selectedTicket.actualCost !== undefined && (
                            <div className="p-3 bg-lime-400/10 rounded-2xl flex justify-between items-center border border-lime-400/20">
                              <span className="text-[10px] font-black text-lime-800 uppercase tracking-widest">Actual Cost</span>
                              <span className="text-sm font-black text-lime-700">${selectedTicket.actualCost.toFixed(2)}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="bg-slate-50 rounded-[2.5rem] p-7 space-y-3 shadow-inner">
                        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Ticket Info</h3>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between"><span className="text-slate-500 font-bold">Created</span><span className="font-bold text-slate-700">{new Date(selectedTicket.createdAt).toLocaleDateString()}</span></div>
                          <div className="flex justify-between"><span className="text-slate-500 font-bold">Updated</span><span className="font-bold text-slate-700">{new Date(selectedTicket.updatedAt).toLocaleDateString()}</span></div>
                          <div className="flex justify-between"><span className="text-slate-500 font-bold">Priority</span><span className={`font-black ${selectedTicket.priority === 'Rush' ? 'text-red-600' : selectedTicket.priority === 'High' ? 'text-orange-600' : 'text-slate-700'}`}>{selectedTicket.priority}</span></div>
                        </div>
                      </div>

                      {canManageTickets && !warrantyRepairTickets.some(wt => wt.id === selectedTicket.id) && (
                        <button onClick={() => setDeleteConfirm(selectedTicket.id)}
                          className="w-full py-3 bg-red-50 text-red-600 hover:bg-red-100 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2">
                          <span className="material-symbols-outlined text-sm">delete</span> Delete Ticket
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'history' && (
                  <div className="max-w-3xl mx-auto space-y-6">
                    <h3 className="text-xl font-black text-primary tracking-tight">Activity Timeline</h3>
                    <div className="relative space-y-6 before:absolute before:left-6 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-100">
                      {(selectedTicket.history || []).map(log => (
                        <div key={log.id} className="relative pl-16">
                          <div className="absolute left-4 top-1 w-4 h-4 rounded-full bg-white border-4 border-primary z-10" />
                          <div className="bg-slate-50 p-5 rounded-2xl shadow-inner">
                            <div className="flex justify-between items-start mb-1.5">
                              <h4 className="font-bold text-primary text-sm">{log.action}</h4>
                              <span className="text-[10px] font-bold text-slate-400 uppercase">{new Date(log.timestamp).toLocaleString()}</span>
                            </div>
                            <p className="text-xs text-slate-500">by <span className="font-bold text-slate-700">{log.performedBy}</span></p>
                            {log.details && <p className="mt-2 text-xs text-slate-400 italic bg-white p-3 rounded-xl border border-slate-100">{log.details}</p>}
                          </div>
                        </div>
                      ))}
                      {(!selectedTicket.history || selectedTicket.history.length === 0) && (
                        <div className="text-center py-12 text-slate-400"><span className="material-symbols-outlined text-4xl mb-2">history</span><p className="text-xs font-bold">No events recorded yet.</p></div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'comments' && (
                  <div className="max-w-3xl mx-auto space-y-6">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xl font-black text-primary tracking-tight">Notes & Communication</h3>
                    </div>
                    <div className="space-y-4">
                      {(selectedTicket.comments || []).map(comment => (
                        <div key={comment.id} className="flex gap-4">
                          <div className="w-9 h-9 rounded-full bg-slate-200 overflow-hidden flex-shrink-0 flex items-center justify-center text-primary font-black text-xs">
                            {comment.authorName.split(' ').map(w => w[0]).join('')}
                          </div>
                          <div className={`flex-1 p-5 rounded-2xl shadow-inner ${comment.isInternal ? 'bg-slate-50' : 'bg-blue-50 border border-blue-100'}`}>
                            <div className="flex justify-between items-center mb-1.5">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-primary text-sm">{comment.authorName}</span>
                                <span className={`text-[8px] font-black px-2 py-0.5 rounded uppercase ${comment.isInternal ? 'bg-slate-200 text-slate-500' : 'bg-blue-200 text-blue-700'}`}>
                                  {comment.isInternal ? 'Internal' : 'Customer'}
                                </span>
                              </div>
                              <span className="text-[10px] font-bold text-slate-400 uppercase">{new Date(comment.createdAt).toLocaleString()}</span>
                            </div>
                            <p className="text-sm text-slate-600">{comment.text}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="pt-4 border-t border-slate-100">
                      <div className="flex items-center gap-2 mb-2">
                        <button onClick={() => setCommentIsInternal(true)}
                          className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${commentIsInternal ? 'bg-primary text-white' : 'bg-slate-100 text-slate-400'}`}>
                          Internal Note
                        </button>
                        <button onClick={() => setCommentIsInternal(false)}
                          className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${!commentIsInternal ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-400'}`}>
                          Customer Note
                        </button>
                      </div>
                      <div className="relative">
                        <textarea ref={commentInputRef} value={commentText} onChange={e => setCommentText(e.target.value)}
                          className="w-full bg-slate-50 border-none rounded-2xl p-5 text-sm font-medium focus:ring-secondary shadow-inner min-h-[100px] pr-16"
                          placeholder={commentIsInternal ? 'Type an internal note for the team...' : 'Type a customer-facing note...'} />
                        <button onClick={handleAddComment} disabled={!commentText.trim()}
                          className="absolute right-3 bottom-3 w-10 h-10 bg-primary text-white rounded-xl flex items-center justify-center shadow-lg active:scale-95 transition-all disabled:opacity-50">
                          <span className="material-symbols-outlined text-lg">send</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'attachments' && (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xl font-black text-primary tracking-tight">Attachments</h3>
                      <button className="bg-slate-100 hover:bg-slate-200 text-slate-600 px-5 py-2 rounded-xl font-bold text-xs flex items-center gap-2 transition-all">
                        <span className="material-symbols-outlined text-sm">upload</span> Upload Files
                      </button>
                    </div>
                    {(selectedTicket.attachments || []).length > 0 ? (
                      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                        {(selectedTicket.attachments || []).map(att => (
                          <div key={att.id} className="aspect-square bg-slate-50 rounded-2xl border border-slate-100 flex flex-col items-center justify-center text-slate-400 p-3">
                            <span className="material-symbols-outlined text-2xl mb-1">{att.type === 'image' ? 'image' : 'description'}</span>
                            <span className="text-[9px] font-bold text-center truncate w-full">{att.name}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                        <div className="aspect-square bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-400 group hover:border-primary hover:text-primary transition-all cursor-pointer">
                          <span className="material-symbols-outlined text-3xl mb-2">add_a_photo</span>
                          <span className="text-[10px] font-black uppercase tracking-widest">Add Image</span>
                        </div>
                        <div className="aspect-square bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-400 group hover:border-primary hover:text-primary transition-all cursor-pointer">
                          <span className="material-symbols-outlined text-3xl mb-2">upload_file</span>
                          <span className="text-[10px] font-black uppercase tracking-widest">Add Document</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="p-6 bg-slate-50 border-t border-slate-100 flex justify-between items-center shrink-0">
                <div className="flex items-center gap-4">
                  <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${STATUS_COLORS[selectedTicket.status]}`}>{selectedTicket.status}</span>
                  {formSaved && <span className="text-[10px] font-black text-lime-600 uppercase tracking-widest animate-pulse">Saved</span>}
                  {selectedTicket.linkedInvoiceId && (
                    <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs">receipt_long</span> Invoice Generated
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {(selectedTicket.status === 'Completed' || selectedTicket.status === 'Delivered') && selectedTicket.linkedInvoiceId && (
                    <button onClick={() => {
                      const repairItems = [
                        ...(selectedTicket.serviceLineItems || []).map(sli => ({
                          id: sli.serviceId, name: sli.name, price: sli.price, quantity: 1, type: 'service' as const,
                        })),
                        ...(selectedTicket.partsUsed || []).map(p => ({
                          id: p.itemId, name: p.name, price: p.price, quantity: p.quantity, type: 'part' as const,
                        })),
                      ];
                      setIsDetailModalOpen(false);
                      navigate('/sales', { state: {
                        autoRepairItem: repairItems[0] ? { id: repairItems[0].id, name: `Repair: ${selectedTicket.ticketNumber} — ${selectedTicket.device}`, price: ticketTotal, type: 'repair' } : undefined,
                        selectedCustomer: { id: selectedTicket.customerId, name: selectedTicket.customerName, phone: selectedTicket.customerPhone, email: selectedTicket.customerEmail },
                        linkedRepairTicketId: selectedTicket.id,
                        linkedInvoiceId: selectedTicket.linkedInvoiceId,
                      }});
                    }}
                      className="px-6 py-3 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg active:scale-95 transition-all flex items-center gap-2">
                      <span className="material-symbols-outlined text-sm">point_of_sale</span> Send to POS
                    </button>
                  )}
                  <button onClick={() => setIsDetailModalOpen(false)}
                    className="px-8 py-3 bg-white text-slate-500 border border-slate-200 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-50 transition-all">
                    Close
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ===== DELETE CONFIRMATION ===== */}
      <AnimatePresence>
        {deleteConfirm && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDeleteConfirm(null)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" />
            <motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl p-10 text-center">
              <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center mx-auto mb-5">
                <span className="material-symbols-outlined text-red-500 text-3xl">delete_forever</span>
              </div>
              <h3 className="text-xl font-black text-slate-900 mb-2">Delete Repair Ticket?</h3>
              <p className="text-sm text-slate-500 mb-8">This action cannot be undone. The ticket and all associated data will be permanently removed.</p>
              <div className="flex gap-4">
                <button onClick={() => setDeleteConfirm(null)} className="flex-1 py-4 bg-slate-100 text-slate-600 rounded-2xl font-black text-xs uppercase tracking-widest">Cancel</button>
                <button onClick={() => handleDeleteTicket(deleteConfirm)} className="flex-1 py-4 bg-red-500 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg">Delete</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ===== NEW TICKET MODAL ===== */}
      <AnimatePresence>
        {isNewTicketModalOpen && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsNewTicketModalOpen(false)} className="absolute inset-0 bg-teal-950/60 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.95, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative w-full max-w-3xl bg-white rounded-[3rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
              <div className="signature-gradient p-7 text-white shrink-0">
                <h2 className="text-2xl font-black tracking-tight">Create Repair Ticket</h2>
                <p className="text-teal-100/70 text-sm font-bold uppercase tracking-widest mt-1">Device Intake Flow</p>
              </div>
              <div className="p-8 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Customer</label>
                  <div className="relative">
                    <input type="text" value={customerSearch} onChange={e => { setCustomerSearch(e.target.value); setShowCustomerDropdown(true); setNewForm(prev => ({ ...prev, customerName: e.target.value, customerId: '', customerPhone: '', customerEmail: '' })); }}
                      onFocus={() => setShowCustomerDropdown(true)} placeholder="Search by name, phone, or email..."
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner" />
                    {showCustomerDropdown && customerMatches.length > 0 && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-2xl shadow-2xl border border-slate-200 z-20 max-h-52 overflow-y-auto">
                        {customerMatches.map(c => (
                          <button key={c.id} onClick={() => handleSelectCustomer(c)} className="w-full text-left p-4 hover:bg-slate-50 transition-all flex justify-between items-center border-b border-slate-50 last:border-0">
                            <div><p className="font-bold text-slate-900 text-sm">{c.name}</p><p className="text-[10px] text-slate-400">{c.phone}{c.email ? ` • ${c.email}` : ''}</p></div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-5">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Device Name *</label>
                    <input type="text" value={newForm.device} onChange={e => setNewForm(prev => ({ ...prev, device: e.target.value }))} placeholder="e.g. iPhone 15 Pro Max"
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Category</label>
                    <select value={newForm.deviceCategory} onChange={e => setNewForm(prev => ({ ...prev, deviceCategory: e.target.value }))}
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner">
                      <option value="">Select category</option>
                      {DEVICE_CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-5">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Brand</label>
                    <input type="text" value={newForm.brand} onChange={e => setNewForm(prev => ({ ...prev, brand: e.target.value }))} placeholder="e.g. Apple, Samsung"
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Model</label>
                    <input type="text" value={newForm.model} onChange={e => setNewForm(prev => ({ ...prev, model: e.target.value }))} placeholder="e.g. 15 Pro Max"
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-5">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">IMEI</label>
                    <input type="text" value={newForm.imei} onChange={e => setNewForm(prev => ({ ...prev, imei: e.target.value }))} placeholder="15-digit IMEI"
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner font-mono" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Serial Number</label>
                    <input type="text" value={newForm.serialNumber} onChange={e => setNewForm(prev => ({ ...prev, serialNumber: e.target.value }))} placeholder="Device serial"
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner font-mono" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-5">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Passcode / Pattern</label>
                    <input type="text" value={newForm.passcode} onChange={e => setNewForm(prev => ({ ...prev, passcode: e.target.value }))} placeholder="Device unlock code"
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Network / Carrier</label>
                    <input type="text" value={newForm.network} onChange={e => setNewForm(prev => ({ ...prev, network: e.target.value }))} placeholder="e.g. Verizon, AT&T"
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner" />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Issue / Problem Description *</label>
                  <textarea value={newForm.issue} onChange={e => setNewForm(prev => ({ ...prev, issue: e.target.value }))} placeholder="Describe the problem..."
                    className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner h-20" />
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Intake Notes</label>
                  <textarea value={newForm.intakeNotes} onChange={e => setNewForm(prev => ({ ...prev, intakeNotes: e.target.value }))} placeholder="Additional notes from customer intake..."
                    className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner h-16" />
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Pre-Repair Conditions</label>
                  <div className="flex flex-wrap gap-2">
                    {PRE_REPAIR_CONDITIONS.map(cond => (
                      <button key={cond} onClick={() => handleToggleCondition(cond)}
                        className={`px-3 py-1.5 rounded-xl text-[10px] font-bold transition-all border ${newForm.preRepairCondition.includes(cond) ? 'bg-amber-100 text-amber-800 border-amber-200' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>
                        {cond}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Repair Services</label>
                  <div className="relative">
                    <input type="text" value={serviceSearch} onChange={e => { setServiceSearch(e.target.value); setShowServiceDropdown(true); }}
                      onFocus={() => setShowServiceDropdown(true)} placeholder="Search services..."
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner" />
                    {showServiceDropdown && serviceMatches.length > 0 && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-2xl shadow-2xl border border-slate-200 z-20 max-h-48 overflow-y-auto">
                        {serviceMatches.map(s => (
                          <button key={s.id} onClick={() => { handleToggleService(s.id); setShowServiceDropdown(false); setServiceSearch(''); }}
                            className={`w-full text-left p-3 hover:bg-slate-50 transition-all flex justify-between items-center border-b border-slate-50 last:border-0 ${newForm.selectedServiceIds.includes(s.id) ? 'bg-primary/5' : ''}`}>
                            <div className="flex items-center gap-2">
                              {newForm.selectedServiceIds.includes(s.id) && <span className="material-symbols-outlined text-primary text-sm">check_circle</span>}
                              <div><p className="text-xs font-bold text-slate-900">{s.name}</p><p className="text-[10px] text-slate-400">{s.categoryName}{s.warrantyPeriod ? ` • ${s.warrantyPeriod} warranty` : ''}</p></div>
                            </div>
                            <span className="text-xs font-black text-primary">${s.price.toFixed(2)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {selectedServices.length > 0 && (
                    <div className="space-y-2 mt-2">
                      {selectedServices.map(s => (
                        <div key={s.id} className="flex justify-between items-center bg-primary/5 p-3 rounded-xl border border-primary/10">
                          <span className="text-xs font-bold text-primary">{s.name}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-black text-primary">${s.price.toFixed(2)}</span>
                            <button onClick={() => handleToggleService(s.id)} className="text-red-400 hover:text-red-600"><span className="material-symbols-outlined text-sm">close</span></button>
                          </div>
                        </div>
                      ))}
                      <div className="flex justify-between px-3 pt-2 border-t border-slate-100">
                        <span className="text-xs font-black text-slate-400 uppercase">Estimated Total</span>
                        <span className="text-sm font-black text-primary">${estimatedTotal.toFixed(2)}</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-5">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Priority</label>
                    <select value={newForm.priority} onChange={e => setNewForm(prev => ({ ...prev, priority: e.target.value as any }))}
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner">
                      <option value="Low">Low</option><option value="Medium">Medium</option><option value="High">High</option><option value="Rush">Rush</option>
                    </select>
                  </div>
                  {canAssignTechnician && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Assign Technician</label>
                      <select value={newForm.technicianId} onChange={e => {
                        const tech = technicians.find(t => t.id === e.target.value);
                        setNewForm(prev => ({ ...prev, technicianId: e.target.value, technicianName: tech?.name || '' }));
                      }} className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner">
                        <option value="">Unassigned</option>
                        {technicians.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Storage Location</label>
                    <input type="text" value={newForm.location} onChange={e => setNewForm(prev => ({ ...prev, location: e.target.value }))} placeholder="e.g. Shelf A-1"
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold focus:ring-secondary shadow-inner" />
                  </div>
                </div>
              </div>
              <div className="p-6 border-t border-slate-100 flex gap-4 shrink-0">
                <button onClick={() => setIsNewTicketModalOpen(false)} className="flex-1 py-4 bg-slate-100 text-slate-500 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-200 transition-all">Cancel</button>
                <button onClick={handleCreateTicket} disabled={!newForm.device.trim() || !newForm.issue.trim() || !newForm.customerName.trim()}
                  className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl shadow-teal-900/20 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                  Create Ticket
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ContextualHelp
        title="Repair Workflow Guide"
        items={[
          { title: 'Ticket Lifecycle', description: 'Tickets follow: Pending → Diagnosed → In Progress → Awaiting Parts → Ready for Pickup → Completed → Delivered. Status guardrails prevent invalid transitions.', icon: 'sync' },
          { title: 'Service & Parts Linkage', description: 'Link services from your catalog and parts from inventory directly to repair tickets for accurate costing and tracking.', icon: 'build' },
          { title: 'Notes & Communication', description: 'Use internal notes for team communication and customer notes for client-facing updates. All actions are tracked in the timeline.', icon: 'forum' },
          { title: 'Technician Assignment', description: 'Assign and reassign technicians to repair tickets. All assignment changes are logged in the ticket history.', icon: 'engineering' }
        ]}
        accentColor="primary"
      />
    </div>
  );
}
