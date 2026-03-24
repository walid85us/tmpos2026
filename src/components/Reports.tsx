import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  LineChart, Line, PieChart, Pie, Cell, AreaChart, Area 
} from 'recharts';

type ReportCategory = 'dashboard' | 'sales' | 'employee' | 'inventory' | 'insights';

const REPORT_SECTIONS: Record<Exclude<ReportCategory, 'dashboard'>, { title: string; icon: string; items: string[] }> = {
  sales: {
    title: 'Sales Reports',
    icon: 'payments',
    items: [
      'Custom Sales Report Builder',
      'Multi-Store Report',
      'Sales Reports Overview',
      'Register Sales',
      'Sales by Item Type',
      'Cash In/Out History',
      'Tax Report',
      'Total Revenue by Sales',
      'Item-wise Sales Report',
      'Z-Report',
      'Sales Summary Report',
      'Transaction Log Report',
      'Referral Source Report',
      'Trade-In Report',
      'Revenue by Payment Type',
      'Profit and Loss Report',
      'Revenue by Customer',
      'Business KPIs'
    ]
  },
  employee: {
    title: 'Employee Reports',
    icon: 'badge',
    items: [
      'Employee Reports Overview',
      'Employee & Store KPIs',
      'Employee Dashboard',
      'Store Progress Tracker',
      'Employee Activity Log',
      'Employee Productivity',
      'Employee Payroll',
      'Payroll Payments',
      'My Commission Report',
      'Commission Breakdown',
      'Gratuity Report'
    ]
  },
  inventory: {
    title: 'Inventory Reports',
    icon: 'inventory_2',
    items: [
      'Inventory Summary',
      'Inventory Reports Overview',
      'Inventory Adjustment',
      'Part Consumption',
      'Low Stock Report',
      'In-Transit Inventory',
      'Damage Part Report',
      'Ticket Items Report'
    ]
  },
  insights: {
    title: 'Insights',
    icon: 'insights',
    items: [
      'Insights Module Overview',
      'Sales Insights',
      'Tickets Insights'
    ]
  }
};

const MOCK_REVENUE_DATA = [
  { name: 'Mon', sales: 4000, repairs: 2400, accessories: 1200 },
  { name: 'Tue', sales: 3000, repairs: 1398, accessories: 1100 },
  { name: 'Wed', sales: 2000, repairs: 9800, accessories: 1500 },
  { name: 'Thu', sales: 2780, repairs: 3908, accessories: 1800 },
  { name: 'Fri', sales: 1890, repairs: 4800, accessories: 2000 },
  { name: 'Sat', sales: 2390, repairs: 3800, accessories: 2500 },
  { name: 'Sun', sales: 3490, repairs: 4300, accessories: 2100 },
];

const MOCK_PIE_DATA = [
  { name: 'Smartphones', value: 400 },
  { name: 'Laptops', value: 300 },
  { name: 'Tablets', value: 200 },
  { name: 'Accessories', value: 100 },
];

const COLORS = ['#0f766e', '#a3e635', '#14b8a6', '#f59e0b'];

export default function Reports() {
  const [activeCategory, setActiveCategory] = useState<ReportCategory>('dashboard');
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [bookmarkedReports, setBookmarkedReports] = useState<string[]>(['Business KPIs', 'Low Stock Report']);

  const toggleBookmark = (report: string) => {
    setBookmarkedReports(prev => 
      prev.includes(report) ? prev.filter(r => r !== report) : [...prev, report]
    );
  };

  const renderDashboard = () => (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[
          { label: 'Gross Revenue', value: '$124,850.00', trend: '+12.5%', color: 'text-primary' },
          { label: 'Net Profit', value: '$42,500.00', trend: '+8.2%', color: 'text-secondary' },
          { label: 'Avg. Ticket Size', value: '$156.00', trend: '-2.1%', color: 'text-primary' },
          { label: 'Conversion Rate', value: '68%', trend: '+4.5%', color: 'text-lime-600' },
        ].map((stat, i) => (
          <div key={i} className="bg-white/80 backdrop-blur-xl p-6 rounded-3xl border border-slate-200 shadow-sm">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{stat.label}</p>
            <p className={`text-2xl font-black mt-1 ${stat.color}`}>{stat.value}</p>
            <div className="mt-2 flex items-center gap-1">
              <span className={`text-[10px] font-bold ${stat.trend.startsWith('+') ? 'text-lime-600' : 'text-red-500'}`}>{stat.trend}</span>
              <span className="text-[10px] text-slate-400 font-medium">vs prev. period</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <div className="flex justify-between items-center mb-10">
            <h3 className="text-xl font-extrabold text-primary tracking-tight">Revenue Breakdown</h3>
            <div className="flex gap-4">
              {['Sales', 'Repairs', 'Accessories'].map((label, i) => (
                <div key={label} className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${[ 'bg-primary', 'bg-lime-400', 'bg-secondary' ][i]}`}></div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase">{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={MOCK_REVENUE_DATA}>
                <defs>
                  <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0f766e" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#0f766e" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fontSize: 10, fontWeight: 700, fill: '#94a3b8'}} />
                <YAxis axisLine={false} tickLine={false} tick={{fontSize: 10, fontWeight: 700, fill: '#94a3b8'}} />
                <Tooltip 
                  contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                />
                <Area type="monotone" dataKey="sales" stroke="#0f766e" fillOpacity={1} fill="url(#colorSales)" strokeWidth={3} />
                <Area type="monotone" dataKey="repairs" stroke="#a3e635" fillOpacity={0} strokeWidth={3} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-4 bg-white/80 backdrop-blur-xl p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
          <h3 className="text-xl font-extrabold text-primary tracking-tight mb-8">Category Mix</h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={MOCK_PIE_DATA}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {MOCK_PIE_DATA.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-3 mt-4">
            {MOCK_PIE_DATA.map((item, i) => (
              <div key={item.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i] }}></div>
                  <span className="text-xs font-bold text-slate-600">{item.name}</span>
                </div>
                <span className="text-xs font-black text-primary">{((item.value / 1000) * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const renderReportList = () => {
    if (activeCategory === 'dashboard') return renderDashboard();
    
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {REPORT_SECTIONS[activeCategory].items.map(item => (
          <motion.div 
            key={item}
            whileHover={{ y: -4 }}
            className="bg-white/80 backdrop-blur-xl p-6 rounded-[2rem] border border-slate-200 shadow-sm hover:shadow-md transition-all group cursor-pointer"
            onClick={() => setSelectedReport(item)}
          >
            <div className="flex justify-between items-start mb-4">
              <div className="w-10 h-10 bg-slate-50 rounded-xl flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-white transition-colors">
                <span className="material-symbols-outlined text-xl">{REPORT_SECTIONS[activeCategory].icon}</span>
              </div>
              <button 
                onClick={(e) => { e.stopPropagation(); toggleBookmark(item); }}
                className={`p-2 rounded-full transition-colors ${bookmarkedReports.includes(item) ? 'text-amber-500 bg-amber-50' : 'text-slate-300 hover:bg-slate-50'}`}
              >
                <span className="material-symbols-outlined text-sm">{bookmarkedReports.includes(item) ? 'bookmark' : 'bookmark_add'}</span>
              </button>
            </div>
            <h4 className="text-sm font-black text-primary mb-1">{item}</h4>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">View detailed analytics</p>
          </motion.div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-secondary font-extrabold mb-1 block">Business Intelligence</span>
          <h2 className="text-3xl font-extrabold text-primary tracking-tight font-headline">Reporting & Analytics</h2>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-500 bg-white/80 backdrop-blur-xl px-4 py-2 rounded-xl border border-slate-200 shadow-sm">
            <span className="material-symbols-outlined text-sm">calendar_month</span>
            <span className="text-sm font-semibold">Last 30 Days</span>
          </div>
          <button className="bg-primary text-white px-6 py-2 rounded-xl font-bold text-sm shadow-lg shadow-primary/20 flex items-center gap-2">
            <span className="material-symbols-outlined text-sm">download</span>
            Export PDF
          </button>
        </div>
      </header>

      <div className="flex items-center gap-2 bg-white/80 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-200 shadow-sm w-fit">
        {[
          { id: 'dashboard', label: 'Overview', icon: 'dashboard' },
          { id: 'sales', label: 'Sales', icon: 'payments' },
          { id: 'employee', label: 'Employees', icon: 'badge' },
          { id: 'inventory', label: 'Inventory', icon: 'inventory_2' },
          { id: 'insights', label: 'Insights', icon: 'insights' }
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              setActiveCategory(tab.id as ReportCategory);
              setSelectedReport(null);
            }}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
              activeCategory === tab.id 
                ? 'bg-primary text-white shadow-lg shadow-primary/20' 
                : 'text-slate-400 hover:text-primary hover:bg-slate-50'
            }`}
          >
            <span className="material-symbols-outlined text-sm">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={selectedReport || activeCategory}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {selectedReport ? (
            <div className="space-y-8">
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => setSelectedReport(null)}
                  className="w-10 h-10 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary transition-colors"
                >
                  <span className="material-symbols-outlined">arrow_back</span>
                </button>
                <div>
                  <h3 className="text-2xl font-black text-primary tracking-tight">{selectedReport}</h3>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Detailed Report Analysis</p>
                </div>
              </div>
              
              <div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border border-slate-200 flex flex-col items-center justify-center text-center">
                <div className="w-20 h-20 bg-primary/5 rounded-full flex items-center justify-center mb-6">
                  <span className="material-symbols-outlined text-4xl text-primary">analytics</span>
                </div>
                <h3 className="text-2xl font-black text-primary tracking-tight mb-2">{selectedReport} Data</h3>
                <p className="text-sm font-bold text-slate-400 max-w-md mb-8">
                  This report is being generated based on your real-time business data. 
                  Use the filters above to adjust the time period or store location.
                </p>
                <div className="w-full max-w-2xl h-64 bg-slate-50 rounded-[2rem] border border-slate-100 flex items-center justify-center">
                  <span className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em]">Chart Visualization Placeholder</span>
                </div>
              </div>
            </div>
          ) : (
            renderReportList()
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
