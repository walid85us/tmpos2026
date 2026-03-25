import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Employee, EmployeeTimeLog, EmployeeActivityLog, 
  EmployeeCommission, EmployeePayroll 
} from '../types';
import { useAccess } from '../context/AccessContext';
import PendingApproval from './PendingApproval';

const MOCK_EMPLOYEES: Employee[] = [
  {
    id: 'e1',
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@example.com',
    phone: '555-0101',
    roleId: 'store_owner',
    roleName: 'Store Owner',
    pin: '1234',
    avatar: 'https://i.pravatar.cc/150?img=11',
    status: 'Active',
    payRate: 50,
    payType: 'Salary',
    commissionRate: 5,
    is2FAEnabled: true,
    createdAt: '2023-01-01',
    lastLogin: '2024-03-20 09:00'
  },
  {
    id: 'e2',
    firstName: 'Sarah',
    lastName: 'Jenkins',
    email: 'sarah@example.com',
    phone: '555-0102',
    roleId: 'technician',
    roleName: 'Technician',
    pin: '2222',
    avatar: 'https://i.pravatar.cc/150?img=5',
    status: 'Active',
    payRate: 25,
    payType: 'Hourly',
    commissionRate: 10,
    is2FAEnabled: false,
    createdAt: '2023-06-15',
    lastLogin: '2024-03-20 08:30'
  }
];

const MOCK_TIME_LOGS: EmployeeTimeLog[] = [
  { id: 'tl1', employeeId: 'e1', employeeName: 'John Doe', clockIn: '2024-03-20 09:00', status: 'Clocked In' },
  { id: 'tl2', employeeId: 'e2', employeeName: 'Sarah Jenkins', clockIn: '2024-03-20 08:30', clockOut: '2024-03-20 12:30', totalHours: 4, status: 'Clocked Out' }
];

const MOCK_ACTIVITY_LOGS: EmployeeActivityLog[] = [
  { id: 'al1', employeeId: 'e1', employeeName: 'John Doe', action: 'Login', details: 'Successful login from 192.168.1.1', timestamp: '2024-03-20 09:00' },
  { id: 'al2', employeeId: 'e2', employeeName: 'Sarah Jenkins', action: 'Update Ticket', details: 'Updated status of Ticket #1001 to Completed', timestamp: '2024-03-20 10:15' }
];

const storeModuleFeatures = [
  { id: 'sales', name: 'Point of Sale' },
  { id: 'repairs', name: 'Repairs & Tickets' },
  { id: 'inventory', name: 'Inventory Management' },
  { id: 'customers', name: 'Customer Directory' },
  { id: 'employees', name: 'Employee Management' },
  { id: 'invoices', name: 'Invoices & Billing' },
  { id: 'services', name: 'Services Catalog' },
  { id: 'reports', name: 'Reporting & Analytics' },
  { id: 'prospects', name: 'Prospects & Leads' },
  { id: 'marketing', name: 'Marketing Tools' },
  { id: 'integrations', name: 'Integrations' },
  { id: 'widgets', name: 'Widgets' },
  { id: 'settings', name: 'Store Settings' },
  { id: 'support', name: 'Support Center' },
];

const storeAdminFeatures = [
  { id: 'manage_employees', name: 'Manage Employees' },
  { id: 'create_roles', name: 'Create Roles' },
  { id: 'edit_roles', name: 'Edit Roles' },
  { id: 'manage_role_permissions', name: 'Manage Role Permissions' },
  { id: 'assign_roles', name: 'Assign Roles' },
  { id: 'assign_same_role', name: 'Assign Same-Level Role' },
  { id: 'assign_manager_role', name: 'Assign Manager Role' },
  { id: 'manage_attendance', name: 'Manage Attendance' },
  { id: 'manage_compensation', name: 'Manage Compensation' },
  { id: 'approve_requests', name: 'Approve Requests' },
];

const storeFeatures = [...storeModuleFeatures, ...storeAdminFeatures];

export default function Employees() {
  const { session, tenantRolesState = [], addTenantRole, updateTenantRole, canAccess } = useAccess();
  const [activeTab, setActiveTab] = useState<'list' | 'time' | 'roles' | 'permissions' | 'activity' | 'payroll'>('list');
  const [employees, setEmployees] = useState<Employee[]>(MOCK_EMPLOYEES);
  const [timeLogs, setTimeLogs] = useState<EmployeeTimeLog[]>(MOCK_TIME_LOGS);
  const [activityLogs, setActivityLogs] = useState<EmployeeActivityLog[]>(MOCK_ACTIVITY_LOGS);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showPayrollWizard, setShowPayrollWizard] = useState(false);
  const [showCreateRoleModal, setShowCreateRoleModal] = useState(false);
  const [showTimeEditModal, setShowTimeEditModal] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [editingTimeLog, setEditingTimeLog] = useState<EmployeeTimeLog | null>(null);
  const [pendingRequests, setPendingRequests] = useState<any[]>([
    {
      id: Date.now() - 100000,
      employee: 'Sarah Jenkins',
      action: 'Create New Manager',
      type: 'add_employee',
      status: 'pending',
      details: {
        firstName: 'Mike',
        lastName: 'Rodriguez',
        email: 'mike@example.com',
        roleId: 'manager',
        status: 'Active',
        payRate: 30,
        payType: 'Hourly',
        commissionEnabled: true,
        commissionType: 'percentage',
        commissionRate: 8
      }
    }
  ]);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [selectedTimeEmployee, setSelectedTimeEmployee] = useState<string>('');
  const [showClockInPicker, setShowClockInPicker] = useState(false);
  const [showClockOutPicker, setShowClockOutPicker] = useState(false);

  const [newRole, setNewRole] = useState({ name: '', description: '', status: 'active' as string, permissions: [] as string[] });

  const isOwnerOrManager = session?.role === 'store_owner' || session?.role === 'system_owner' || session?.role === 'manager';
  const isManager = session?.role === 'manager';
  const isOwner = session?.role === 'store_owner' || session?.role === 'system_owner';

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const logActivity = (employeeId: string, employeeName: string, action: string, details: string) => {
    setActivityLogs(prev => [{
      id: `al${Date.now()}`,
      employeeId,
      employeeName,
      action,
      details,
      timestamp: new Date().toLocaleString()
    }, ...prev]);
  };

  const handleApprove = (id: number) => {
    const request = pendingRequests.find(req => req.id === id);
    if (!request) return;

    if (request.type === 'create_role') {
      addTenantRole({ 
        id: request.details.name.toLowerCase().replace(/\s+/g, '_'), 
        name: request.details.name, 
        permissions: request.details.permissions || [], 
        description: request.details.description || 'Custom role' 
      });
    } else if (request.type === 'add_employee') {
      const newEmployee: Employee = {
        id: `emp-${Date.now()}`,
        firstName: request.details.firstName,
        lastName: request.details.lastName,
        email: request.details.email,
        roleId: request.details.roleId,
        roleName: request.details.roleId,
        pin: '0000',
        payRate: request.details.payRate || 0,
        payType: request.details.payType || 'Hourly',
        status: request.details.status || 'Active',
        commissionEnabled: request.details.commissionEnabled,
        commissionType: request.details.commissionType,
        commissionRate: request.details.commissionRate,
        createdAt: new Date().toISOString()
      };
      setEmployees(prev => [...prev, newEmployee]);
    } else if (request.type === 'update_employee') {
      setEmployees(prev => prev.map(emp => emp.id === request.details.id ? {
        ...emp,
        firstName: request.details.firstName,
        lastName: request.details.lastName,
        email: request.details.email,
        roleId: request.details.roleId,
        roleName: request.details.roleId,
        status: request.details.status,
        payRate: request.details.payRate,
        payType: request.details.payType,
        commissionEnabled: request.details.commissionEnabled,
        commissionType: request.details.commissionType,
        commissionRate: request.details.commissionRate
      } : emp));
    }

    setPendingRequests(prev => prev.filter(req => req.id !== id));
    showToast('Request approved and applied.');
  };

  const handleReject = (id: number) => {
    setPendingRequests(prev => prev.filter(req => req.id !== id));
    showToast('Request rejected.', 'error');
  };

  const handleReturn = (id: number, comment: string) => {
    setPendingRequests(prev => prev.map(req => 
      req.id === id ? { ...req, status: 'returned', comment } : req
    ));
    showToast('Request returned for changes.', 'info');
  };

  const handleResubmit = (id: number, updatedDetails: any) => {
    setPendingRequests(prev => prev.map(req => 
      req.id === id ? { ...req, status: 'pending', details: updatedDetails, comment: undefined } : req
    ));
    showToast('Request resubmitted for approval.', 'info');
  };

  const filteredEmployees = employees.filter(e => 
    `${e.firstName} ${e.lastName}`.toLowerCase().includes(searchQuery.toLowerCase()) ||
    e.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleAddEmployee = (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    const roleId = formData.get('role') as string;
    const firstName = formData.get('firstName') as string;
    const lastName = formData.get('lastName') as string;
    const email = formData.get('email') as string;
    const status = formData.get('status') as Employee['status'];
    const payRate = Number(formData.get('payRate')) || 0;
    const payType = formData.get('payType') as 'Hourly' | 'Salary';
    const commissionEnabled = formData.get('commissionEnabled') === 'on';
    const commissionType = formData.get('commissionType') as 'flat' | 'percentage';
    const commissionRate = Number(formData.get('commissionRate')) || 0;

    const needsApproval = roleId === 'store_owner' || 
      (roleId === 'manager' && !canAccess('assign_manager_role')) ||
      (!canAccess('assign_roles'));

    if (needsApproval && session?.role !== 'store_owner' && session?.role !== 'system_owner') {
      setPendingRequests(prev => [...prev, { 
        id: Date.now(), 
        employee: `${firstName} ${lastName}`, 
        action: editingEmployee ? `Update ${roleId}` : `Create New ${roleId}`,
        type: editingEmployee ? 'update_employee' : 'add_employee',
        status: 'pending',
        details: { id: editingEmployee?.id, firstName, lastName, email, roleId, status, payRate, payType, commissionEnabled, commissionType, commissionRate }
      }]);
      showToast('Request submitted for approval.', 'info');
    } else {
      if (editingEmployee) {
        setEmployees(prev => prev.map(emp => emp.id === editingEmployee.id ? {
          ...emp,
          firstName,
          lastName,
          email,
          roleId,
          roleName: roleId,
          status,
          payRate,
          payType,
          commissionEnabled,
          commissionType,
          commissionRate
        } : emp));
        logActivity(editingEmployee.id, `${firstName} ${lastName}`, 'Profile Updated', `Updated employee profile`);
        showToast('Employee updated successfully.');
      } else {
        const newEmployee: Employee = {
          id: `emp-${Date.now()}`,
          firstName,
          lastName,
          email,
          roleId,
          roleName: roleId,
          pin: '0000',
          payRate,
          payType,
          status: status || 'Active',
          commissionEnabled,
          commissionType,
          commissionRate,
          createdAt: new Date().toISOString()
        };
        setEmployees(prev => [...prev, newEmployee]);
        logActivity(newEmployee.id, `${firstName} ${lastName}`, 'Employee Added', `New employee added with role ${roleId}`);
        showToast('Employee added successfully.');
      }
    }
    setShowAddModal(false);
    setEditingEmployee(null);
  };

  const handleCreateRole = () => {
    if (!newRole.name.trim()) return;
    const roleId = newRole.name.toLowerCase().replace(/\s+/g, '_');

    if (!canAccess('create_roles') && session?.role !== 'store_owner' && session?.role !== 'system_owner') {
      setPendingRequests(prev => [...prev, { 
        id: Date.now(), 
        employee: 'System', 
        action: `Create Role: ${newRole.name}`,
        type: 'create_role',
        status: 'pending',
        details: { name: newRole.name, description: newRole.description, permissions: newRole.permissions }
      }]);
      showToast('Role creation request submitted for approval.', 'info');
    } else {
      addTenantRole({ id: roleId, name: newRole.name, permissions: newRole.permissions, description: newRole.description || 'Custom role' });
      logActivity('system', session?.user?.name || 'Store Owner', 'Created Role', `Created new store role: ${newRole.name}`);
      showToast(`Role "${newRole.name}" created successfully.`);
    }
    setNewRole({ name: '', description: '', status: 'active', permissions: [] });
    setShowCreateRoleModal(false);
  };

  const togglePermission = (permId: string) => {
    setNewRole(prev => ({
      ...prev,
      permissions: prev.permissions.includes(permId)
        ? prev.permissions.filter(p => p !== permId)
        : [...prev.permissions, permId]
    }));
  };

  const clockInEmployee = (emp: Employee) => {
    const existingLog = timeLogs.find(tl => tl.employeeId === emp.id && (tl.status === 'Clocked In' || tl.status === 'On Break'));
    if (existingLog) {
      showToast(`${emp.firstName} already has an active session.`, 'info');
      return;
    }
    const newLog: EmployeeTimeLog = {
      id: `tl${Date.now()}`,
      employeeId: emp.id,
      employeeName: `${emp.firstName} ${emp.lastName}`,
      clockIn: new Date().toLocaleString(),
      status: 'Clocked In'
    };
    setTimeLogs(prev => [newLog, ...prev]);
    logActivity(emp.id, `${emp.firstName} ${emp.lastName}`, 'Clock In', `Clocked in at ${newLog.clockIn}`);
    showToast(`${emp.firstName} ${emp.lastName} clocked in.`);
  };

  const clockOutEmployee = (emp: Employee) => {
    const activeLog = timeLogs.find(tl => tl.employeeId === emp.id && (tl.status === 'Clocked In' || tl.status === 'On Break'));
    if (!activeLog) {
      showToast(`${emp.firstName} is not currently clocked in.`, 'error');
      return;
    }
    const clockOutTime = new Date();
    const clockInTime = new Date(activeLog.clockIn);
    const diffMs = clockOutTime.getTime() - clockInTime.getTime();
    const totalHours = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;

    setTimeLogs(prev => prev.map(tl =>
      tl.id === activeLog.id
        ? { ...tl, clockOut: clockOutTime.toLocaleString(), totalHours: totalHours > 0 ? totalHours : 0.01, status: 'Clocked Out' as const }
        : tl
    ));
    logActivity(emp.id, `${emp.firstName} ${emp.lastName}`, 'Clock Out', `Clocked out. Total hours: ${totalHours > 0 ? totalHours : '< 0.01'}`);
    showToast(`${emp.firstName} ${emp.lastName} clocked out. Hours: ${totalHours > 0 ? totalHours : '< 0.01'}`);
  };

  const startBreakEmployee = (emp: Employee) => {
    const activeLog = timeLogs.find(tl => tl.employeeId === emp.id && tl.status === 'Clocked In');
    if (!activeLog) {
      showToast(`${emp.firstName} is not currently clocked in.`, 'error');
      return;
    }
    setTimeLogs(prev => prev.map(tl =>
      tl.id === activeLog.id
        ? { ...tl, status: 'On Break' as const, breakStart: new Date().toLocaleString() }
        : tl
    ));
    logActivity(emp.id, `${emp.firstName} ${emp.lastName}`, 'Start Break', `Started break at ${new Date().toLocaleString()}. Actor: ${session?.user?.name || 'System'}`);
    showToast(`${emp.firstName} ${emp.lastName} is now on break.`);
  };

  const endBreakEmployee = (emp: Employee) => {
    const breakLog = timeLogs.find(tl => tl.employeeId === emp.id && tl.status === 'On Break');
    if (!breakLog) {
      showToast(`${emp.firstName} is not currently on break.`, 'error');
      return;
    }
    const breakEnd = new Date();
    const breakStart = new Date(breakLog.breakStart || breakLog.clockIn);
    const breakMinutes = Math.round((breakEnd.getTime() - breakStart.getTime()) / (1000 * 60));
    const totalBreakMinutes = (breakLog.totalBreakMinutes || 0) + breakMinutes;

    setTimeLogs(prev => prev.map(tl =>
      tl.id === breakLog.id
        ? { ...tl, status: 'Clocked In' as const, breakEnd: breakEnd.toLocaleString(), totalBreakMinutes }
        : tl
    ));
    logActivity(emp.id, `${emp.firstName} ${emp.lastName}`, 'End Break', `Returned from break (${breakMinutes} min). Actor: ${session?.user?.name || 'System'}`);
    showToast(`${emp.firstName} ${emp.lastName} is back from break. (${breakMinutes} min)`);
  };

  const [showBreakPicker, setShowBreakPicker] = useState(false);
  const [showEndBreakPicker, setShowEndBreakPicker] = useState(false);

  const canManageAttendance = isOwner || canAccess('manage_attendance');

  const handleStartBreak = () => {
    if (canManageAttendance) {
      setShowBreakPicker(true);
      return;
    }
    const currentUser = employees.find(e => e.id === 'e1') || employees[0];
    if (!currentUser) return;
    startBreakEmployee(currentUser);
  };

  const handleEndBreak = () => {
    if (canManageAttendance) {
      setShowEndBreakPicker(true);
      return;
    }
    const currentUser = employees.find(e => e.id === 'e1') || employees[0];
    if (!currentUser) return;
    endBreakEmployee(currentUser);
  };

  const handleClockIn = () => {
    if (canManageAttendance) {
      setShowClockInPicker(true);
      return;
    }
    const currentUser = employees.find(e => e.id === 'e1') || employees[0];
    if (!currentUser) return;
    clockInEmployee(currentUser);
  };

  const handleClockOut = () => {
    if (canManageAttendance) {
      setShowClockOutPicker(true);
      return;
    }
    const currentUser = employees.find(e => e.id === 'e1') || employees[0];
    if (!currentUser) return;
    clockOutEmployee(currentUser);
  };

  const handleEditTimeLog = (log: EmployeeTimeLog) => {
    setEditingTimeLog({ ...log });
    setShowTimeEditModal(true);
  };

  const handleSaveTimeLog = () => {
    if (!editingTimeLog) return;
    let totalHours = editingTimeLog.totalHours;
    if (editingTimeLog.clockIn && editingTimeLog.clockOut) {
      const inTime = new Date(editingTimeLog.clockIn);
      const outTime = new Date(editingTimeLog.clockOut);
      if (!isNaN(inTime.getTime()) && !isNaN(outTime.getTime())) {
        totalHours = Math.round(((outTime.getTime() - inTime.getTime()) / (1000 * 60 * 60)) * 100) / 100;
      }
    }
    setTimeLogs(prev => prev.map(tl => 
      tl.id === editingTimeLog.id 
        ? { ...editingTimeLog, totalHours }
        : tl
    ));
    logActivity(editingTimeLog.employeeId, editingTimeLog.employeeName, 'Time Log Edited', `Time log updated for ${editingTimeLog.employeeName}`);
    showToast('Time log updated successfully.');
    setShowTimeEditModal(false);
    setEditingTimeLog(null);
  };

  const renderEmployeeList = () => (
    <div className="space-y-6">
      {(isOwner || canAccess('approve_requests')) && (
        <PendingApproval 
          requests={pendingRequests} 
          onApprove={handleApprove} 
          onReject={handleReject}
          onReturn={handleReturn}
          onResubmit={handleResubmit}
        />
      )}
      <div className="flex justify-between items-center">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">search</span>
          <input 
            type="text" 
            placeholder="Search employees..."
            className="pl-11 pr-6 py-3 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm font-bold text-slate-900 w-64 shadow-sm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        {(isOwner || canAccess('manage_employees')) && (
          <button 
            onClick={() => setShowAddModal(true)}
            className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-sm">person_add</span>
            Add Employee
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredEmployees.map((emp) => {
          const isStoreOwner = emp.roleId === 'store_owner';
          const canManage = session?.role === 'system_owner' || session?.role === 'store_owner' || (canAccess('manage_employees') && !isStoreOwner && emp.roleId !== 'manager');

          return (
            <motion.div 
              key={emp.id}
              whileHover={{ y: -4 }}
              className={`bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm transition-all group relative overflow-hidden ${!canManage ? 'opacity-75' : 'hover:shadow-md'}`}
            >
              <div className="absolute top-0 right-0 p-6">
                <span className={`px-3 py-1 text-[8px] font-black uppercase tracking-widest rounded-lg border ${
                  emp.status === 'Active' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' : 'bg-slate-500/10 text-slate-600 border-slate-500/20'
                }`}>
                  {emp.status}
                </span>
              </div>

              <div className="flex flex-col items-center text-center">
                <div className="relative mb-6">
                  <img src={emp.avatar} alt={emp.firstName} className="w-24 h-24 rounded-3xl object-cover border-4 border-white shadow-xl" />
                  {emp.is2FAEnabled && (
                    <div className="absolute -bottom-2 -right-2 w-8 h-8 bg-emerald-500 text-white rounded-full flex items-center justify-center border-4 border-white shadow-lg" title="2FA Enabled">
                      <span className="material-symbols-outlined text-xs">verified_user</span>
                    </div>
                  )}
                </div>
                
                <h3 className="text-xl font-black text-primary mb-1">{emp.firstName} {emp.lastName}</h3>
                <p className={`text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] ${isStoreOwner ? 'mb-1' : 'mb-4'}`}>{emp.roleName}</p>
                {isStoreOwner && (
                  <div className="flex items-center gap-1 mb-3">
                    <span className="material-symbols-outlined text-[10px] text-amber-500">lock</span>
                    <span className="text-[9px] font-black text-amber-600 uppercase tracking-widest">Platform Protected Role</span>
                  </div>
                )}
                
                {(isManager && isStoreOwner) ? (
                  <div className="w-full mb-6 bg-slate-50 p-3 rounded-2xl border border-slate-100 flex items-center justify-center gap-2">
                    <span className="material-symbols-outlined text-slate-400 text-sm">lock</span>
                    <p className="text-[10px] font-bold text-slate-400">Pay details restricted</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4 w-full mb-6">
                    <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                      <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Pay Rate</p>
                      <p className="text-sm font-black text-primary">${emp.payRate}/{emp.payType === 'Hourly' ? 'hr' : 'mo'}</p>
                    </div>
                    <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                      <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Commission</p>
                      <p className="text-sm font-black text-primary">{emp.commissionRate}%</p>
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 w-full">
                  {canManage ? (
                    <>
                      <button 
                        onClick={() => {
                          setEditingEmployee(emp);
                          setShowAddModal(true);
                        }}
                        className="flex-1 py-3 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-200 transition-colors"
                      >
                        Edit Profile
                      </button>
                      <button className="p-3 bg-slate-100 text-slate-600 rounded-xl hover:bg-slate-200 transition-colors">
                        <span className="material-symbols-outlined text-sm">history</span>
                      </button>
                    </>
                  ) : (
                    <div className="flex-1 py-3 bg-slate-50 text-slate-400 text-[10px] font-black uppercase tracking-widest rounded-xl flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined text-sm">lock</span>
                      Locked
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );

  const renderTimeLogs = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Time Tracking</h2>
        <div className="flex gap-3">
          <button 
            onClick={handleClockIn}
            className="px-5 py-3 bg-emerald-500 text-white font-black text-xs rounded-2xl shadow-lg shadow-emerald-500/20 uppercase tracking-widest flex items-center gap-2 hover:bg-emerald-600 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">login</span>
            Clock In
          </button>
          <button 
            onClick={handleStartBreak}
            className="px-5 py-3 bg-amber-500 text-white font-black text-xs rounded-2xl shadow-lg shadow-amber-500/20 uppercase tracking-widest flex items-center gap-2 hover:bg-amber-600 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">free_breakfast</span>
            Start Break
          </button>
          <button 
            onClick={handleEndBreak}
            className="px-5 py-3 bg-blue-500 text-white font-black text-xs rounded-2xl shadow-lg shadow-blue-500/20 uppercase tracking-widest flex items-center gap-2 hover:bg-blue-600 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">arrow_back</span>
            Back from Break
          </button>
          <button 
            onClick={handleClockOut}
            className="px-5 py-3 bg-rose-500 text-white font-black text-xs rounded-2xl shadow-lg shadow-rose-500/20 uppercase tracking-widest flex items-center gap-2 hover:bg-rose-600 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">logout</span>
            Clock Out
          </button>
        </div>
      </div>

      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Employee</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Clock In</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Clock Out</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Total Hours</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {timeLogs.map((log) => (
              <tr key={log.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                <td className="px-8 py-6">
                  <p className="text-sm font-black text-primary">{log.employeeName}</p>
                </td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{log.clockIn}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-600">{log.clockOut || '--'}</td>
                <td className="px-8 py-6 text-center text-sm font-black text-slate-900">{log.totalHours || '--'}</td>
                <td className="px-8 py-6">
                  <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${
                    log.status === 'Clocked In' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' : 
                    log.status === 'On Break' ? 'bg-amber-500/10 text-amber-600 border-amber-500/20' :
                    'bg-slate-500/10 text-slate-600 border-slate-500/20'
                  }`}>
                    {log.status}
                  </span>
                  {log.totalBreakMinutes ? (
                    <span className="ml-2 text-[9px] font-bold text-amber-500">{log.totalBreakMinutes}m break</span>
                  ) : null}
                </td>
                <td className="px-8 py-6 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {canManageAttendance && log.status === 'Clocked Out' && (
                      <button 
                        onClick={() => {
                          const emp = employees.find(e => e.id === log.employeeId);
                          if (emp) {
                            if (isManager && emp.roleId === 'store_owner') {
                              showToast('Managers cannot clock in the Store Owner.', 'error');
                              return;
                            }
                            const alreadyActive = timeLogs.some(tl => tl.employeeId === emp.id && (tl.status === 'Clocked In' || tl.status === 'On Break'));
                            if (alreadyActive) {
                              showToast(`${emp.firstName} already has an active session.`, 'error');
                              return;
                            }
                            clockInEmployee(emp);
                          }
                        }}
                        className="p-2 hover:bg-emerald-50 text-emerald-400 hover:text-emerald-600 rounded-xl transition-colors"
                        title="Clock In"
                      >
                        <span className="material-symbols-outlined text-sm">login</span>
                      </button>
                    )}
                    {canManageAttendance && log.status === 'Clocked In' && (
                      <button 
                        onClick={() => {
                          const emp = employees.find(e => e.id === log.employeeId);
                          if (emp) {
                            if (isManager && emp.roleId === 'store_owner') {
                              showToast('Managers cannot manage Store Owner attendance.', 'error');
                              return;
                            }
                            startBreakEmployee(emp);
                          }
                        }}
                        className="p-2 hover:bg-amber-50 text-amber-400 hover:text-amber-600 rounded-xl transition-colors"
                        title="Start Break"
                      >
                        <span className="material-symbols-outlined text-sm">free_breakfast</span>
                      </button>
                    )}
                    {canManageAttendance && log.status === 'Clocked In' && (
                      <button 
                        onClick={() => {
                          const emp = employees.find(e => e.id === log.employeeId);
                          if (emp) {
                            if (isManager && emp.roleId === 'store_owner') {
                              showToast('Managers cannot clock out the Store Owner.', 'error');
                              return;
                            }
                            clockOutEmployee(emp);
                          }
                        }}
                        className="p-2 hover:bg-rose-50 text-rose-400 hover:text-rose-600 rounded-xl transition-colors"
                        title="Clock Out"
                      >
                        <span className="material-symbols-outlined text-sm">logout</span>
                      </button>
                    )}
                    {canManageAttendance && log.status === 'On Break' && (
                      <button 
                        onClick={() => {
                          const emp = employees.find(e => e.id === log.employeeId);
                          if (emp) {
                            if (isManager && emp.roleId === 'store_owner') {
                              showToast('Managers cannot manage Store Owner attendance.', 'error');
                              return;
                            }
                            endBreakEmployee(emp);
                          }
                        }}
                        className="p-2 hover:bg-blue-50 text-blue-400 hover:text-blue-600 rounded-xl transition-colors"
                        title="Back from Break"
                      >
                        <span className="material-symbols-outlined text-sm">arrow_back</span>
                      </button>
                    )}
                    <button 
                      onClick={() => handleEditTimeLog(log)}
                      className="p-2 hover:bg-slate-100 text-slate-400 rounded-xl transition-colors"
                      title="Edit"
                    >
                      <span className="material-symbols-outlined text-sm">edit</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const getPermissionLevel = (role: any, featureId: string): string => {
    if (Array.isArray(role.permissions)) {
      if (role.permissions.includes('all')) return 'full';
      if (role.permissions.includes(featureId)) return 'full';
      if (role.permissions.includes(`${featureId}_read`)) return 'view';
      return 'none';
    }
    if (role.permissions?.['all'] === 'full') return 'full';
    return role.permissions?.[featureId] || 'none';
  };

  const renderPermissionRow = (feature: { id: string; name: string }, isAdminPerm: boolean) => (
    <tr key={feature.id} className="border-b border-slate-50">
      <td className="px-4 py-4 text-sm font-bold text-slate-700">{feature.name}</td>
      {tenantRolesState.map(role => {
        const currentLevel = getPermissionLevel(role, feature.id);
        const isLocked = role.id === 'store_owner' || (session?.role === 'manager' && (role.id === 'manager' || !canAccess('edit_roles')));
        return (
          <td key={role.id} className="px-4 py-4 text-center">
            {isAdminPerm ? (
              <select
                disabled={isLocked}
                value={currentLevel === 'none' ? 'off' : 'on'}
                onChange={(e) => {
                  if (isLocked) return;
                  const newVal = e.target.value === 'on' ? 'full' : 'none';
                  const newPermissions = Array.isArray(role.permissions) 
                    ? (newVal === 'full' 
                        ? [...role.permissions.filter(p => p !== feature.id), feature.id]
                        : role.permissions.filter(p => p !== feature.id))
                    : { ...role.permissions, [feature.id]: newVal };
                  updateTenantRole(role.id, newPermissions as any);
                }}
                className="text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:ring-2 focus:ring-primary/20 focus:outline-none disabled:opacity-50"
              >
                <option value="off">Denied</option>
                <option value="on">Granted</option>
              </select>
            ) : (
              <select
                disabled={isLocked}
                value={currentLevel}
                onChange={(e) => {
                  if (isLocked) return;
                  const newLevel = e.target.value;
                  const newPermissions = Array.isArray(role.permissions) 
                    ? { ...role.permissions.reduce((acc: any, p: string) => ({ ...acc, [p]: 'full' }), {}), [feature.id]: newLevel }
                    : { ...role.permissions, [feature.id]: newLevel };
                  updateTenantRole(role.id, newPermissions as any);
                }}
                className="text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:ring-2 focus:ring-primary/20 focus:outline-none disabled:opacity-50"
              >
                <option value="none">None</option>
                <option value="view">View Only</option>
                <option value="create">Create</option>
                <option value="edit">Edit</option>
                <option value="approve">Approve</option>
                <option value="manage">Manage</option>
                <option value="full">Full Access</option>
              </select>
            )}
          </td>
        );
      })}
    </tr>
  );

  const renderPermissions = () => (
    <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 p-8 shadow-sm mt-8">
      <h2 className="text-2xl font-black text-primary tracking-tight mb-6">Store Permissions Matrix</h2>
      <p className="text-slate-500 text-sm font-medium mb-8">Configure which roles have access to specific store features and administrative actions.</p>
      
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="px-4 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Feature</th>
              {tenantRolesState.map(role => (
                <th key={role.id} className="px-4 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">{role.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="bg-slate-50/80">
              <td colSpan={tenantRolesState.length + 1} className="px-4 py-3 text-[10px] font-black text-primary uppercase tracking-widest">Module Access</td>
            </tr>
            {storeModuleFeatures.map(feature => renderPermissionRow(feature, false))}
            <tr className="bg-slate-50/80">
              <td colSpan={tenantRolesState.length + 1} className="px-4 py-3 text-[10px] font-black text-primary uppercase tracking-widest">Administrative Permissions</td>
            </tr>
            {storeAdminFeatures.map(feature => renderPermissionRow(feature, true))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderRoles = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-black text-primary tracking-tight">Roles & Permissions</h2>
        {(isOwner || canAccess('create_roles')) && (
          <button 
            onClick={() => {
              setNewRole({ name: '', description: '', status: 'active', permissions: [] });
              setShowCreateRoleModal(true);
            }}
            className="px-6 py-3 bg-primary text-white font-black text-xs rounded-2xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 uppercase tracking-widest flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            Create Role
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {tenantRolesState.map(role => {
          const isStoreOwnerRole = role.id === 'store_owner';
          const isLocked = isStoreOwnerRole;

          return (
            <div key={role.id} className={`bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border shadow-sm transition-all group ${isLocked ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200 hover:shadow-md'}`}>
              <div className="flex justify-between items-start mb-6">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${isLocked ? 'bg-amber-100' : 'bg-primary/5'}`}>
                  <span className={`material-symbols-outlined text-2xl ${isLocked ? 'text-amber-600' : 'text-primary'}`}>security</span>
                </div>
                {isLocked && (
                  <span className="flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-700 text-[8px] font-black uppercase tracking-widest rounded-lg border border-amber-200">
                    <span className="material-symbols-outlined text-xs">lock</span>
                    System Protected
                  </span>
                )}
              </div>
              <h3 className="text-xl font-black text-primary mb-2">{role.name}</h3>
              <p className="text-xs font-medium text-slate-500 mb-2">{role.description}</p>
              {isLocked && (
                <p className="text-[10px] font-bold text-amber-600 mb-4">This role cannot be edited or deleted. It has full system access.</p>
              )}
              <div className="flex flex-wrap gap-2 mb-8">
                {Array.isArray(role.permissions) 
                  ? role.permissions.map(p => (
                      <span key={p} className="px-2 py-1 bg-slate-100 text-slate-500 text-[8px] font-black uppercase tracking-widest rounded-md">
                        {p}
                      </span>
                    ))
                  : Object.entries(role.permissions).map(([k, v]) => (
                      v !== 'none' && (
                        <span key={k} className="px-2 py-1 bg-slate-100 text-slate-500 text-[8px] font-black uppercase tracking-widest rounded-md">
                          {k}: {v}
                        </span>
                      )
                    ))}
              </div>
              {(isOwner || canAccess('manage_role_permissions')) && !isLocked && (
                <button 
                  onClick={() => setActiveTab('permissions')}
                  className="w-full py-3 bg-slate-50 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-100 transition-colors"
                >
                  Manage Permissions
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderActivityLog = () => (
    <div className="space-y-6">
      <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Employee</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Details</th>
              <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {activityLogs.map((log) => (
              <tr key={log.id} className="hover:bg-slate-50/50 transition-colors border-b border-slate-50 last:border-0">
                <td className="px-8 py-6">
                  <p className="text-sm font-black text-primary">{log.employeeName}</p>
                </td>
                <td className="px-8 py-6">
                  <span className="px-3 py-1 bg-primary/5 text-primary text-[10px] font-black uppercase tracking-widest rounded-lg border border-primary/10">
                    {log.action}
                  </span>
                </td>
                <td className="px-8 py-6 text-sm font-medium text-slate-600">{log.details}</td>
                <td className="px-8 py-6 text-sm font-bold text-slate-400">{log.timestamp}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Workforce Management</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Manage Employees</h2>
        </div>
        <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 shadow-sm">
          {[
            { id: 'list', label: 'Employees', icon: 'group' },
            { id: 'time', label: 'Time Tracking', icon: 'schedule' },
            { id: 'roles', label: 'Roles', icon: 'security' },
            ...((isOwner || canAccess('manage_role_permissions')) ? [{ id: 'permissions', label: 'Permissions', icon: 'key' }] : []),
            { id: 'activity', label: 'Activity Log', icon: 'history' },
            { id: 'payroll', label: 'Payroll', icon: 'payments' }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                activeTab === tab.id 
                  ? 'bg-primary text-white shadow-lg shadow-primary/20' 
                  : 'text-slate-400 hover:text-primary hover:bg-slate-50'
              }`}
            >
              <span className="material-symbols-outlined text-sm">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === 'list' && renderEmployeeList()}
          {activeTab === 'time' && renderTimeLogs()}
          {activeTab === 'roles' && renderRoles()}
          {activeTab === 'permissions' && (isOwner || canAccess('manage_role_permissions')) && renderPermissions()}
          {activeTab === 'activity' && renderActivityLog()}
          {activeTab === 'payroll' && (
            <div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border border-slate-200 flex flex-col items-center justify-center text-center">
              <div className="w-20 h-20 bg-primary/5 rounded-full flex items-center justify-center mb-6">
                <span className="material-symbols-outlined text-4xl text-primary">payments</span>
              </div>
              <h3 className="text-2xl font-black text-primary tracking-tight mb-2">Payroll & Commissions</h3>
              <p className="text-sm font-bold text-slate-400 max-w-md mb-8">
                Manage employee pay rates, calculate commissions, and process payroll payments.
              </p>
              <button 
                onClick={() => setShowPayrollWizard(true)}
                className="px-12 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-xl shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all"
              >
                Run Payroll Wizard
              </button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      <AnimatePresence>
        {showAddModal && (
          <div key="add-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
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
              className="relative w-full max-w-2xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">{editingEmployee ? 'Edit Employee' : 'Add New Employee'}</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Set up profile and permissions</p>
                </div>
                <button onClick={() => { setShowAddModal(false); setEditingEmployee(null); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              
              <form onSubmit={handleAddEmployee} className="p-8 space-y-6 max-h-[70vh] overflow-y-auto">
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">First Name</label>
                    <input name="firstName" defaultValue={editingEmployee?.firstName} required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="John" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Last Name</label>
                    <input name="lastName" defaultValue={editingEmployee?.lastName} required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="Doe" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Email Address</label>
                    <input name="email" type="email" defaultValue={editingEmployee?.email} required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="john@example.com" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Role</label>
                    {editingEmployee?.roleId === 'store_owner' ? (
                      <div className="w-full px-6 py-4 bg-amber-50 rounded-2xl border border-amber-200 font-bold text-amber-800 flex items-center gap-2">
                        <span className="material-symbols-outlined text-sm text-amber-600">lock</span>
                        Store Owner
                        <span className="text-[9px] font-black text-amber-600 uppercase tracking-widest ml-auto">Platform Protected</span>
                        <input type="hidden" name="role" value="store_owner" />
                      </div>
                    ) : (
                      <select name="role" defaultValue={editingEmployee?.roleId} required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                        {tenantRolesState.filter(r => {
                          if (r.id === 'store_owner') return false;
                          if (r.id === 'manager' && !canAccess('assign_manager_role') && !isOwner) return false;
                          return true;
                        }).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Status</label>
                    {editingEmployee?.roleId === 'store_owner' ? (
                      <div className="w-full px-6 py-4 bg-amber-50 rounded-2xl border border-amber-200 font-bold text-amber-800 flex items-center gap-2">
                        <span className="material-symbols-outlined text-sm text-amber-600">lock</span>
                        {editingEmployee.status}
                        <span className="text-[9px] font-black text-amber-600 uppercase tracking-widest ml-auto">Protected</span>
                        <input type="hidden" name="status" value={editingEmployee.status} />
                      </div>
                    ) : (
                      <select name="status" defaultValue={editingEmployee?.status || 'Active'} required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                        <option value="Active">Active</option>
                        <option value="Inactive">Inactive</option>
                        <option value="Suspended">Suspended</option>
                        <option value="Pending Invite">Pending Invite</option>
                      </select>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Access PIN</label>
                    <input name="pin" type="password" maxLength={4} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="****" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Pay Rate</label>
                    <input name="payRate" type="number" defaultValue={editingEmployee?.payRate} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="20.00" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Pay Type</label>
                    <select name="payType" defaultValue={editingEmployee?.payType || 'Hourly'} required className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                      <option value="Hourly">Hourly</option>
                      <option value="Salary">Salary</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-4 pt-4 border-t border-slate-100">
                  <h4 className="text-sm font-black text-primary tracking-tight">Commissions</h4>
                  <div className="flex items-center gap-4">
                    <input type="checkbox" name="commissionEnabled" defaultChecked={editingEmployee?.commissionEnabled} id="commissionEnabled" className="w-4 h-4 text-primary rounded border-slate-300 focus:ring-primary" />
                    <label htmlFor="commissionEnabled" className="text-xs font-bold text-slate-700">Enable Commissions</label>
                  </div>
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Commission Type</label>
                      <select name="commissionType" defaultValue={editingEmployee?.commissionType || 'percentage'} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700">
                        <option value="percentage">Percentage (%)</option>
                        <option value="flat">Flat Amount ($)</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Commission Rate/Amount</label>
                      <input name="commissionRate" type="number" defaultValue={editingEmployee?.commissionRate} className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" placeholder="5.00" />
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-4 p-6 bg-emerald-50 rounded-3xl border border-emerald-100">
                  <div className="w-10 h-10 bg-emerald-500 text-white rounded-full flex items-center justify-center">
                    <span className="material-symbols-outlined text-sm">verified_user</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-black text-emerald-900 uppercase tracking-widest">Enable 2FA</p>
                    <p className="text-[10px] font-medium text-emerald-600">Require two-factor authentication for this employee.</p>
                  </div>
                  <div className="w-12 h-6 bg-emerald-500 rounded-full relative">
                    <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full shadow-sm"></div>
                  </div>
                </div>

                <button type="submit" className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all">
                  {editingEmployee ? 'Update Employee Profile' : 'Create Employee Profile'}
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showCreateRoleModal && (
          <div key="create-role-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowCreateRoleModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Create Store Role</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Define a new subordinate store role</p>
                </div>
                <button onClick={() => setShowCreateRoleModal(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              
              <div className="p-8 overflow-y-auto flex-1 space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Role Name</label>
                  <input 
                    value={newRole.name}
                    onChange={(e) => setNewRole(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700" 
                    placeholder="e.g. Senior Technician"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Description</label>
                  <textarea 
                    value={newRole.description}
                    onChange={(e) => setNewRole(prev => ({ ...prev, description: e.target.value }))}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700 resize-none h-20" 
                    placeholder="Describe what this role does..."
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Status</label>
                  <select 
                    value={newRole.status}
                    onChange={(e) => setNewRole(prev => ({ ...prev, status: e.target.value }))}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Module Access</label>
                  <div className="grid grid-cols-2 gap-3">
                    {storeModuleFeatures.map(feature => (
                      <label 
                        key={feature.id}
                        className={`flex items-center gap-3 p-4 rounded-2xl border cursor-pointer transition-all ${
                          newRole.permissions.includes(feature.id)
                            ? 'bg-primary/5 border-primary/20'
                            : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <input 
                          type="checkbox"
                          checked={newRole.permissions.includes(feature.id)}
                          onChange={() => togglePermission(feature.id)}
                          className="w-4 h-4 text-primary rounded border-slate-300 focus:ring-primary"
                        />
                        <span className="text-xs font-bold text-slate-700">{feature.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Administrative Permissions</label>
                  <div className="grid grid-cols-2 gap-3">
                    {storeAdminFeatures.map(feature => (
                      <label 
                        key={feature.id}
                        className={`flex items-center gap-3 p-4 rounded-2xl border cursor-pointer transition-all ${
                          newRole.permissions.includes(feature.id)
                            ? 'bg-indigo-50 border-indigo-200'
                            : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <input 
                          type="checkbox"
                          checked={newRole.permissions.includes(feature.id)}
                          onChange={() => togglePermission(feature.id)}
                          className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                        />
                        <span className="text-xs font-bold text-slate-700">{feature.name}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="bg-amber-50 p-4 rounded-2xl border border-amber-200">
                  <p className="text-[10px] font-black text-amber-800 uppercase tracking-widest">
                    Store Owner role cannot be created here. Only subordinate roles can be defined.
                  </p>
                </div>
              </div>

              <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-4">
                <button 
                  onClick={() => setShowCreateRoleModal(false)}
                  className="flex-1 py-4 bg-white text-slate-600 font-black text-sm rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all uppercase tracking-widest"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleCreateRole}
                  disabled={!newRole.name.trim()}
                  className="flex-1 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Create Role
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showTimeEditModal && editingTimeLog && (
          <div key="time-edit-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => { setShowTimeEditModal(false); setEditingTimeLog(null); }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Edit Time Log</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">{editingTimeLog.employeeName}</p>
                </div>
                <button onClick={() => { setShowTimeEditModal(false); setEditingTimeLog(null); }} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              
              <div className="p-8 space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Employee</label>
                  <input 
                    disabled
                    value={editingTimeLog.employeeName}
                    className="w-full px-6 py-4 bg-slate-100 rounded-2xl border border-slate-200 font-bold text-slate-500"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Clock In</label>
                  <input 
                    value={editingTimeLog.clockIn}
                    onChange={(e) => setEditingTimeLog({ ...editingTimeLog, clockIn: e.target.value })}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Clock Out</label>
                  <input 
                    value={editingTimeLog.clockOut || ''}
                    onChange={(e) => setEditingTimeLog({ ...editingTimeLog, clockOut: e.target.value })}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                    placeholder="Not clocked out yet"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-4">Status</label>
                  <select 
                    value={editingTimeLog.status}
                    onChange={(e) => setEditingTimeLog({ ...editingTimeLog, status: e.target.value as any })}
                    className="w-full px-6 py-4 bg-slate-50 rounded-2xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 font-bold text-slate-700"
                  >
                    <option value="Clocked In">Clocked In</option>
                    <option value="Clocked Out">Clocked Out</option>
                  </select>
                </div>
                <button 
                  onClick={handleSaveTimeLog}
                  className="w-full py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 uppercase tracking-widest hover:bg-primary/90 transition-all"
                >
                  Save Changes
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showPayrollWizard && (
          <div key="payroll-modal" className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowPayrollWizard(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-4xl bg-white rounded-[3rem] shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">Payroll Wizard</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Review and process employee payments</p>
                </div>
                <button onClick={() => setShowPayrollWizard(false)} className="w-10 h-10 rounded-full hover:bg-slate-200 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined text-slate-400">close</span>
                </button>
              </div>
              
              <div className="p-8 overflow-y-auto flex-1">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/50">
                      <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Employee</th>
                      <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Base Pay</th>
                      <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Commissions</th>
                      <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Total Pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((emp) => {
                      const isEmpOwner = emp.roleId === 'store_owner';
                      const hidePayData = isManager && isEmpOwner;
                      const basePay = emp.payType === 'Salary' ? emp.payRate : emp.payRate * 40;
                      const commissions = emp.commissionEnabled ? (emp.commissionType === 'flat' ? emp.commissionRate : basePay * (emp.commissionRate / 100)) : 0;
                      const totalPay = basePay + commissions;
                      return (
                        <tr key={emp.id} className="border-b border-slate-50">
                          <td className="px-6 py-4">
                            <p className="text-sm font-black text-primary">{emp.firstName} {emp.lastName}</p>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{emp.roleName}</p>
                          </td>
                          <td className="px-6 py-4 text-right text-sm font-bold text-slate-600">{hidePayData ? '—' : `$${basePay.toFixed(2)}`}</td>
                          <td className="px-6 py-4 text-right text-sm font-bold text-emerald-600">{hidePayData ? '—' : `$${commissions.toFixed(2)}`}</td>
                          <td className="px-6 py-4 text-right text-sm font-black text-primary">{hidePayData ? <span className="text-slate-400 text-xs font-bold">Restricted</span> : `$${totalPay.toFixed(2)}`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              
              <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex justify-end gap-4">
                <button onClick={() => setShowPayrollWizard(false)} className="px-8 py-4 bg-white text-slate-600 font-black text-sm rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all uppercase tracking-widest">
                  Cancel
                </button>
                <button onClick={() => { showToast('Payroll processed successfully!'); setShowPayrollWizard(false); }} className="px-8 py-4 bg-primary text-white font-black text-sm rounded-2xl shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all uppercase tracking-widest">
                  Process Payroll
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showClockInPicker && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[70] flex items-center justify-center bg-primary/30 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-black text-primary">Clock In Employee</h3>
                <button onClick={() => setShowClockInPicker(false)} className="text-slate-400 hover:text-primary transition-colors">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <p className="text-xs font-medium text-slate-500 mb-4">Select an employee to clock in:</p>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {employees.filter(e => {
                  if (e.status !== 'Active') return false;
                  if (isManager && e.roleId === 'store_owner') return false;
                  return true;
                }).map(emp => {
                  const isClockedIn = timeLogs.some(tl => tl.employeeId === emp.id && tl.status === 'Clocked In');
                  return (
                    <button
                      key={emp.id}
                      disabled={isClockedIn}
                      onClick={() => { clockInEmployee(emp); setShowClockInPicker(false); }}
                      className={`w-full flex items-center gap-4 p-4 rounded-2xl border transition-all ${
                        isClockedIn
                          ? 'bg-slate-50 border-slate-100 opacity-50 cursor-not-allowed'
                          : 'bg-white border-slate-200 hover:border-primary hover:shadow-md cursor-pointer'
                      }`}
                    >
                      <img src={emp.avatar} alt={emp.firstName} className="w-10 h-10 rounded-xl object-cover" />
                      <div className="text-left flex-1">
                        <p className="text-sm font-black text-primary">{emp.firstName} {emp.lastName}</p>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{emp.roleName}</p>
                      </div>
                      {isClockedIn && (
                        <span className="px-2 py-1 bg-emerald-100 text-emerald-700 text-[9px] font-black uppercase tracking-widest rounded-lg">Active</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showClockOutPicker && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[70] flex items-center justify-center bg-primary/30 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-black text-primary">Clock Out Employee</h3>
                <button onClick={() => setShowClockOutPicker(false)} className="text-slate-400 hover:text-primary transition-colors">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <p className="text-xs font-medium text-slate-500 mb-4">Select an active employee to clock out:</p>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {employees.filter(e => {
                  const isActive = timeLogs.some(tl => tl.employeeId === e.id && (tl.status === 'Clocked In' || tl.status === 'On Break'));
                  if (!isActive) return false;
                  if (isManager && e.roleId === 'store_owner') return false;
                  return true;
                }).length === 0 ? (
                  <div className="text-center py-8">
                    <span className="material-symbols-outlined text-4xl text-slate-300 mb-2 block">schedule</span>
                    <p className="text-sm font-bold text-slate-400">No employees currently clocked in</p>
                  </div>
                ) : (
                  employees.filter(e => {
                    const isActive = timeLogs.some(tl => tl.employeeId === e.id && (tl.status === 'Clocked In' || tl.status === 'On Break'));
                    if (!isActive) return false;
                    if (isManager && e.roleId === 'store_owner') return false;
                    return true;
                  }).map(emp => {
                    const empLog = timeLogs.find(tl => tl.employeeId === emp.id && (tl.status === 'Clocked In' || tl.status === 'On Break'));
                    return (
                      <button
                        key={emp.id}
                        onClick={() => { clockOutEmployee(emp); setShowClockOutPicker(false); }}
                        className="w-full flex items-center gap-4 p-4 rounded-2xl border border-slate-200 bg-white hover:border-rose-400 hover:shadow-md transition-all cursor-pointer"
                      >
                        <img src={emp.avatar} alt={emp.firstName} className="w-10 h-10 rounded-xl object-cover" />
                        <div className="text-left flex-1">
                          <p className="text-sm font-black text-primary">{emp.firstName} {emp.lastName}</p>
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{emp.roleName}</p>
                        </div>
                        <span className={`px-2 py-1 text-[9px] font-black uppercase tracking-widest rounded-lg ${
                          empLog?.status === 'On Break' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                        }`}>{empLog?.status}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showBreakPicker && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[70] flex items-center justify-center bg-primary/30 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-black text-primary">Start Break</h3>
                <button onClick={() => setShowBreakPicker(false)} className="text-slate-400 hover:text-primary transition-colors">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <p className="text-xs font-medium text-slate-500 mb-4">Select a clocked-in employee to put on break:</p>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {employees.filter(e => {
                  const isClockedIn = timeLogs.some(tl => tl.employeeId === e.id && tl.status === 'Clocked In');
                  if (!isClockedIn) return false;
                  if (isManager && e.roleId === 'store_owner') return false;
                  return true;
                }).length === 0 ? (
                  <div className="text-center py-8">
                    <span className="material-symbols-outlined text-4xl text-slate-300 mb-2 block">free_breakfast</span>
                    <p className="text-sm font-bold text-slate-400">No clocked-in employees available</p>
                  </div>
                ) : (
                  employees.filter(e => {
                    const isClockedIn = timeLogs.some(tl => tl.employeeId === e.id && tl.status === 'Clocked In');
                    if (!isClockedIn) return false;
                    if (isManager && e.roleId === 'store_owner') return false;
                    return true;
                  }).map(emp => (
                    <button
                      key={emp.id}
                      onClick={() => { startBreakEmployee(emp); setShowBreakPicker(false); }}
                      className="w-full flex items-center gap-4 p-4 rounded-2xl border border-slate-200 bg-white hover:border-amber-400 hover:shadow-md transition-all cursor-pointer"
                    >
                      <img src={emp.avatar} alt={emp.firstName} className="w-10 h-10 rounded-xl object-cover" />
                      <div className="text-left flex-1">
                        <p className="text-sm font-black text-primary">{emp.firstName} {emp.lastName}</p>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{emp.roleName}</p>
                      </div>
                      <span className="px-2 py-1 bg-emerald-100 text-emerald-700 text-[9px] font-black uppercase tracking-widest rounded-lg">Clocked In</span>
                    </button>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showEndBreakPicker && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[70] flex items-center justify-center bg-primary/30 backdrop-blur-md p-4">
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className="bg-white rounded-[2.5rem] shadow-2xl max-w-md w-full p-8 ghost-border">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-black text-primary">Back from Break</h3>
                <button onClick={() => setShowEndBreakPicker(false)} className="text-slate-400 hover:text-primary transition-colors">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <p className="text-xs font-medium text-slate-500 mb-4">Select an employee to return from break:</p>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {employees.filter(e => {
                  const isOnBreak = timeLogs.some(tl => tl.employeeId === e.id && tl.status === 'On Break');
                  if (!isOnBreak) return false;
                  if (isManager && e.roleId === 'store_owner') return false;
                  return true;
                }).length === 0 ? (
                  <div className="text-center py-8">
                    <span className="material-symbols-outlined text-4xl text-slate-300 mb-2 block">arrow_back</span>
                    <p className="text-sm font-bold text-slate-400">No employees currently on break</p>
                  </div>
                ) : (
                  employees.filter(e => {
                    const isOnBreak = timeLogs.some(tl => tl.employeeId === e.id && tl.status === 'On Break');
                    if (!isOnBreak) return false;
                    if (isManager && e.roleId === 'store_owner') return false;
                    return true;
                  }).map(emp => (
                    <button
                      key={emp.id}
                      onClick={() => { endBreakEmployee(emp); setShowEndBreakPicker(false); }}
                      className="w-full flex items-center gap-4 p-4 rounded-2xl border border-slate-200 bg-white hover:border-blue-400 hover:shadow-md transition-all cursor-pointer"
                    >
                      <img src={emp.avatar} alt={emp.firstName} className="w-10 h-10 rounded-xl object-cover" />
                      <div className="text-left flex-1">
                        <p className="text-sm font-black text-primary">{emp.firstName} {emp.lastName}</p>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{emp.roleName}</p>
                      </div>
                      <span className="px-2 py-1 bg-amber-100 text-amber-700 text-[9px] font-black uppercase tracking-widest rounded-lg">On Break</span>
                    </button>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 50, x: '-50%' }}
            className={`fixed bottom-8 left-1/2 z-[60] px-8 py-4 rounded-2xl shadow-2xl border font-black text-sm uppercase tracking-widest ${
              toast.type === 'success' ? 'bg-emerald-500 text-white border-emerald-600' :
              toast.type === 'error' ? 'bg-rose-500 text-white border-rose-600' :
              'bg-primary text-white border-primary/80'
            }`}
          >
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
