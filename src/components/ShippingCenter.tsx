import React, { useState, useMemo, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import { Shipment, ShipmentStatus, ShipmentSourceType, ShipmentType, ShipmentAddress, ShipmentPackage, ShipmentEvent, ShippingRate, AddressValidationResult, ProviderTrackingEvent } from '../types';
import * as shippingApi from '../shipping/shippingApiClient';
import type { ProviderError } from '../shipping/types';
import PageShell from './PageShell';
import ShippingProvidersPage from './ShippingProvidersPage';

async function convertImageToPdfBlobUrl(imageUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const proxyUrl = `/api/shipping/label-proxy?url=${encodeURIComponent(imageUrl)}`;
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas not supported')); return; }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.95);
        const jpegBase64 = jpegDataUrl.split(',')[1];
        const jpegBytes = Uint8Array.from(atob(jpegBase64), c => c.charCodeAt(0));

        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const enc = new TextEncoder();
        const parts: Uint8Array[] = [];

        const writeStr = (s: string) => { parts.push(enc.encode(s)); };
        const offsets: number[] = [0, 0, 0, 0, 0, 0];
        let pos = 0;
        const calcPos = () => { pos = parts.reduce((a, p) => a + p.length, 0); };

        writeStr('%PDF-1.4\n');
        calcPos(); offsets[1] = pos;
        writeStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
        calcPos(); offsets[2] = pos;
        writeStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
        calcPos(); offsets[3] = pos;
        writeStr(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>\nendobj\n`);
        calcPos(); offsets[4] = pos;
        const contentStream = `q\n${w} 0 0 ${h} 0 0 cm\n/Img Do\nQ\n`;
        writeStr(`4 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`);
        calcPos(); offsets[5] = pos;
        writeStr(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
        parts.push(jpegBytes);
        writeStr('\nendstream\nendobj\n');

        calcPos();
        const xrefPos = pos;
        writeStr(`xref\n0 6\n0000000000 65535 f \n`);
        for (let i = 1; i <= 5; i++) {
          writeStr(`${offsets[i].toString().padStart(10, '0')} 00000 n \n`);
        }
        writeStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

        const totalLen = parts.reduce((a, p) => a + p.length, 0);
        const pdfBuffer = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) { pdfBuffer.set(p, offset); offset += p.length; }

        const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
        resolve(URL.createObjectURL(blob));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('Failed to load label image'));
    img.src = proxyUrl;
  });
}

export interface ShipmentPrefill {
  sourceType: ShipmentSourceType;
  sourceId: string;
  sourceNumber: string;
  type: ShipmentType;
  originAddress: ShipmentAddress;
  destinationAddress: ShipmentAddress;
  notes?: string;
  sourceItems?: { id: string; name: string; quantity: number; price?: number }[];
}

const STATUS_ORDER: ShipmentStatus[] = ['Draft', 'Ready', 'Label Created', 'Packed', 'Dispatched', 'In Transit', 'Delivered', 'Exception', 'Rejected', 'Returned', 'Cancelled'];

const STATUS_COLORS: Record<ShipmentStatus, string> = {
  'Draft': 'bg-slate-100 text-slate-600 border-slate-200',
  'Ready': 'bg-blue-50 text-blue-700 border-blue-200',
  'Label Created': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  'Packed': 'bg-violet-50 text-violet-700 border-violet-200',
  'Dispatched': 'bg-amber-50 text-amber-700 border-amber-200',
  'In Transit': 'bg-sky-50 text-sky-700 border-sky-200',
  'Delivered': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Exception': 'bg-red-50 text-red-700 border-red-200',
  'Rejected': 'bg-orange-50 text-orange-700 border-orange-200',
  'Returned': 'bg-pink-50 text-pink-700 border-pink-200',
  'Cancelled': 'bg-slate-50 text-slate-400 border-slate-200',
};

const TYPE_LABELS: Record<ShipmentType, string> = {
  'customer_delivery': 'Customer Delivery',
  'repair_return': 'Repair Return',
  'store_transfer': 'Store Transfer',
  'rma_outbound': 'RMA Outbound',
  'rma_return': 'RMA Return',
};

const SOURCE_LABELS: Record<ShipmentSourceType, string> = {
  'invoice': 'Invoice',
  'repair': 'Repair',
  'transfer': 'Transfer',
  'rma': 'RMA',
};

const SOURCE_ICONS: Record<ShipmentSourceType, string> = {
  'invoice': 'receipt_long',
  'repair': 'build',
  'transfer': 'swap_horiz',
  'rma': 'assignment_return',
};

const CARRIERS = ['UPS', 'FedEx', 'USPS', 'DHL', 'Internal Courier', 'Other'];
const SERVICE_LEVELS = ['Ground', 'Express', 'Priority Overnight', 'Priority Mail', '2-Day', 'Same Day', 'Economy', 'Freight'];

const REJECTION_REASONS = [
  'Invalid or undeliverable address',
  'Package refused by recipient',
  'Carrier unable to accept — size/weight restrictions',
  'Hazardous or restricted contents',
  'Customs clearance failure',
  'Carrier service disruption',
  'Other operational reason',
];
const RETURN_REASONS = [
  'Delivery failed — recipient unavailable',
  'Customer refused delivery',
  'Incorrect or incomplete address',
  'Package damaged in transit',
  'Unclaimed package — holding period expired',
  'Customs rejection — return to sender',
  'Other operational reason',
];
const ROLLBACK_REASONS = [
  'Repackaging needed',
  'Not actually dropped at carrier facility',
  'Handoff mistake — incorrect package or label',
  'Shipping paperwork issue',
  'Internal operational correction',
  'Other operational reason',
];


const US_ZIP_CITY_STATE: Record<string, { city: string; state: string }> = {
  '10001': { city: 'New York', state: 'NY' }, '10002': { city: 'New York', state: 'NY' }, '10003': { city: 'New York', state: 'NY' },
  '10010': { city: 'New York', state: 'NY' }, '10011': { city: 'New York', state: 'NY' }, '10012': { city: 'New York', state: 'NY' },
  '10016': { city: 'New York', state: 'NY' }, '10017': { city: 'New York', state: 'NY' }, '10018': { city: 'New York', state: 'NY' },
  '10019': { city: 'New York', state: 'NY' }, '10020': { city: 'New York', state: 'NY' }, '10021': { city: 'New York', state: 'NY' },
  '10022': { city: 'New York', state: 'NY' }, '10023': { city: 'New York', state: 'NY' }, '10024': { city: 'New York', state: 'NY' },
  '10025': { city: 'New York', state: 'NY' }, '10026': { city: 'New York', state: 'NY' }, '10027': { city: 'New York', state: 'NY' },
  '10028': { city: 'New York', state: 'NY' }, '10029': { city: 'New York', state: 'NY' }, '10030': { city: 'New York', state: 'NY' },
  '10031': { city: 'New York', state: 'NY' }, '10032': { city: 'New York', state: 'NY' }, '10033': { city: 'New York', state: 'NY' },
  '10034': { city: 'New York', state: 'NY' }, '10035': { city: 'New York', state: 'NY' }, '10036': { city: 'New York', state: 'NY' },
  '10037': { city: 'New York', state: 'NY' }, '10038': { city: 'New York', state: 'NY' }, '10039': { city: 'New York', state: 'NY' },
  '10040': { city: 'New York', state: 'NY' },
  '11201': { city: 'Brooklyn', state: 'NY' }, '11211': { city: 'Brooklyn', state: 'NY' }, '11215': { city: 'Brooklyn', state: 'NY' },
  '11101': { city: 'Long Island City', state: 'NY' },
  '90001': { city: 'Los Angeles', state: 'CA' }, '90002': { city: 'Los Angeles', state: 'CA' }, '90003': { city: 'Los Angeles', state: 'CA' },
  '90004': { city: 'Los Angeles', state: 'CA' }, '90005': { city: 'Los Angeles', state: 'CA' }, '90006': { city: 'Los Angeles', state: 'CA' },
  '90007': { city: 'Los Angeles', state: 'CA' }, '90008': { city: 'Los Angeles', state: 'CA' }, '90010': { city: 'Los Angeles', state: 'CA' },
  '90012': { city: 'Los Angeles', state: 'CA' }, '90013': { city: 'Los Angeles', state: 'CA' }, '90014': { city: 'Los Angeles', state: 'CA' },
  '90015': { city: 'Los Angeles', state: 'CA' }, '90016': { city: 'Los Angeles', state: 'CA' }, '90017': { city: 'Los Angeles', state: 'CA' },
  '90018': { city: 'Los Angeles', state: 'CA' }, '90019': { city: 'Los Angeles', state: 'CA' }, '90020': { city: 'Los Angeles', state: 'CA' },
  '90024': { city: 'Los Angeles', state: 'CA' }, '90025': { city: 'Los Angeles', state: 'CA' }, '90027': { city: 'Los Angeles', state: 'CA' },
  '90028': { city: 'Hollywood', state: 'CA' }, '90029': { city: 'Los Angeles', state: 'CA' },
  '90034': { city: 'Los Angeles', state: 'CA' }, '90036': { city: 'Los Angeles', state: 'CA' }, '90038': { city: 'Los Angeles', state: 'CA' },
  '90042': { city: 'Los Angeles', state: 'CA' }, '90045': { city: 'Los Angeles', state: 'CA' }, '90046': { city: 'Los Angeles', state: 'CA' },
  '90048': { city: 'Los Angeles', state: 'CA' }, '90049': { city: 'Los Angeles', state: 'CA' },
  '90210': { city: 'Beverly Hills', state: 'CA' }, '90211': { city: 'Beverly Hills', state: 'CA' },
  '90401': { city: 'Santa Monica', state: 'CA' }, '90402': { city: 'Santa Monica', state: 'CA' },
  '91101': { city: 'Pasadena', state: 'CA' }, '91201': { city: 'Glendale', state: 'CA' },
  '91301': { city: 'Agoura Hills', state: 'CA' }, '91401': { city: 'Van Nuys', state: 'CA' },
  '92101': { city: 'San Diego', state: 'CA' }, '92102': { city: 'San Diego', state: 'CA' }, '92103': { city: 'San Diego', state: 'CA' },
  '94102': { city: 'San Francisco', state: 'CA' }, '94103': { city: 'San Francisco', state: 'CA' }, '94104': { city: 'San Francisco', state: 'CA' },
  '94105': { city: 'San Francisco', state: 'CA' }, '94107': { city: 'San Francisco', state: 'CA' }, '94108': { city: 'San Francisco', state: 'CA' },
  '94109': { city: 'San Francisco', state: 'CA' }, '94110': { city: 'San Francisco', state: 'CA' }, '94111': { city: 'San Francisco', state: 'CA' },
  '94112': { city: 'San Francisco', state: 'CA' }, '94114': { city: 'San Francisco', state: 'CA' }, '94115': { city: 'San Francisco', state: 'CA' },
  '94116': { city: 'San Francisco', state: 'CA' }, '94117': { city: 'San Francisco', state: 'CA' }, '94118': { city: 'San Francisco', state: 'CA' },
  '94121': { city: 'San Francisco', state: 'CA' }, '94122': { city: 'San Francisco', state: 'CA' }, '94123': { city: 'San Francisco', state: 'CA' },
  '94124': { city: 'San Francisco', state: 'CA' }, '94127': { city: 'San Francisco', state: 'CA' }, '94131': { city: 'San Francisco', state: 'CA' },
  '94133': { city: 'San Francisco', state: 'CA' }, '94134': { city: 'San Francisco', state: 'CA' },
  '95101': { city: 'San Jose', state: 'CA' }, '95110': { city: 'San Jose', state: 'CA' }, '95112': { city: 'San Jose', state: 'CA' },
  '60601': { city: 'Chicago', state: 'IL' }, '60602': { city: 'Chicago', state: 'IL' }, '60603': { city: 'Chicago', state: 'IL' },
  '60604': { city: 'Chicago', state: 'IL' }, '60605': { city: 'Chicago', state: 'IL' }, '60606': { city: 'Chicago', state: 'IL' },
  '60607': { city: 'Chicago', state: 'IL' }, '60608': { city: 'Chicago', state: 'IL' }, '60609': { city: 'Chicago', state: 'IL' },
  '60610': { city: 'Chicago', state: 'IL' }, '60611': { city: 'Chicago', state: 'IL' }, '60612': { city: 'Chicago', state: 'IL' },
  '60613': { city: 'Chicago', state: 'IL' }, '60614': { city: 'Chicago', state: 'IL' }, '60615': { city: 'Chicago', state: 'IL' },
  '60616': { city: 'Chicago', state: 'IL' }, '60617': { city: 'Chicago', state: 'IL' }, '60618': { city: 'Chicago', state: 'IL' },
  '60619': { city: 'Chicago', state: 'IL' }, '60620': { city: 'Chicago', state: 'IL' }, '60621': { city: 'Chicago', state: 'IL' },
  '60622': { city: 'Chicago', state: 'IL' }, '60623': { city: 'Chicago', state: 'IL' }, '60624': { city: 'Chicago', state: 'IL' },
  '60625': { city: 'Chicago', state: 'IL' }, '60626': { city: 'Chicago', state: 'IL' }, '60628': { city: 'Chicago', state: 'IL' },
  '60629': { city: 'Chicago', state: 'IL' }, '60630': { city: 'Chicago', state: 'IL' }, '60631': { city: 'Chicago', state: 'IL' },
  '60632': { city: 'Chicago', state: 'IL' }, '60634': { city: 'Chicago', state: 'IL' }, '60636': { city: 'Chicago', state: 'IL' },
  '60637': { city: 'Chicago', state: 'IL' }, '60638': { city: 'Chicago', state: 'IL' }, '60639': { city: 'Chicago', state: 'IL' },
  '60640': { city: 'Chicago', state: 'IL' }, '60641': { city: 'Chicago', state: 'IL' }, '60642': { city: 'Chicago', state: 'IL' },
  '60643': { city: 'Chicago', state: 'IL' }, '60644': { city: 'Chicago', state: 'IL' }, '60645': { city: 'Chicago', state: 'IL' },
  '60646': { city: 'Chicago', state: 'IL' }, '60647': { city: 'Chicago', state: 'IL' },
  '77001': { city: 'Houston', state: 'TX' }, '77002': { city: 'Houston', state: 'TX' }, '77003': { city: 'Houston', state: 'TX' },
  '77004': { city: 'Houston', state: 'TX' }, '77005': { city: 'Houston', state: 'TX' }, '77006': { city: 'Houston', state: 'TX' },
  '77007': { city: 'Houston', state: 'TX' }, '77008': { city: 'Houston', state: 'TX' }, '77009': { city: 'Houston', state: 'TX' },
  '77010': { city: 'Houston', state: 'TX' }, '77011': { city: 'Houston', state: 'TX' }, '77012': { city: 'Houston', state: 'TX' },
  '77019': { city: 'Houston', state: 'TX' }, '77020': { city: 'Houston', state: 'TX' }, '77021': { city: 'Houston', state: 'TX' },
  '77022': { city: 'Houston', state: 'TX' }, '77023': { city: 'Houston', state: 'TX' }, '77024': { city: 'Houston', state: 'TX' },
  '77025': { city: 'Houston', state: 'TX' }, '77026': { city: 'Houston', state: 'TX' }, '77027': { city: 'Houston', state: 'TX' },
  '77028': { city: 'Houston', state: 'TX' }, '77029': { city: 'Houston', state: 'TX' }, '77030': { city: 'Houston', state: 'TX' },
  '75201': { city: 'Dallas', state: 'TX' }, '75202': { city: 'Dallas', state: 'TX' }, '75203': { city: 'Dallas', state: 'TX' },
  '75204': { city: 'Dallas', state: 'TX' }, '75205': { city: 'Dallas', state: 'TX' }, '75206': { city: 'Dallas', state: 'TX' },
  '75207': { city: 'Dallas', state: 'TX' }, '75208': { city: 'Dallas', state: 'TX' }, '75209': { city: 'Dallas', state: 'TX' },
  '75210': { city: 'Dallas', state: 'TX' }, '75211': { city: 'Dallas', state: 'TX' }, '75212': { city: 'Dallas', state: 'TX' },
  '75214': { city: 'Dallas', state: 'TX' }, '75215': { city: 'Dallas', state: 'TX' }, '75216': { city: 'Dallas', state: 'TX' },
  '78701': { city: 'Austin', state: 'TX' }, '78702': { city: 'Austin', state: 'TX' }, '78703': { city: 'Austin', state: 'TX' },
  '78704': { city: 'Austin', state: 'TX' }, '78705': { city: 'Austin', state: 'TX' }, '78712': { city: 'Austin', state: 'TX' },
  '78721': { city: 'Austin', state: 'TX' }, '78722': { city: 'Austin', state: 'TX' }, '78723': { city: 'Austin', state: 'TX' },
  '78724': { city: 'Austin', state: 'TX' }, '78725': { city: 'Austin', state: 'TX' }, '78726': { city: 'Austin', state: 'TX' },
  '78727': { city: 'Austin', state: 'TX' }, '78728': { city: 'Austin', state: 'TX' }, '78729': { city: 'Austin', state: 'TX' },
  '78730': { city: 'Austin', state: 'TX' }, '78731': { city: 'Austin', state: 'TX' }, '78732': { city: 'Austin', state: 'TX' },
  '78733': { city: 'Austin', state: 'TX' }, '78734': { city: 'Austin', state: 'TX' }, '78735': { city: 'Austin', state: 'TX' },
  '78741': { city: 'Austin', state: 'TX' }, '78745': { city: 'Austin', state: 'TX' }, '78746': { city: 'Austin', state: 'TX' },
  '78748': { city: 'Austin', state: 'TX' }, '78749': { city: 'Austin', state: 'TX' }, '78750': { city: 'Austin', state: 'TX' },
  '78751': { city: 'Austin', state: 'TX' }, '78752': { city: 'Austin', state: 'TX' }, '78753': { city: 'Austin', state: 'TX' },
  '78754': { city: 'Austin', state: 'TX' }, '78756': { city: 'Austin', state: 'TX' }, '78757': { city: 'Austin', state: 'TX' },
  '78758': { city: 'Austin', state: 'TX' }, '78759': { city: 'Austin', state: 'TX' },
  '78201': { city: 'San Antonio', state: 'TX' }, '78202': { city: 'San Antonio', state: 'TX' }, '78204': { city: 'San Antonio', state: 'TX' },
  '78205': { city: 'San Antonio', state: 'TX' }, '78207': { city: 'San Antonio', state: 'TX' }, '78210': { city: 'San Antonio', state: 'TX' },
  '85001': { city: 'Phoenix', state: 'AZ' }, '85003': { city: 'Phoenix', state: 'AZ' }, '85004': { city: 'Phoenix', state: 'AZ' },
  '85006': { city: 'Phoenix', state: 'AZ' }, '85007': { city: 'Phoenix', state: 'AZ' }, '85008': { city: 'Phoenix', state: 'AZ' },
  '19101': { city: 'Philadelphia', state: 'PA' }, '19102': { city: 'Philadelphia', state: 'PA' }, '19103': { city: 'Philadelphia', state: 'PA' },
  '19104': { city: 'Philadelphia', state: 'PA' }, '19106': { city: 'Philadelphia', state: 'PA' }, '19107': { city: 'Philadelphia', state: 'PA' },
  '19123': { city: 'Philadelphia', state: 'PA' }, '19125': { city: 'Philadelphia', state: 'PA' }, '19130': { city: 'Philadelphia', state: 'PA' },
  '19146': { city: 'Philadelphia', state: 'PA' }, '19147': { city: 'Philadelphia', state: 'PA' },
  '33101': { city: 'Miami', state: 'FL' }, '33109': { city: 'Miami Beach', state: 'FL' }, '33125': { city: 'Miami', state: 'FL' },
  '33126': { city: 'Miami', state: 'FL' }, '33127': { city: 'Miami', state: 'FL' }, '33128': { city: 'Miami', state: 'FL' },
  '33129': { city: 'Miami', state: 'FL' }, '33130': { city: 'Miami', state: 'FL' }, '33131': { city: 'Miami', state: 'FL' },
  '33132': { city: 'Miami', state: 'FL' }, '33133': { city: 'Miami', state: 'FL' }, '33134': { city: 'Miami', state: 'FL' },
  '33135': { city: 'Miami', state: 'FL' }, '33136': { city: 'Miami', state: 'FL' }, '33137': { city: 'Miami', state: 'FL' },
  '33138': { city: 'Miami', state: 'FL' }, '33139': { city: 'Miami Beach', state: 'FL' }, '33140': { city: 'Miami Beach', state: 'FL' },
  '33141': { city: 'Miami Beach', state: 'FL' }, '33142': { city: 'Miami', state: 'FL' }, '33145': { city: 'Miami', state: 'FL' },
  '32801': { city: 'Orlando', state: 'FL' }, '32803': { city: 'Orlando', state: 'FL' }, '32806': { city: 'Orlando', state: 'FL' },
  '30301': { city: 'Atlanta', state: 'GA' }, '30303': { city: 'Atlanta', state: 'GA' }, '30305': { city: 'Atlanta', state: 'GA' },
  '30306': { city: 'Atlanta', state: 'GA' }, '30308': { city: 'Atlanta', state: 'GA' }, '30309': { city: 'Atlanta', state: 'GA' },
  '30310': { city: 'Atlanta', state: 'GA' }, '30312': { city: 'Atlanta', state: 'GA' }, '30313': { city: 'Atlanta', state: 'GA' },
  '30314': { city: 'Atlanta', state: 'GA' }, '30315': { city: 'Atlanta', state: 'GA' }, '30316': { city: 'Atlanta', state: 'GA' },
  '30317': { city: 'Atlanta', state: 'GA' }, '30318': { city: 'Atlanta', state: 'GA' }, '30319': { city: 'Atlanta', state: 'GA' },
  '30324': { city: 'Atlanta', state: 'GA' }, '30326': { city: 'Atlanta', state: 'GA' }, '30327': { city: 'Atlanta', state: 'GA' },
  '98101': { city: 'Seattle', state: 'WA' }, '98102': { city: 'Seattle', state: 'WA' }, '98103': { city: 'Seattle', state: 'WA' },
  '98104': { city: 'Seattle', state: 'WA' }, '98105': { city: 'Seattle', state: 'WA' }, '98106': { city: 'Seattle', state: 'WA' },
  '98107': { city: 'Seattle', state: 'WA' }, '98108': { city: 'Seattle', state: 'WA' }, '98109': { city: 'Seattle', state: 'WA' },
  '98112': { city: 'Seattle', state: 'WA' }, '98115': { city: 'Seattle', state: 'WA' }, '98116': { city: 'Seattle', state: 'WA' },
  '98117': { city: 'Seattle', state: 'WA' }, '98118': { city: 'Seattle', state: 'WA' }, '98119': { city: 'Seattle', state: 'WA' },
  '98121': { city: 'Seattle', state: 'WA' }, '98122': { city: 'Seattle', state: 'WA' }, '98125': { city: 'Seattle', state: 'WA' },
  '98126': { city: 'Seattle', state: 'WA' }, '98133': { city: 'Seattle', state: 'WA' }, '98134': { city: 'Seattle', state: 'WA' },
  '98136': { city: 'Seattle', state: 'WA' }, '98144': { city: 'Seattle', state: 'WA' }, '98199': { city: 'Seattle', state: 'WA' },
  '97201': { city: 'Portland', state: 'OR' }, '97202': { city: 'Portland', state: 'OR' }, '97203': { city: 'Portland', state: 'OR' },
  '97204': { city: 'Portland', state: 'OR' }, '97205': { city: 'Portland', state: 'OR' }, '97206': { city: 'Portland', state: 'OR' },
  '97209': { city: 'Portland', state: 'OR' }, '97210': { city: 'Portland', state: 'OR' }, '97211': { city: 'Portland', state: 'OR' },
  '97212': { city: 'Portland', state: 'OR' }, '97213': { city: 'Portland', state: 'OR' }, '97214': { city: 'Portland', state: 'OR' },
  '97215': { city: 'Portland', state: 'OR' }, '97217': { city: 'Portland', state: 'OR' }, '97218': { city: 'Portland', state: 'OR' },
  '97219': { city: 'Portland', state: 'OR' }, '97220': { city: 'Portland', state: 'OR' }, '97221': { city: 'Portland', state: 'OR' },
  '80201': { city: 'Denver', state: 'CO' }, '80202': { city: 'Denver', state: 'CO' }, '80203': { city: 'Denver', state: 'CO' },
  '80204': { city: 'Denver', state: 'CO' }, '80205': { city: 'Denver', state: 'CO' }, '80206': { city: 'Denver', state: 'CO' },
  '80209': { city: 'Denver', state: 'CO' }, '80210': { city: 'Denver', state: 'CO' }, '80211': { city: 'Denver', state: 'CO' },
  '80212': { city: 'Denver', state: 'CO' }, '80216': { city: 'Denver', state: 'CO' }, '80218': { city: 'Denver', state: 'CO' },
  '80219': { city: 'Denver', state: 'CO' }, '80220': { city: 'Denver', state: 'CO' }, '80222': { city: 'Denver', state: 'CO' },
  '80223': { city: 'Denver', state: 'CO' }, '80224': { city: 'Denver', state: 'CO' }, '80227': { city: 'Denver', state: 'CO' },
  '89101': { city: 'Las Vegas', state: 'NV' }, '89102': { city: 'Las Vegas', state: 'NV' }, '89103': { city: 'Las Vegas', state: 'NV' },
  '89104': { city: 'Las Vegas', state: 'NV' }, '89106': { city: 'Las Vegas', state: 'NV' }, '89109': { city: 'Las Vegas', state: 'NV' },
  '37201': { city: 'Nashville', state: 'TN' }, '37203': { city: 'Nashville', state: 'TN' }, '37204': { city: 'Nashville', state: 'TN' },
  '37205': { city: 'Nashville', state: 'TN' }, '37206': { city: 'Nashville', state: 'TN' }, '37207': { city: 'Nashville', state: 'TN' },
  '37208': { city: 'Nashville', state: 'TN' }, '37209': { city: 'Nashville', state: 'TN' }, '37210': { city: 'Nashville', state: 'TN' },
  '37211': { city: 'Nashville', state: 'TN' }, '37212': { city: 'Nashville', state: 'TN' }, '37213': { city: 'Nashville', state: 'TN' },
  '37214': { city: 'Nashville', state: 'TN' }, '37215': { city: 'Nashville', state: 'TN' }, '37216': { city: 'Nashville', state: 'TN' },
  '02101': { city: 'Boston', state: 'MA' }, '02102': { city: 'Boston', state: 'MA' }, '02108': { city: 'Boston', state: 'MA' },
  '02109': { city: 'Boston', state: 'MA' }, '02110': { city: 'Boston', state: 'MA' }, '02111': { city: 'Boston', state: 'MA' },
  '02113': { city: 'Boston', state: 'MA' }, '02114': { city: 'Boston', state: 'MA' }, '02115': { city: 'Boston', state: 'MA' },
  '02116': { city: 'Boston', state: 'MA' }, '02118': { city: 'Boston', state: 'MA' }, '02119': { city: 'Boston', state: 'MA' },
  '02120': { city: 'Boston', state: 'MA' }, '02121': { city: 'Boston', state: 'MA' }, '02122': { city: 'Boston', state: 'MA' },
  '02124': { city: 'Boston', state: 'MA' }, '02125': { city: 'Boston', state: 'MA' }, '02126': { city: 'Boston', state: 'MA' },
  '02127': { city: 'Boston', state: 'MA' }, '02128': { city: 'Boston', state: 'MA' }, '02129': { city: 'Boston', state: 'MA' },
  '02130': { city: 'Boston', state: 'MA' }, '02131': { city: 'Boston', state: 'MA' }, '02132': { city: 'Boston', state: 'MA' },
  '02134': { city: 'Boston', state: 'MA' }, '02135': { city: 'Boston', state: 'MA' },
  '20001': { city: 'Washington', state: 'DC' }, '20002': { city: 'Washington', state: 'DC' }, '20003': { city: 'Washington', state: 'DC' },
  '20004': { city: 'Washington', state: 'DC' }, '20005': { city: 'Washington', state: 'DC' }, '20006': { city: 'Washington', state: 'DC' },
  '20007': { city: 'Washington', state: 'DC' }, '20008': { city: 'Washington', state: 'DC' }, '20009': { city: 'Washington', state: 'DC' },
  '20010': { city: 'Washington', state: 'DC' }, '20011': { city: 'Washington', state: 'DC' }, '20012': { city: 'Washington', state: 'DC' },
  '20015': { city: 'Washington', state: 'DC' }, '20016': { city: 'Washington', state: 'DC' }, '20017': { city: 'Washington', state: 'DC' },
  '20018': { city: 'Washington', state: 'DC' }, '20019': { city: 'Washington', state: 'DC' }, '20020': { city: 'Washington', state: 'DC' },
  '20024': { city: 'Washington', state: 'DC' }, '20032': { city: 'Washington', state: 'DC' }, '20036': { city: 'Washington', state: 'DC' },
  '20037': { city: 'Washington', state: 'DC' },
  '48201': { city: 'Detroit', state: 'MI' }, '48202': { city: 'Detroit', state: 'MI' }, '48204': { city: 'Detroit', state: 'MI' },
  '48205': { city: 'Detroit', state: 'MI' }, '48206': { city: 'Detroit', state: 'MI' }, '48207': { city: 'Detroit', state: 'MI' },
  '48208': { city: 'Detroit', state: 'MI' }, '48209': { city: 'Detroit', state: 'MI' }, '48210': { city: 'Detroit', state: 'MI' },
  '55401': { city: 'Minneapolis', state: 'MN' }, '55402': { city: 'Minneapolis', state: 'MN' }, '55403': { city: 'Minneapolis', state: 'MN' },
  '55404': { city: 'Minneapolis', state: 'MN' }, '55405': { city: 'Minneapolis', state: 'MN' }, '55406': { city: 'Minneapolis', state: 'MN' },
  '55407': { city: 'Minneapolis', state: 'MN' }, '55408': { city: 'Minneapolis', state: 'MN' }, '55409': { city: 'Minneapolis', state: 'MN' },
  '63101': { city: 'St. Louis', state: 'MO' }, '63102': { city: 'St. Louis', state: 'MO' }, '63103': { city: 'St. Louis', state: 'MO' },
  '64101': { city: 'Kansas City', state: 'MO' }, '64102': { city: 'Kansas City', state: 'MO' }, '64105': { city: 'Kansas City', state: 'MO' },
  '28201': { city: 'Charlotte', state: 'NC' }, '28202': { city: 'Charlotte', state: 'NC' }, '28203': { city: 'Charlotte', state: 'NC' },
  '28204': { city: 'Charlotte', state: 'NC' }, '28205': { city: 'Charlotte', state: 'NC' }, '28206': { city: 'Charlotte', state: 'NC' },
  '46201': { city: 'Indianapolis', state: 'IN' }, '46202': { city: 'Indianapolis', state: 'IN' }, '46203': { city: 'Indianapolis', state: 'IN' },
  '46204': { city: 'Indianapolis', state: 'IN' }, '46205': { city: 'Indianapolis', state: 'IN' },
  '43201': { city: 'Columbus', state: 'OH' }, '43202': { city: 'Columbus', state: 'OH' }, '43203': { city: 'Columbus', state: 'OH' },
  '43204': { city: 'Columbus', state: 'OH' }, '43205': { city: 'Columbus', state: 'OH' }, '43206': { city: 'Columbus', state: 'OH' },
  '53201': { city: 'Milwaukee', state: 'WI' }, '53202': { city: 'Milwaukee', state: 'WI' }, '53203': { city: 'Milwaukee', state: 'WI' },
  '53204': { city: 'Milwaukee', state: 'WI' }, '53205': { city: 'Milwaukee', state: 'WI' },
  '21201': { city: 'Baltimore', state: 'MD' }, '21202': { city: 'Baltimore', state: 'MD' }, '21205': { city: 'Baltimore', state: 'MD' },
  '21206': { city: 'Baltimore', state: 'MD' }, '21207': { city: 'Baltimore', state: 'MD' },
  '84101': { city: 'Salt Lake City', state: 'UT' }, '84102': { city: 'Salt Lake City', state: 'UT' }, '84103': { city: 'Salt Lake City', state: 'UT' },
  '96801': { city: 'Honolulu', state: 'HI' }, '96813': { city: 'Honolulu', state: 'HI' }, '96814': { city: 'Honolulu', state: 'HI' },
  '96815': { city: 'Honolulu', state: 'HI' }, '96816': { city: 'Honolulu', state: 'HI' }, '96817': { city: 'Honolulu', state: 'HI' },
  '99501': { city: 'Anchorage', state: 'AK' }, '99502': { city: 'Anchorage', state: 'AK' }, '99503': { city: 'Anchorage', state: 'AK' },
  '87101': { city: 'Albuquerque', state: 'NM' }, '87102': { city: 'Albuquerque', state: 'NM' }, '87104': { city: 'Albuquerque', state: 'NM' },
  '68101': { city: 'Omaha', state: 'NE' }, '68102': { city: 'Omaha', state: 'NE' }, '68104': { city: 'Omaha', state: 'NE' },
  '40201': { city: 'Louisville', state: 'KY' }, '40202': { city: 'Louisville', state: 'KY' }, '40203': { city: 'Louisville', state: 'KY' },
  '73101': { city: 'Oklahoma City', state: 'OK' }, '73102': { city: 'Oklahoma City', state: 'OK' }, '73103': { city: 'Oklahoma City', state: 'OK' },
  '06101': { city: 'Hartford', state: 'CT' }, '06103': { city: 'Hartford', state: 'CT' },
  '02901': { city: 'Providence', state: 'RI' }, '02903': { city: 'Providence', state: 'RI' },
  '29401': { city: 'Charleston', state: 'SC' }, '29403': { city: 'Charleston', state: 'SC' },
  '23219': { city: 'Richmond', state: 'VA' }, '23220': { city: 'Richmond', state: 'VA' }, '23221': { city: 'Richmond', state: 'VA' },
  '27601': { city: 'Raleigh', state: 'NC' }, '27603': { city: 'Raleigh', state: 'NC' }, '27604': { city: 'Raleigh', state: 'NC' },
  '35201': { city: 'Birmingham', state: 'AL' }, '35203': { city: 'Birmingham', state: 'AL' }, '35204': { city: 'Birmingham', state: 'AL' },
  '38101': { city: 'Memphis', state: 'TN' }, '38103': { city: 'Memphis', state: 'TN' }, '38104': { city: 'Memphis', state: 'TN' },
  '70112': { city: 'New Orleans', state: 'LA' }, '70113': { city: 'New Orleans', state: 'LA' }, '70114': { city: 'New Orleans', state: 'LA' },
  '70115': { city: 'New Orleans', state: 'LA' }, '70116': { city: 'New Orleans', state: 'LA' }, '70117': { city: 'New Orleans', state: 'LA' },
  '15201': { city: 'Pittsburgh', state: 'PA' }, '15206': { city: 'Pittsburgh', state: 'PA' }, '15210': { city: 'Pittsburgh', state: 'PA' },
  '15213': { city: 'Pittsburgh', state: 'PA' }, '15219': { city: 'Pittsburgh', state: 'PA' }, '15222': { city: 'Pittsburgh', state: 'PA' },
  '44101': { city: 'Cleveland', state: 'OH' }, '44102': { city: 'Cleveland', state: 'OH' }, '44103': { city: 'Cleveland', state: 'OH' },
  '45201': { city: 'Cincinnati', state: 'OH' }, '45202': { city: 'Cincinnati', state: 'OH' }, '45203': { city: 'Cincinnati', state: 'OH' },
};

function lookupZipCode(zip: string): { city: string; state: string } | null {
  return US_ZIP_CITY_STATE[zip] || null;
}

function formatAddress(addr: ShipmentAddress): string {
  const parts = [addr.name];
  if (addr.company) parts.push(addr.company);
  parts.push(addr.line1);
  if (addr.line2) parts.push(addr.line2);
  parts.push(`${addr.city}, ${addr.state} ${addr.postalCode}`);
  return parts.join(', ');
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function ShippingCenter() {
  const { shipments, addShipment, updateShipment, invoices, repairTickets, rmas, inventoryTransfers, suppliers, customers } = useStoreLocalState();
  const { checkPermission, checkSubPermission, isWriteBlocked } = useAccess();
  const location = useLocation();
  const navigate = useNavigate();

  const canView = checkPermission('shipping', 'view');
  const canCreate = checkSubPermission('create_shipment');
  const canEditPreDispatch = checkSubPermission('edit_shipment_pre_dispatch');
  const canDispatch = checkSubPermission('dispatch_shipment');
  const canUpdateTracking = checkSubPermission('update_tracking_events');
  const canCancel = checkSubPermission('cancel_shipment');
  const canViewCosts = checkSubPermission('view_shipping_costs');
  const canValidateAddress = checkSubPermission('validate_shipping_address');
  const canFetchRates = checkSubPermission('fetch_shipping_rates');
  const canPurchaseLabel = checkSubPermission('purchase_shipping_label');
  const canPrintLabel = checkSubPermission('print_shipping_label');
  const canSyncTracking = checkSubPermission('sync_shipping_tracking');
  const canManageProviderSettings = checkSubPermission('manage_shipping_settings');

  const [activeTab, setActiveTab] = useState<'shipments' | 'settings'>('shipments');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ShipmentStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<ShipmentSourceType | 'all'>('all');
  const [selectedShipment, setSelectedShipment] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'overview' | 'tracking' | 'packages'>('overview');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingShipment, setEditingShipment] = useState<string | null>(null);
  const [showStatusConfirm, setShowStatusConfirm] = useState<{ id: string; newStatus: ShipmentStatus; label: string } | null>(null);
  const [addEventModal, setAddEventModal] = useState<string | null>(null);
  const [eventDescription, setEventDescription] = useState('');
  const [eventLocation, setEventLocation] = useState('');
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [providerEnvironment, setProviderEnvironment] = useState<'test' | 'production' | null>(null);
  const [reasonModal, setReasonModal] = useState<{ id: string; newStatus: 'Rejected' | 'Returned' | 'Packed' } | null>(null);
  const [selectedReason, setSelectedReason] = useState('');
  const [reasonNotes, setReasonNotes] = useState('');
  useEffect(() => {
    shippingApi.getActiveProvider().then(r => {
      setActiveProviderId(r.activeProviderId);
      setProviderEnvironment(r.environment || null);
    });
    loadProviderStatuses();
  }, []);

  const [newCarrier, setNewCarrier] = useState('');
  const [newService, setNewService] = useState('');
  const [newTracking, setNewTracking] = useState('');
  const [newCost, setNewCost] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [newOrigin, setNewOrigin] = useState<ShipmentAddress>({ name: '', line1: '', city: '', state: '', postalCode: '', country: 'US' });
  const [newDest, setNewDest] = useState<ShipmentAddress>({ name: '', line1: '', city: '', state: '', postalCode: '', country: 'US' });
  const [newSourceType, setNewSourceType] = useState<ShipmentSourceType>('invoice');
  const [newSourceNumber, setNewSourceNumber] = useState('');
  const [newSourceId, setNewSourceId] = useState('');
  const [newType, setNewType] = useState<ShipmentType>('customer_delivery');
  const [newPackages, setNewPackages] = useState<ShipmentPackage[]>([]);
  const [sourceItems, setSourceItems] = useState<{ id: string; name: string; quantity: number; price?: number }[]>([]);
  const [editPackages, setEditPackages] = useState<ShipmentPackage[]>([]);
  const [sourceResolved, setSourceResolved] = useState<string | null>(null);
  const [sourceResolveError, setSourceResolveError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  const [providerLoading, setProviderLoading] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<ProviderError | null>(null);
  const [providerSuccess, setProviderSuccess] = useState<string | null>(null);
  const [providerWarning, setProviderWarning] = useState<string | null>(null);
  const [showTestTrackerMenu, setShowTestTrackerMenu] = useState(false);
  const [showRatesPanel, setShowRatesPanel] = useState(false);
  const [availableRates, setAvailableRates] = useState<ShippingRate[]>([]);
  const [showProviderSettings, setShowProviderSettings] = useState(false);
  const [providerStatuses, setProviderStatuses] = useState<any[]>([]);
  const [providerSettingsLoading, setProviderSettingsLoading] = useState(false);
  const [trackingCopied, setTrackingCopied] = useState(false);
  const [showWebhookLog, setShowWebhookLog] = useState(false);
  const [webhookLogEntries, setWebhookLogEntries] = useState<any[]>([]);
  const [webhookLogLoading, setWebhookLogLoading] = useState(false);
  const [webhookLogFilter, setWebhookLogFilter] = useState<string>('all');

  const STORE_ADDRESS: ShipmentAddress = { name: 'Main Warehouse', line1: '100 Commerce Dr', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', phone: '555-0100' };

  const ELIGIBLE_INVOICE_STATUSES = ['Paid', 'Partially Paid'];
  const ELIGIBLE_REPAIR_STATUSES = ['Ready for Pickup', 'Completed'];
  const ELIGIBLE_TRANSFER_STATUSES = ['Draft', 'Sent', 'In Transit'];
  const ELIGIBLE_RMA_STATUSES = ['Pending', 'Shipped'];

  function resolveSourceReference() {
    const ref = newSourceNumber.trim();
    if (!ref) {
      setSourceResolveError('Enter a source reference number to resolve.');
      setSourceResolved(null);
      return;
    }

    setIsResolving(true);
    setSourceResolveError(null);
    setSourceResolved(null);

    if (newSourceType === 'invoice') {
      const invoice = invoices.find(inv => inv.invoiceNumber.toLowerCase() === ref.toLowerCase());
      if (!invoice) {
        setSourceResolveError(`No invoice found with reference "${ref}".`);
        setIsResolving(false);
        return;
      }
      if (!ELIGIBLE_INVOICE_STATUSES.includes(invoice.status)) {
        setSourceResolveError(`Invoice ${invoice.invoiceNumber} has status "${invoice.status}" — only Paid or Partially Paid invoices are eligible for shipping.`);
        setIsResolving(false);
        return;
      }
      const customer = customers.find(c => c.id === invoice.customerId);
      const addrParts = (customer?.address || '').split(',').map(s => s.trim());
      setNewSourceId(invoice.id);
      setNewSourceNumber(invoice.invoiceNumber);
      setNewType('customer_delivery');
      setNewOrigin(STORE_ADDRESS);
      setNewDest({
        name: customer?.name || invoice.customerName || 'Customer',
        line1: addrParts[0] || '', city: addrParts[1] || '', state: addrParts[2] || '', postalCode: addrParts[3] || '', country: 'US',
        email: customer?.email || invoice.customerEmail, phone: customer?.phone || invoice.customerPhone,
      });
      const items = invoice.items.map(i => ({ id: i.id, name: i.name, quantity: i.quantity, price: i.price }));
      setSourceItems(items);
      if (items.length > 0) {
        const contentsSummary = items.map(i => `${i.name} x${i.quantity}`).join(', ');
        const declaredValue = items.reduce((sum, i) => sum + (i.price || 0) * i.quantity, 0);
        setNewPackages([{ id: `pkg-${Date.now()}`, contentsSummary, declaredValue: declaredValue > 0 ? declaredValue : undefined }]);
      } else {
        setNewPackages([]);
      }
      setSourceResolved(`Resolved: ${invoice.invoiceNumber} — ${invoice.customerName} (${invoice.status})`);
    } else if (newSourceType === 'repair') {
      const ticket = repairTickets.find(t => t.ticketNumber.toLowerCase() === ref.toLowerCase());
      if (!ticket) {
        setSourceResolveError(`No repair ticket found with reference "${ref}".`);
        setIsResolving(false);
        return;
      }
      if (!ELIGIBLE_REPAIR_STATUSES.includes(ticket.status)) {
        setSourceResolveError(`Repair ticket ${ticket.ticketNumber} has status "${ticket.status}" — only Ready for Pickup or Completed tickets are eligible for shipping.`);
        setIsResolving(false);
        return;
      }
      const customer = customers.find(c => c.id === ticket.customerId);
      const addrParts = (customer?.address || '').split(',').map(s => s.trim());
      setNewSourceId(ticket.id);
      setNewSourceNumber(ticket.ticketNumber);
      setNewType('repair_return');
      setNewOrigin(STORE_ADDRESS);
      setNewDest({
        name: customer?.name || ticket.customerName || 'Customer',
        line1: addrParts[0] || '', city: addrParts[1] || '', state: addrParts[2] || '', postalCode: addrParts[3] || '', country: 'US',
        email: customer?.email || ticket.customerEmail, phone: customer?.phone || ticket.customerPhone,
      });
      const items = [{ id: ticket.id, name: `${ticket.device} — ${ticket.issue}`, quantity: 1, price: ticket.actualCost || ticket.estimatedCost }];
      setSourceItems(items);
      const contentsSummary = `${ticket.device} (${ticket.issue})`;
      const declaredValue = ticket.actualCost || ticket.estimatedCost || 0;
      setNewPackages([{ id: `pkg-${Date.now()}`, contentsSummary, declaredValue: declaredValue > 0 ? declaredValue : undefined }]);
      setSourceResolved(`Resolved: ${ticket.ticketNumber} — ${ticket.customerName}, ${ticket.device} (${ticket.status})`);
    } else if (newSourceType === 'transfer') {
      const transfer = inventoryTransfers.find(t => t.transferNumber.toLowerCase() === ref.toLowerCase());
      if (!transfer) {
        setSourceResolveError(`No transfer found with reference "${ref}".`);
        setIsResolving(false);
        return;
      }
      if (!ELIGIBLE_TRANSFER_STATUSES.includes(transfer.status)) {
        setSourceResolveError(`Transfer ${transfer.transferNumber} has status "${transfer.status}" — only Draft, Sent, or In Transit transfers are eligible for shipping.`);
        setIsResolving(false);
        return;
      }
      setNewSourceId(transfer.id);
      setNewSourceNumber(transfer.transferNumber);
      setNewType('store_transfer');
      setNewOrigin({ ...STORE_ADDRESS, name: transfer.fromStore });
      setNewDest({ name: transfer.toStore, line1: '', city: '', state: '', postalCode: '', country: 'US' });
      const items = transfer.items.map(i => ({ id: i.productId, name: i.name, quantity: i.quantity }));
      setSourceItems(items);
      if (items.length > 0) {
        const contentsSummary = items.map(i => `${i.name} x${i.quantity}`).join(', ');
        setNewPackages([{ id: `pkg-${Date.now()}`, contentsSummary }]);
      } else {
        setNewPackages([]);
      }
      setSourceResolved(`Resolved: ${transfer.transferNumber} — ${transfer.fromStore} → ${transfer.toStore} (${transfer.status})`);
    } else if (newSourceType === 'rma') {
      const rma = rmas.find(r => r.rmaNumber.toLowerCase() === ref.toLowerCase());
      if (!rma) {
        setSourceResolveError(`No RMA found with reference "${ref}".`);
        setIsResolving(false);
        return;
      }
      if (!ELIGIBLE_RMA_STATUSES.includes(rma.status)) {
        setSourceResolveError(`RMA ${rma.rmaNumber} has status "${rma.status}" — only Pending or Shipped RMAs are eligible for shipping.`);
        setIsResolving(false);
        return;
      }
      const supplier = suppliers.find(s => s.id === rma.supplierId);
      const addrParts = (supplier?.address || '').split(',').map(s => s.trim());
      setNewSourceId(rma.id);
      setNewSourceNumber(rma.rmaNumber);
      setNewType('rma_outbound');
      setNewOrigin(STORE_ADDRESS);
      setNewDest({
        name: supplier?.name || rma.supplierName || 'Supplier',
        company: supplier?.name || rma.supplierName,
        line1: addrParts[0] || '', city: addrParts[1] || '', state: addrParts[2] || '', postalCode: addrParts[3] || '', country: 'US',
        phone: supplier?.phone, email: supplier?.email,
      });
      const items = rma.items.map(i => ({ id: i.productId, name: i.name, quantity: i.quantity }));
      setSourceItems(items);
      if (items.length > 0) {
        const contentsSummary = items.map(i => `${i.name} x${i.quantity}`).join(', ');
        setNewPackages([{ id: `pkg-${Date.now()}`, contentsSummary }]);
      } else {
        setNewPackages([]);
      }
      setSourceResolved(`Resolved: ${rma.rmaNumber} — ${rma.supplierName} (${rma.status})`);
    }

    setIsResolving(false);
  }

  useEffect(() => {
    const state = location.state as { openCreate?: boolean; prefill?: ShipmentPrefill } | null;
    if (state?.openCreate && state.prefill && canCreate) {
      const p = state.prefill;
      setNewSourceType(p.sourceType);
      setNewSourceId(p.sourceId);
      setNewSourceNumber(p.sourceNumber);
      setNewType(p.type);
      setNewOrigin(p.originAddress);
      setNewDest(p.destinationAddress);
      setNewNotes(p.notes || '');
      setSourceItems(p.sourceItems || []);
      if (p.sourceItems && p.sourceItems.length > 0) {
        const contentsSummary = p.sourceItems.map(i => `${i.name} x${i.quantity}`).join(', ');
        const declaredValue = p.sourceItems.reduce((sum, i) => sum + (i.price || 0) * i.quantity, 0);
        setNewPackages([{ id: `pkg-${Date.now()}`, contentsSummary, declaredValue: declaredValue > 0 ? declaredValue : undefined }]);
      } else {
        setNewPackages([]);
      }
      setNewCarrier('');
      setNewService('');
      setNewTracking('');
      setNewCost('');
      setShowCreateModal(true);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state]);

  const filtered = useMemo(() => {
    let items = [...shipments];
    if (statusFilter !== 'all') items = items.filter(s => s.status === statusFilter);
    if (sourceFilter !== 'all') items = items.filter(s => s.sourceType === sourceFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(s =>
        s.shipmentNumber.toLowerCase().includes(q) ||
        (s.trackingNumber && s.trackingNumber.toLowerCase().includes(q)) ||
        s.destinationAddress.name.toLowerCase().includes(q) ||
        s.sourceNumber.toLowerCase().includes(q) ||
        (s.carrier && s.carrier.toLowerCase().includes(q))
      );
    }
    return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [shipments, statusFilter, sourceFilter, search]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: shipments.length };
    STATUS_ORDER.forEach(s => { counts[s] = shipments.filter(sh => sh.status === s).length; });
    return counts;
  }, [shipments]);

  const isPreDispatch = (status: ShipmentStatus) => ['Draft', 'Ready', 'Label Created', 'Packed'].includes(status);
  const isEditable = (status: ShipmentStatus) => ['Draft', 'Ready', 'Label Created', 'Packed'].includes(status);

  function handleStatusTransition(id: string, newStatus: ShipmentStatus, reason?: string, notes?: string) {
    if (isWriteBlocked) { setShowStatusConfirm(null); setReasonModal(null); return; }
    const shipment = shipments.find(s => s.id === id);
    if (!shipment) return;

    if (['In Transit', 'Delivered', 'Exception'].includes(newStatus) && isPostDispatch(shipment.status)) {
      setShowStatusConfirm(null);
      return;
    }

    if (newStatus === 'Cancelled' && shipment && hasCarrierAcceptance(shipment)) {
      setShowStatusConfirm(null);
      return;
    }

    if ((newStatus === 'Rejected' || newStatus === 'Returned') && !reason) {
      setReasonModal({ id, newStatus });
      setShowStatusConfirm(null);
      return;
    }

    if (newStatus === 'Packed' && shipment.status === 'Dispatched') {
      if (hasCarrierAcceptance(shipment)) {
        setShowStatusConfirm(null);
        setReasonModal(null);
        return;
      }
      if (!reason) {
        setReasonModal({ id, newStatus: 'Packed' });
        setShowStatusConfirm(null);
        return;
      }
    }

    const now = new Date().toISOString();
    const updates: Partial<Shipment> = { status: newStatus, updatedAt: now };

    if (newStatus === 'Dispatched') updates.dispatchedAt = now;
    if (newStatus === 'Delivered') updates.deliveredAt = now;
    if (newStatus === 'Packed' && shipment.status === 'Dispatched') updates.dispatchedAt = undefined;

    let description = `Status changed to ${newStatus}`;
    if (reason) description += ` — Reason: ${reason}`;
    if (notes) description += ` — Notes: ${notes}`;

    const newEvent: ShipmentEvent = {
      id: `evt-${Date.now()}`,
      timestamp: now,
      status: newStatus,
      description,
      performedBy: 'Current User',
    };
    updates.events = [...shipment.events, newEvent];
    updateShipment(id, updates);
    setShowStatusConfirm(null);
    setReasonModal(null);
    setSelectedReason('');
    setReasonNotes('');
  }

  function handleCreateShipment() {
    if (isWriteBlocked) { setShowCreateModal(false); return; }
    const now = new Date().toISOString();
    const newId = `shp-${Date.now()}`;
    const shipment: Shipment = {
      id: newId,
      shipmentNumber: `SHP-${new Date().getFullYear()}-${String(shipments.length + 1).padStart(3, '0')}`,
      type: newType,
      status: 'Draft',
      sourceType: newSourceType,
      sourceId: newSourceId || `src-${Date.now()}`,
      sourceNumber: newSourceNumber || 'N/A',
      originAddress: newOrigin,
      destinationAddress: newDest,
      packages: newPackages,
      carrier: newCarrier || undefined,
      serviceLevel: newService || undefined,
      trackingNumber: newTracking || undefined,
      shippingCost: canViewCosts && newCost ? parseFloat(newCost) : undefined,
      notes: newNotes || undefined,
      events: [{ id: `evt-${Date.now()}`, timestamp: now, status: 'Created', description: `Shipment created${newSourceNumber ? ` from ${newSourceNumber}` : ''}`, performedBy: 'Current User' }],
      createdBy: 'Current User',
      createdAt: now,
      updatedAt: now,
    };
    addShipment(shipment);
    resetCreateForm();
    setShowCreateModal(false);
    setSelectedShipment(newId);
    setDetailTab('overview');
  }

  function handleSaveEdit() {
    if (isWriteBlocked) { setEditingShipment(null); return; }
    if (!editingShipment) return;
    const shipment = shipments.find(s => s.id === editingShipment);
    const now = new Date().toISOString();
    const hasLabel = !!shipment?.label;
    const hasRate = !!shipment?.selectedRate;
    const updates: Partial<Shipment> = {
      notes: newNotes || undefined,
      packages: editPackages,
      updatedAt: now,
    };
    if (!hasLabel) {
      updates.carrier = newCarrier || undefined;
      updates.serviceLevel = newService || undefined;
      if ((newCarrier || newService) && !hasRate) {
        updates.selectedRate = undefined;
      }
      if (newCarrier && newService && hasRate) {
        const rateCarrier = shipment?.selectedRate?.carrier;
        const rateService = shipment?.selectedRate?.serviceName;
        if (newCarrier !== rateCarrier || newService !== rateService) {
          updates.selectedRate = undefined;
        }
      }
    }
    if (!hasLabel) {
      updates.trackingNumber = newTracking || undefined;
    }
    updates.originAddress = newOrigin;
    updates.destinationAddress = newDest;
    const destChanged = shipment && (
      newDest.line1 !== shipment.destinationAddress.line1 ||
      newDest.city !== shipment.destinationAddress.city ||
      newDest.state !== shipment.destinationAddress.state ||
      newDest.postalCode !== shipment.destinationAddress.postalCode
    );
    if (destChanged && shipment?.addressValidation) {
      updates.addressValidation = undefined;
    }
    updates.shippingCost = newCost ? parseFloat(newCost) : undefined;
    updateShipment(editingShipment, updates);
    setEditingShipment(null);
  }

  function handleAddEvent(shipmentId: string) {
    if (isWriteBlocked) { setAddEventModal(null); setEventDescription(''); setEventLocation(''); return; }
    if (!eventDescription.trim()) return;
    const shipment = shipments.find(s => s.id === shipmentId);
    if (!shipment) return;
    const newEvent: ShipmentEvent = {
      id: `evt-${Date.now()}`,
      timestamp: new Date().toISOString(),
      status: shipment.status,
      description: eventDescription,
      location: eventLocation || undefined,
      performedBy: 'Current User',
    };
    updateShipment(shipmentId, { events: [...shipment.events, newEvent], updatedAt: new Date().toISOString() });
    setAddEventModal(null);
    setEventDescription('');
    setEventLocation('');
  }

  function clearProviderFeedback() {
    setProviderError(null);
    setProviderSuccess(null);
    setProviderWarning(null);
  }

  function friendlyProviderError(raw: ProviderError): ProviderError {
    const msg = raw.message.toLowerCase();
    if (raw.code === 'PROVIDER_NOT_CONFIGURED' || msg.includes('no credentials') || msg.includes('not configured')) {
      return { ...raw, message: 'Shipping provider is not configured. Go to Provider Settings to enter your credentials.' };
    }
    if (raw.code === 'NO_PROVIDER') return raw;
    if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('network error')) {
      return { ...raw, message: 'Unable to reach the shipping provider. Check your internet connection and try again.', retryable: true };
    }
    if (raw.code === 'AUTH_FAILED' || msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
      return { ...raw, message: 'Invalid credentials. Please verify your API key and secret in Provider Settings.' };
    }
    if (msg.includes('not found') || msg.includes('404')) {
      return { ...raw, message: 'The requested resource was not found at the provider. Verify the shipment details and try again.' };
    }
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) {
      return { ...raw, message: 'Too many requests to the shipping provider. Please wait a moment and try again.', retryable: true };
    }
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('server error') || msg.includes('internal error')) {
      return { ...raw, message: 'The shipping provider is experiencing issues. Please try again shortly.', retryable: true };
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return { ...raw, message: 'Request to the shipping provider timed out. Please try again.', retryable: true };
    }
    if (raw.code === 'VALIDATION_FAILED' || msg.includes('invalid address') || msg.includes('validation')) {
      return { ...raw, message: `Address validation issue: ${raw.message}` };
    }
    return raw;
  }

  function hasShippablePackages(shipment: Shipment): boolean {
    return shipment.packages.length > 0 && shipment.packages.some(p => p.weight || p.contentsSummary || p.declaredValue);
  }

  function isAddressAccepted(shipment: Shipment): boolean {
    const av = shipment.addressValidation;
    if (!av) return false;
    return av.status === 'validated' || (av.status === 'corrected' && av.accepted === true);
  }

  function getProviderPrerequisiteMessage(): string | null {
    if (activeProviderId) return null;
    const hasAnyConfigured = providerStatuses.length > 0;
    return hasAnyConfigured ? 'Set an active shipping provider' : 'Configure a shipping provider';
  }

  function getRatePrerequisites(shipment: Shipment): string[] {
    const missing: string[] = [];
    if (!isAddressAccepted(shipment)) missing.push('Validate destination address');
    if (!hasShippablePackages(shipment)) missing.push('Add packages with weight or contents');
    const providerMsg = getProviderPrerequisiteMessage();
    if (providerMsg) missing.push(providerMsg);
    return missing;
  }

  function isCarrierRequiringPhone(shipment: Shipment): boolean {
    const carrier = (shipment.carrier || shipment.selectedRate?.carrier || '').toUpperCase();
    return carrier.includes('UPS') || carrier.includes('FEDEX');
  }

  function isValidPhone(phone?: string): boolean {
    if (!phone) return false;
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 10;
  }

  const EASYPOST_TEST_CODES = new Set([
    'EZ1000000001', 'EZ2000000002', 'EZ3000000003', 'EZ4000000004',
    'EZ5000000005', 'EZ6000000006', 'EZ7000000007',
  ]);
  function isEasyPostTestTrackingCode(trackingNumber: string): boolean {
    return EASYPOST_TEST_CODES.has(trackingNumber.toUpperCase());
  }

  function getLabelPrerequisites(shipment: Shipment): string[] {
    const missing: string[] = [];
    if (!isAddressAccepted(shipment)) missing.push('Validate destination address');
    if (!hasShippablePackages(shipment)) missing.push('Add packages with weight or contents');
    if (!shipment.selectedRate && (!shipment.carrier || !shipment.serviceLevel)) missing.push('Select a shipping rate or set carrier and service level');
    if (isCarrierRequiringPhone(shipment) && !isValidPhone(shipment.destinationAddress.phone)) {
      missing.push('Recipient phone number required for UPS/FedEx (at least 10 digits) — add via Edit Shipment');
    }
    const providerMsg = getProviderPrerequisiteMessage();
    if (providerMsg) missing.push(providerMsg);
    return missing;
  }

  async function handleValidateAddress(shipmentId: string) {
    if (isWriteBlocked) return;
    const shipment = shipments.find(s => s.id === shipmentId);
    if (!shipment) return;
    clearProviderFeedback();
    setProviderLoading('validate');
    const result = await shippingApi.validateAddress(shipment.destinationAddress);
    if (result.success && result.result) {
      const validationResult: AddressValidationResult = result.result;
      const now = new Date().toISOString();
      const updates: Partial<Shipment> = { addressValidation: validationResult, updatedAt: now };
      if (validationResult.status === 'corrected' && validationResult.suggestedAddress) {
        updates.destinationAddress = validationResult.suggestedAddress;
        validationResult.accepted = true;
      }
      updateShipment(shipmentId, updates);
      setProviderSuccess(
        validationResult.status === 'validated' ? 'Address validated successfully.'
        : validationResult.status === 'corrected' ? 'Address corrected and updated from provider suggestion.'
        : 'Address validation completed.'
      );
    } else {
      const failedValidation: AddressValidationResult = {
        status: 'failed',
        validatedAt: new Date().toISOString(),
        originalAddress: shipment.destinationAddress,
        messages: [result.error?.message || 'Validation failed'],
      };
      updateShipment(shipmentId, { addressValidation: failedValidation, updatedAt: new Date().toISOString() });
      setProviderError(friendlyProviderError(result.error || { code: 'UNKNOWN', message: 'Address validation failed.' }));
    }
    setProviderLoading(null);
  }

  async function handleFetchRates(shipmentId: string) {
    if (isWriteBlocked) return;
    const shipment = shipments.find(s => s.id === shipmentId);
    if (!shipment) return;
    const prereqs = getRatePrerequisites(shipment);
    if (prereqs.length > 0) {
      setProviderError({ code: 'PREREQUISITES', message: `Before getting rates: ${prereqs.join('; ')}.`, retryable: false });
      return;
    }
    clearProviderFeedback();
    setProviderLoading('rates');
    setShowRatesPanel(false);
    setAvailableRates([]);
    const result = await shippingApi.getRates(
      shipment.originAddress,
      shipment.destinationAddress,
      shipment.packages,
    );
    if (result.success && result.rates) {
      const sorted = [...result.rates].sort((a, b) => a.rate - b.rate);
      setAvailableRates(sorted);
      updateShipment(shipmentId, {
        availableRates: sorted,
        ratesRetrievedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      setShowRatesPanel(true);
      setProviderSuccess(`${sorted.length} rate${sorted.length !== 1 ? 's' : ''} retrieved.`);
    } else {
      setProviderError(friendlyProviderError(result.error || { code: 'UNKNOWN', message: 'Rate retrieval failed.' }));
    }
    setProviderLoading(null);
  }

  function handleSelectRate(shipmentId: string, rate: ShippingRate) {
    if (isWriteBlocked) return;
    clearProviderFeedback();
    updateShipment(shipmentId, {
      selectedRate: rate,
      carrier: rate.carrier,
      serviceLevel: rate.serviceName,
      shippingCost: rate.rate,
      estimatedDelivery: rate.estimatedDelivery,
      updatedAt: new Date().toISOString(),
    });
    setShowRatesPanel(false);
    setProviderSuccess(`Selected: ${rate.carrier} ${rate.serviceName} — $${rate.rate.toFixed(2)}`);
  }

  async function handlePurchaseLabel(shipmentId: string) {
    if (isWriteBlocked) return;
    const shipment = shipments.find(s => s.id === shipmentId);
    if (!shipment) return;
    const prereqs = getLabelPrerequisites(shipment);
    if (prereqs.length > 0) {
      setProviderError({ code: 'PREREQUISITES', message: `Before purchasing a label: ${prereqs.join('; ')}.`, retryable: false });
      return;
    }
    clearProviderFeedback();
    setProviderLoading('label');
    const result = await shippingApi.purchaseLabel(
      shipment.originAddress,
      shipment.destinationAddress,
      shipment.packages,
      shipment.selectedRate?.providerRateRef || '',
      shipment.carrier || shipment.selectedRate?.carrier || '',
      shipment.serviceLevel || shipment.selectedRate?.serviceName || '',
      shipment.shipmentNumber,
    );
    if (result.success && result.label) {
      const labelArtifact = { ...result.label };
      const actualFmt = getLabelActualFormat(labelArtifact);
      if (actualFmt !== 'pdf') {
        labelArtifact.originalFormat = actualFmt;
        try {
          const pdfBlobUrl = await convertImageToPdfBlobUrl(labelArtifact.url);
          labelArtifact.pdfUrl = pdfBlobUrl;
          labelArtifact.format = 'pdf';
        } catch {
          labelArtifact.pdfUrl = `/api/shipping/label-proxy?url=${encodeURIComponent(labelArtifact.url)}`;
          labelArtifact.format = actualFmt;
        }
      }
      const now = new Date().toISOString();
      const newEvent: ShipmentEvent = {
        id: `evt-${Date.now()}`,
        timestamp: now,
        status: 'Label Created',
        description: `Label purchased — ${labelArtifact.carrier} ${labelArtifact.service}, tracking: ${labelArtifact.trackingNumber}`,
        performedBy: 'Current User',
      };
      updateShipment(shipmentId, {
        label: labelArtifact,
        labelUrl: labelArtifact.pdfUrl || labelArtifact.url,
        trackingNumber: labelArtifact.trackingNumber,
        carrier: labelArtifact.carrier,
        serviceLevel: labelArtifact.service,
        shippingCost: labelArtifact.cost,
        providerShipmentId: result.providerShipmentId,
        status: 'Label Created',
        events: [...shipment.events, newEvent],
        updatedAt: now,
      });
      setProviderSuccess('Label purchased successfully. Shipment status updated to Label Created.');
    } else {
      setProviderError(friendlyProviderError(result.error || { code: 'UNKNOWN', message: 'Label purchase failed.' }));
    }
    setProviderLoading(null);
  }

  async function loadProviderStatuses() {
    setProviderSettingsLoading(true);
    try {
      const result = await shippingApi.getProvidersStatus();
      setProviderStatuses(result.providers || []);
    } catch { /* ignore */ }
    setProviderSettingsLoading(false);
  }

  function refreshProviderState() {
    shippingApi.getActiveProvider().then(r => {
      setActiveProviderId(r.activeProviderId);
      setProviderEnvironment(r.environment || null);
    });
    loadProviderStatuses();
  }

  async function handleTestConnection(providerId: string) {
    clearProviderFeedback();
    setProviderLoading('test-connection');
    try {
      const result = await shippingApi.testConnection(providerId);
      if (result.success) {
        if (!activeProviderId) {
          try {
            await shippingApi.setActiveProvider(providerId);
          } catch {}
        }
        setProviderSuccess(`Connection to ${providerId} verified successfully.`);
      } else {
        setProviderError({ code: 'TEST_FAILED', message: result.error?.message || 'Connection test failed.', retryable: true });
      }
    } catch (e: any) {
      setProviderError({ code: 'TEST_FAILED', message: e.message || 'Connection test failed.', retryable: true });
    }
    setProviderLoading(null);
    refreshProviderState();
  }

  function copyTrackingNumber(trackingNumber: string) {
    navigator.clipboard.writeText(trackingNumber).then(() => {
      setTrackingCopied(true);
      setTimeout(() => setTrackingCopied(false), 2000);
    });
  }

  async function loadWebhookLog(trackingNumber?: string) {
    setWebhookLogLoading(true);
    try {
      const filters: any = { limit: 50 };
      if (trackingNumber) filters.trackingNumber = trackingNumber;
      if (webhookLogFilter !== 'all') filters.processingResult = webhookLogFilter;
      const result = await shippingApi.getWebhookLog(filters);
      setWebhookLogEntries(result.events || []);
    } catch {
      setWebhookLogEntries([]);
    }
    setWebhookLogLoading(false);
  }

  async function handleReplayEvent(webhookEventId: string) {
    if (isWriteBlocked) return;
    clearProviderFeedback();
    setProviderLoading('replay');
    try {
      const result = await shippingApi.replayWebhookEvent(webhookEventId);
      if (result.success) {
        setProviderSuccess(`Event replayed successfully (replay ID: ${result.replayEventId}).`);
        if (selectedShipment) loadWebhookLog(shipments.find(s => s.id === selectedShipment)?.trackingNumber);
      } else {
        setProviderError(friendlyProviderError(result.error || { code: 'UNKNOWN', message: 'Replay failed.' }));
      }
    } catch (err) {
      setProviderError({ code: 'REPLAY_ERROR', message: err instanceof Error ? err.message : 'Replay failed.' });
    }
    setProviderLoading(null);
  }

  const PROVIDER_STATUS_TO_SHIPMENT: Record<string, ShipmentStatus> = {
    'pre_transit': 'Label Created',
    'accepted': 'Dispatched',
    'in_transit': 'In Transit',
    'out_for_delivery': 'In Transit',
    'delivered': 'Delivered',
    'failure': 'Exception',
    'return_to_sender': 'Exception',
    'returned': 'Returned',
    'error': 'Exception',
    'cancelled': 'Cancelled',
    'available_for_pickup': 'In Transit',
  };

  function applyTrackingStatusToShipment(
    shipment: Shipment,
    events: ProviderTrackingEvent[],
    updates: Partial<Shipment>,
    source: string,
  ) {
    if (!events.length) return;
    const latestEvent = events.reduce((best, e) =>
      new Date(e.timestamp) > new Date(best.timestamp) ? e : best, events[0]);
    const mappedStatus = PROVIDER_STATUS_TO_SHIPMENT[latestEvent.status?.toLowerCase()];
    if (mappedStatus && STATUS_ORDER.indexOf(mappedStatus) > STATUS_ORDER.indexOf(shipment.status)) {
      updates.status = mappedStatus;
      if (mappedStatus === 'Delivered') updates.deliveredAt = updates.updatedAt || new Date().toISOString();
      const syncEvent: ShipmentEvent = {
        id: `evt-${source}-${Date.now()}`,
        timestamp: updates.updatedAt || new Date().toISOString(),
        status: mappedStatus,
        description: `Status updated to ${mappedStatus} via ${source}`,
        performedBy: `System (${source})`,
      };
      updates.events = [...shipment.events, syncEvent];
    }
  }

  async function handleSimulateTrackingEvent(shipmentId: string) {
    if (isWriteBlocked) return;
    const shipment = shipments.find(s => s.id === shipmentId);
    if (!shipment || !shipment.trackingNumber) return;
    clearProviderFeedback();
    setProviderLoading('simulate');
    const result = await shippingApi.simulateTrackingEvent(
      shipment.trackingNumber,
      shipment.carrier || '',
    );
    if (result.success && result.events) {
      const now = new Date().toISOString();
      const incomingEvents = result.events.map(e => ({ ...e, source: 'test_provider' as any }));
      const existingRefs = new Set(
        (shipment.providerTrackingEvents || []).map(e => e.providerEventRef).filter(Boolean)
      );
      const existingTimestampStatus = new Set(
        (shipment.providerTrackingEvents || []).map(e => `${e.timestamp}|${e.status}`)
      );
      const newEvents = incomingEvents.filter(e => {
        if (e.providerEventRef && existingRefs.has(e.providerEventRef)) return false;
        if (existingTimestampStatus.has(`${e.timestamp}|${e.status}`)) return false;
        return true;
      });
      const mergedEvents = [...(shipment.providerTrackingEvents || []), ...newEvents];
      const dupCount = incomingEvents.length - newEvents.length;
      const updates: Partial<Shipment> = {
        providerTrackingEvents: mergedEvents,
        lastTrackingSyncAt: now,
        updatedAt: now,
      };
      applyTrackingStatusToShipment(shipment, mergedEvents, updates, 'Test Provider Simulation');
      updateShipment(shipmentId, updates);
      let msg = `Simulated ${incomingEvents.length} test provider event(s).`;
      if (dupCount > 0) msg += ` ${dupCount} duplicate(s) safely skipped.`;
      if (newEvents.length > 0) msg += ` ${newEvents.length} new event(s) applied.`;
      if (updates.status && updates.status !== shipment.status) msg += ` Status updated: ${shipment.status} → ${updates.status}.`;
      msg += ' These are test data only — no real carrier activity occurred.';
      setProviderSuccess(msg);
    } else {
      setProviderError(friendlyProviderError(result.error || { code: 'UNKNOWN', message: 'Simulation failed.' }));
    }
    setProviderLoading(null);
  }

  const EASYPOST_TEST_TRACKERS = [
    { code: 'EZ1000000001', description: 'Pre-transit → Delivered (standard)' },
    { code: 'EZ2000000002', description: 'Pre-transit → In Transit (stops mid-journey)' },
    { code: 'EZ3000000003', description: 'Pre-transit → Delivered (with return to sender)' },
    { code: 'EZ4000000004', description: 'Pre-transit → Failure' },
    { code: 'EZ5000000005', description: 'Pre-transit → Available for Pickup' },
    { code: 'EZ6000000006', description: 'Pre-transit → Delivered (international)' },
    { code: 'EZ7000000007', description: 'Pre-transit → Out for Delivery → Delivered' },
  ];

  function handleAttachTestTracker(shipmentId: string, testCode: string) {
    if (isWriteBlocked) return;
    const shipment = shipments.find(s => s.id === shipmentId);
    if (!shipment) return;
    clearProviderFeedback();
    const now = new Date().toISOString();
    updateShipment(shipmentId, {
      trackingNumber: testCode,
      updatedAt: now,
    });
    setProviderSuccess(`EasyPost test tracker "${testCode}" attached. You can now use "Sync Tracking" to pull real test tracking data from EasyPost.`);
  }

  async function handleSyncTracking(shipmentId: string) {
    if (isWriteBlocked) return;
    const shipment = shipments.find(s => s.id === shipmentId);
    if (!shipment || !shipment.trackingNumber) return;
    clearProviderFeedback();

    const isEasyPostProvider = activeProviderId?.toLowerCase() === 'easypost';
    if (isEasyPostProvider && providerEnvironment === 'test' && !isEasyPostTestTrackingCode(shipment.trackingNumber)) {
      setProviderWarning(`EasyPost test-mode limitation: "${shipment.trackingNumber}" is not a valid EasyPost test tracking code. In test mode, only EasyPost test codes are supported (EZ1000000001 through EZ7000000007). Use "Attach EasyPost Test Tracker" or "Simulate Provider Events" to test tracking workflows.`);
      if (shipment.syncFailureCount && shipment.syncFailureCount > 0) {
        updateShipment(shipmentId, { syncFailureCount: 0, lastSyncError: undefined, updatedAt: new Date().toISOString() });
      }
      return;
    }

    setProviderLoading('tracking');
    const result = await shippingApi.syncTracking(
      shipment.trackingNumber,
      shipment.carrier || '',
      shipment.providerShipmentId,
    );
    if (result.success) {
      const now = new Date().toISOString();
      const incomingEvents = result.events || [];
      const existingRefs = new Set(
        (shipment.providerTrackingEvents || [])
          .map(e => e.providerEventRef)
          .filter(Boolean)
      );
      const existingTimestampStatus = new Set(
        (shipment.providerTrackingEvents || [])
          .map(e => `${e.timestamp}|${e.status}`)
      );
      const newEvents = incomingEvents.filter(e => {
        if (e.providerEventRef && existingRefs.has(e.providerEventRef)) return false;
        if (existingTimestampStatus.has(`${e.timestamp}|${e.status}`)) return false;
        return true;
      });
      const mergedEvents = [
        ...(shipment.providerTrackingEvents || []),
        ...newEvents,
      ];
      const updates: Partial<Shipment> = {
        providerTrackingEvents: mergedEvents,
        lastTrackingSyncAt: now,
        updatedAt: now,
        syncFailureCount: 0,
        lastSyncError: undefined,
      };
      if (result.estimatedDelivery) updates.estimatedDelivery = result.estimatedDelivery;
      applyTrackingStatusToShipment(shipment, mergedEvents, updates, 'Provider Sync');
      updateShipment(shipmentId, updates);
      const totalEvents = mergedEvents.length;
      const newCount = newEvents.length;
      const dupCount = incomingEvents.length - newCount;
      let successMsg = `Tracking synced. ${totalEvents} total event(s), ${newCount} new`;
      if (dupCount > 0) successMsg += `, ${dupCount} duplicate(s) skipped`;
      successMsg += '.';
      if (updates.status && updates.status !== shipment.status) successMsg += ` Status updated: ${shipment.status} → ${updates.status}.`;
      if (providerEnvironment === 'test') {
        successMsg += ' (Test mode — tracking data may be simulated or limited.)';
      }
      setProviderSuccess(successMsg);
    } else {
      const err = result.error || { code: 'UNKNOWN', message: 'Tracking sync failed.' };
      const isTestModeLimitation = providerEnvironment === 'test' && (
        err.code === 'TRACKER_NOT_FOUND' ||
        err.code === 'NOT_FOUND' ||
        err.code === 'INVALID_TRACKING' ||
        (err.message || '').toLowerCase().includes('not found') ||
        (err.message || '').toLowerCase().includes('no tracking')
      );
      if (isTestModeLimitation) {
        const isEasyPost = activeProviderId?.toLowerCase() === 'easypost';
        const hasNonEzCode = isEasyPost && shipment.trackingNumber && !isEasyPostTestTrackingCode(shipment.trackingNumber);
        if (hasNonEzCode) {
          setProviderWarning(`EasyPost test-mode limitation: "${shipment.trackingNumber}" is not a valid EasyPost test tracking code. In test mode, only EasyPost test codes are supported (EZ1000000001 through EZ7000000007). Use "Attach EasyPost Test Tracker" or "Simulate Provider Events" to test tracking workflows.`);
        } else {
          setProviderWarning('Test-mode limitation: Test tracking numbers may not return real carrier data from the provider. This is expected — use "Simulate Provider Events" to test tracking workflows.');
        }
        if (shipment.syncFailureCount && shipment.syncFailureCount > 0) {
          updateShipment(shipmentId, { syncFailureCount: 0, lastSyncError: undefined, updatedAt: new Date().toISOString() });
        }
      } else {
        const friendlyErr = friendlyProviderError(err);
        if (providerEnvironment === 'test') {
          friendlyErr.message += ' (Test mode — results may differ from production.)';
        }
        setProviderError(friendlyErr);
        const failCount = (shipment.syncFailureCount || 0) + 1;
        updateShipment(shipmentId, {
          syncFailureCount: failCount,
          lastSyncError: err.message,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    setProviderLoading(null);
  }

  function resetCreateForm() {
    setNewCarrier(''); setNewService(''); setNewTracking(''); setNewCost(''); setNewNotes('');
    setNewOrigin({ name: '', line1: '', city: '', state: '', postalCode: '', country: 'US' });
    setNewDest({ name: '', line1: '', city: '', state: '', postalCode: '', country: 'US' });
    setNewSourceType('invoice'); setNewSourceNumber(''); setNewSourceId(''); setNewType('customer_delivery');
    setSourceResolved(null); setSourceResolveError(null);
    setNewPackages([]); setSourceItems([]);
  }

  function openEditModal(s: Shipment) {
    if (!isEditable(s.status)) return;
    setNewCarrier(s.carrier || ''); setNewService(s.serviceLevel || '');
    setNewTracking(s.trackingNumber || ''); setNewCost(s.shippingCost?.toString() || '');
    setNewNotes(s.notes || '');
    setEditPackages([...s.packages]);
    setNewOrigin({ ...s.originAddress });
    setNewDest({ ...s.destinationAddress });
    setEditingShipment(s.id);
  }

  function addPackageRow(target: 'create' | 'edit') {
    const pkg: ShipmentPackage = { id: `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
    if (target === 'create') setNewPackages(prev => [...prev, pkg]);
    else setEditPackages(prev => [...prev, pkg]);
  }

  function updatePackageField(target: 'create' | 'edit', pkgId: string, field: keyof ShipmentPackage, value: string | number | undefined) {
    const updater = (pkgs: ShipmentPackage[]) => pkgs.map(p => p.id === pkgId ? { ...p, [field]: value } : p);
    if (target === 'create') setNewPackages(updater);
    else setEditPackages(updater);
  }

  function removePackage(target: 'create' | 'edit', pkgId: string) {
    if (target === 'create') setNewPackages(prev => prev.filter(p => p.id !== pkgId));
    else setEditPackages(prev => prev.filter(p => p.id !== pkgId));
  }

  function getShipmentMode(shipment: Shipment | null | undefined): 'provider' | 'manual' {
    if (!shipment) return 'provider';
    if (shipment.selectedRate) return 'provider';
    if (shipment.carrier && shipment.serviceLevel) return 'manual';
    return 'provider';
  }

  function hasRateSelected(shipment: Shipment | null | undefined): boolean {
    if (!shipment) return false;
    if (getShipmentMode(shipment) === 'manual') return !!(shipment.carrier && shipment.serviceLevel);
    return !!shipment.selectedRate;
  }

  function getNextStatuses(current: ShipmentStatus, shipment?: Shipment | null): ShipmentStatus[] {
    const mode = getShipmentMode(shipment);
    const isManual = mode === 'manual';

    const transitions: Record<ShipmentStatus, ShipmentStatus[]> = {
      'Draft': ['Ready', 'Cancelled'],
      'Ready': isManual ? ['Packed', 'Dispatched', 'Cancelled'] : ['Cancelled'],
      'Label Created': ['Packed', 'Cancelled'],
      'Packed': ['Dispatched', 'Cancelled'],
      'Dispatched': ['Rejected'],
      'In Transit': ['Rejected'],
      'Delivered': ['Returned'],
      'Exception': ['Rejected', 'Returned'],
      'Rejected': [],
      'Returned': [],
      'Cancelled': [],
    };
    let allowed = transitions[current] || [];

    if (current === 'Draft' && !hasRateSelected(shipment)) {
      allowed = allowed.filter(s => s !== 'Ready');
    }

    if (current === 'Dispatched' && shipment && !hasCarrierAcceptance(shipment)) {
      allowed = ['Packed', 'Cancelled', ...allowed.filter(s => s !== 'Cancelled' && s !== 'Packed')];
    }

    return allowed;
  }

  function canDoTransition(status: ShipmentStatus, newStatus: ShipmentStatus, shipment?: Shipment | null): boolean {
    if (newStatus === 'Cancelled') {
      if (!canCancel) return false;
      if (shipment && hasCarrierAcceptance(shipment)) return false;
      return true;
    }
    if (newStatus === 'Rejected' || newStatus === 'Returned') return canDispatch;
    if (newStatus === 'Dispatched') return canDispatch;
    if (['In Transit', 'Delivered', 'Exception'].includes(newStatus)) return false;
    return canEditPreDispatch;
  }

  if (!canView) {
    return (
      <PageShell title="Shipping Center">
        <div className="bg-white/80 backdrop-blur-xl p-12 rounded-[3rem] border border-slate-200 flex flex-col items-center justify-center text-center">
          <span className="material-symbols-outlined text-4xl text-slate-300 mb-4">lock</span>
          <p className="text-sm font-bold text-slate-400">You do not have permission to view the Shipping Center.</p>
        </div>
      </PageShell>
    );
  }

  const selectedShip = selectedShipment ? shipments.find(s => s.id === selectedShipment) : null;

  function hasCarrierAcceptance(shipment: Shipment): boolean {
    const provEvents = shipment.providerTrackingEvents || [];
    const acceptanceStatuses = ['accepted', 'in_transit', 'out_for_delivery', 'delivered', 'available_for_pickup'];
    return provEvents.some(e => acceptanceStatuses.includes((e.status || '').toLowerCase()));
  }

  function isPostDispatch(status: ShipmentStatus): boolean {
    return ['Dispatched', 'In Transit', 'Delivered', 'Exception', 'Rejected', 'Returned'].includes(status);
  }

  function getLabelActualFormat(label: { format: string; url: string }): 'pdf' | 'png' | 'other' {
    const urlLower = label.url.toLowerCase();
    if (urlLower.includes('.pdf') || urlLower.includes('/pdf') || urlLower.includes('format=pdf')) return 'pdf';
    if (urlLower.includes('.png') || urlLower.includes('/png') || urlLower.includes('format=png')) return 'png';
    if (label.format === 'pdf') return 'pdf';
    if (label.format === 'png') return 'png';
    return (label.format || 'other') as 'pdf' | 'png' | 'other';
  }

  return (
    <PageShell title="Shipping Center">
      <div className="space-y-6">
        <div className="flex items-center gap-1 border-b border-slate-200 mb-2">
          <button
            onClick={() => setActiveTab('shipments')}
            className={`px-4 py-2.5 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all ${activeTab === 'shipments' ? 'text-primary border-primary' : 'text-slate-400 hover:text-slate-600 border-transparent hover:border-slate-300'}`}
          >
            <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">inventory_2</span>Shipments</span>
          </button>
          {canManageProviderSettings && (
            <button
              onClick={() => setActiveTab('settings')}
              className={`px-4 py-2.5 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all ${activeTab === 'settings' ? 'text-primary border-primary' : 'text-slate-400 hover:text-slate-600 border-transparent hover:border-slate-300'}`}
            >
              <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">settings</span>Settings</span>
            </button>
          )}
        </div>
        {activeTab === 'settings' ? (
          <ShippingProvidersPage embedded onProviderChange={refreshProviderState} />
        ) : (<>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="relative flex-1 max-w-md">
              <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg">search</span>
              <input
                type="text"
                placeholder="Search shipments, tracking, recipient..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-11 pr-4 py-3 bg-white/80 backdrop-blur-xl border border-slate-200 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          </div>
          {canCreate && (
            <button
              onClick={() => { resetCreateForm(); setShowCreateModal(true); }}
              className="px-6 py-3 bg-primary text-white font-black text-[10px] uppercase tracking-widest rounded-2xl hover:bg-primary/90 transition-all active:scale-95 flex items-center gap-2 shadow-lg shadow-primary/20"
            >
              <span className="material-symbols-outlined text-sm">add</span>
              New Shipment
            </button>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {(['all', ...STATUS_ORDER] as const).map(status => (
            <button
              key={status}
              onClick={() => setStatusFilter(status as ShipmentStatus | 'all')}
              className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest whitespace-nowrap transition-all ${
                statusFilter === status
                  ? 'bg-primary text-white shadow-lg shadow-primary/20'
                  : 'bg-white/80 text-slate-500 hover:bg-slate-100 border border-slate-200'
              }`}
            >
              {status === 'all' ? 'All' : status} {statusCounts[status] ? `(${statusCounts[status]})` : ''}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          {(['all', 'invoice', 'repair', 'transfer', 'rma'] as const).map(src => (
            <button
              key={src}
              onClick={() => setSourceFilter(src as ShipmentSourceType | 'all')}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                sourceFilter === src
                  ? 'bg-slate-800 text-white'
                  : 'bg-white/60 text-slate-400 hover:text-slate-600 border border-slate-200'
              }`}
            >
              {src === 'all' ? 'All Sources' : SOURCE_LABELS[src]}
            </button>
          ))}
        </div>

        <div className="bg-white/80 backdrop-blur-xl rounded-[2.5rem] border border-slate-200 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center py-16">
              <span className="material-symbols-outlined text-4xl text-slate-300 mb-3">local_shipping</span>
              <p className="text-sm font-bold text-slate-400">No shipments found</p>
              <p className="text-xs text-slate-400 mt-1">Create a new shipment or adjust your filters</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filtered.map(s => (
                <div
                  key={s.id}
                  onClick={() => { setSelectedShipment(s.id); setDetailTab('overview'); setShowTestTrackerMenu(false); }}
                  className="px-8 py-5 hover:bg-slate-50/80 cursor-pointer transition-all flex items-center gap-6"
                >
                  <div className="w-10 h-10 rounded-2xl bg-primary/5 flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-primary text-lg">{SOURCE_ICONS[s.sourceType]}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <span className="text-sm font-black text-slate-800">{s.shipmentNumber}</span>
                      <span className={`px-2.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded-lg border ${STATUS_COLORS[s.status]}`}>{s.status}</span>
                      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{TYPE_LABELS[s.type]}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">{SOURCE_ICONS[s.sourceType]}</span>
                        {s.sourceNumber}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">person</span>
                        {s.destinationAddress.name}
                      </span>
                      {s.carrier && <span className="flex items-center gap-1"><span className="material-symbols-outlined text-xs">local_shipping</span>{s.carrier}</span>}
                      {s.trackingNumber && <span className="font-mono text-[10px] text-slate-400 select-all break-all">{s.trackingNumber}</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {canViewCosts && s.shippingCost !== undefined && (
                      <p className="text-sm font-black text-primary">${s.shippingCost.toFixed(2)}</p>
                    )}
                    <p className="text-[10px] text-slate-400">{formatDate(s.createdAt)}</p>
                  </div>
                  <span className="material-symbols-outlined text-slate-300 text-lg">chevron_right</span>
                </div>
              ))}
            </div>
          )}
        </div>
        </>)}
      </div>

      <AnimatePresence>
        {selectedShip && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-3xl overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                <div>
                  <div className="flex items-center gap-3 mb-1">
                    <h2 className="text-xl font-black text-primary">{selectedShip.shipmentNumber}</h2>
                    <span className={`px-3 py-1 text-[10px] font-black uppercase tracking-widest rounded-lg border ${STATUS_COLORS[selectedShip.status]}`}>{selectedShip.status}</span>
                  </div>
                  <p className="text-sm text-slate-500">{TYPE_LABELS[selectedShip.type]} · {SOURCE_LABELS[selectedShip.sourceType]} {selectedShip.sourceNumber}</p>
                </div>
                <div className="flex items-center gap-2">
                  {canEditPreDispatch && isEditable(selectedShip.status) && (
                    <button onClick={(e) => { e.stopPropagation(); openEditModal(selectedShip); }} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary transition-all">
                      <span className="material-symbols-outlined text-lg">edit</span>
                    </button>
                  )}
                  {canEditPreDispatch && !isEditable(selectedShip.status) && selectedShip.status !== 'Cancelled' && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl" title="Shipment editing is locked after Label Created">
                      <span className="material-symbols-outlined text-slate-400 text-sm">lock</span>
                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Edit Locked</span>
                    </div>
                  )}
                  <button onClick={() => setSelectedShipment(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              </div>

              <div className="flex border-b border-slate-100 bg-slate-50/30 shrink-0">
                {(['overview', 'tracking', 'packages'] as const).map(tab => (
                  <button key={tab} onClick={() => { setDetailTab(tab); setShowTestTrackerMenu(false); }} className={`flex-1 py-3.5 text-[10px] font-black uppercase tracking-widest transition-all ${detailTab === tab ? 'text-primary border-b-2 border-primary bg-white/50' : 'text-slate-400 hover:text-slate-600'}`}>
                    {tab === 'overview' ? 'Overview' : tab === 'tracking' ? 'Tracking & Events' : 'Packages'}
                  </button>
                ))}
              </div>

              <div className="p-8 overflow-y-auto flex-1 space-y-6">
                {detailTab === 'overview' && (
                  <>
                    <div className="grid grid-cols-2 gap-6">
                      <div className="bg-slate-50 rounded-2xl p-5 space-y-3">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><span className="material-symbols-outlined text-xs">location_on</span>Origin</p>
                        <div className="text-sm text-slate-700 space-y-0.5">
                          <p className="font-black">{selectedShip.originAddress.name}</p>
                          {selectedShip.originAddress.company && <p className="text-slate-500">{selectedShip.originAddress.company}</p>}
                          <p>{selectedShip.originAddress.line1}</p>
                          {selectedShip.originAddress.line2 && <p>{selectedShip.originAddress.line2}</p>}
                          <p>{selectedShip.originAddress.city}, {selectedShip.originAddress.state} {selectedShip.originAddress.postalCode}</p>
                          {selectedShip.originAddress.phone && <p className="text-slate-400 text-xs">{selectedShip.originAddress.phone}</p>}
                        </div>
                      </div>
                      <div className="bg-slate-50 rounded-2xl p-5 space-y-3">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><span className="material-symbols-outlined text-xs">flag</span>Destination</p>
                        <div className="text-sm text-slate-700 space-y-0.5">
                          <p className="font-black">{selectedShip.destinationAddress.name}</p>
                          {selectedShip.destinationAddress.company && <p className="text-slate-500">{selectedShip.destinationAddress.company}</p>}
                          <p>{selectedShip.destinationAddress.line1}</p>
                          {selectedShip.destinationAddress.line2 && <p>{selectedShip.destinationAddress.line2}</p>}
                          <p>{selectedShip.destinationAddress.city}, {selectedShip.destinationAddress.state} {selectedShip.destinationAddress.postalCode}</p>
                          {selectedShip.destinationAddress.phone && <p className="text-slate-400 text-xs">{selectedShip.destinationAddress.phone}</p>}
                          {selectedShip.destinationAddress.email && <p className="text-slate-400 text-xs">{selectedShip.destinationAddress.email}</p>}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      {selectedShip.carrier && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Carrier</span><span className="text-xs font-black text-slate-700">{selectedShip.carrier}</span></div>
                      )}
                      {selectedShip.serviceLevel && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Service</span><span className="text-xs font-black text-slate-700">{selectedShip.serviceLevel}</span></div>
                      )}
                      {selectedShip.trackingNumber && (
                        <div className="flex justify-between py-2 border-b border-slate-100">
                          <span className="text-xs text-slate-400 font-bold">Tracking</span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-black text-slate-700 font-mono select-all break-all">{selectedShip.trackingNumber}</span>
                            <button onClick={() => copyTrackingNumber(selectedShip.trackingNumber!)} title="Copy tracking number"
                              className="p-0.5 hover:bg-slate-100 rounded transition-all">
                              <span className="material-symbols-outlined text-xs text-slate-400 hover:text-slate-600">
                                {trackingCopied ? 'check' : 'content_copy'}
                              </span>
                            </button>
                          </div>
                        </div>
                      )}
                      {canViewCosts && selectedShip.shippingCost !== undefined && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Cost</span><span className="text-xs font-black text-primary">${selectedShip.shippingCost.toFixed(2)}</span></div>
                      )}
                      {selectedShip.estimatedDelivery && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Est. Delivery</span><span className="text-xs font-black text-slate-700">{formatDate(selectedShip.estimatedDelivery)}</span></div>
                      )}
                      <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Created</span><span className="text-xs font-black text-slate-700">{formatDateTime(selectedShip.createdAt)}</span></div>
                      {selectedShip.dispatchedAt && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Dispatched</span><span className="text-xs font-black text-slate-700">{formatDateTime(selectedShip.dispatchedAt)}</span></div>
                      )}
                      {selectedShip.deliveredAt && (
                        <div className="flex justify-between py-2 border-b border-slate-100"><span className="text-xs text-slate-400 font-bold">Delivered</span><span className="text-xs font-black text-emerald-600">{formatDateTime(selectedShip.deliveredAt)}</span></div>
                      )}
                    </div>

                    {selectedShip.notes && (
                      <div className="bg-amber-50 rounded-xl p-4 border border-amber-100">
                        <p className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-1">Notes</p>
                        <p className="text-xs text-amber-800">{selectedShip.notes}</p>
                      </div>
                    )}

                    {(() => {
                      const shipMode = getShipmentMode(selectedShip);
                      const isManualMode = shipMode === 'manual';
                      return (
                    <div className={`rounded-2xl p-5 border space-y-4 ${isManualMode ? 'bg-slate-50/50 border-slate-200' : 'bg-indigo-50/50 border-indigo-100'}`}>
                      <div className="flex items-center justify-between">
                        <p className={`text-[10px] font-black uppercase tracking-widest flex items-center gap-1 ${isManualMode ? 'text-slate-500' : 'text-indigo-500'}`}>
                          <span className="material-symbols-outlined text-xs">{isManualMode ? 'edit_note' : 'hub'}</span>
                          {isManualMode ? 'Manual Mode' : 'Provider & Operations'}
                        </p>
                        <div className="flex items-center gap-2">
                          {isManualMode ? (
                            <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest bg-slate-200 text-slate-600 rounded-md">Manual</span>
                          ) : activeProviderId ? (() => {
                            const activePs = providerStatuses.find((ps: any) => ps.providerId === activeProviderId);
                            const testResult = activePs?.lastTestResult;
                            return (
                            <>
                              <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest bg-indigo-100 text-indigo-600 rounded-md">{activeProviderId}</span>
                              <span className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md ${providerEnvironment === 'test' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                {providerEnvironment === 'test' ? 'Test Mode' : 'Live'}
                              </span>
                              {testResult === 'success' && (
                                <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest bg-emerald-100 text-emerald-600 rounded-md">Verified</span>
                              )}
                              {testResult === 'failed' && (
                                <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest bg-red-100 text-red-600 rounded-md">Failed</span>
                              )}
                            </>
                            );
                          })() : (
                            <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest bg-slate-100 text-slate-400 rounded-md">No Provider</span>
                          )}
                          {!isManualMode && canManageProviderSettings && (
                          <button
                            onClick={() => { setShowProviderSettings(!showProviderSettings); if (!showProviderSettings) loadProviderStatuses(); }}
                            className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md transition-all flex items-center gap-0.5 ${showProviderSettings ? 'bg-indigo-100 text-indigo-700' : 'text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50'}`}
                            title="Provider settings"
                          >
                            <span className="material-symbols-outlined text-xs">{showProviderSettings ? 'expand_less' : 'settings'}</span>
                            {showProviderSettings ? 'Hide Settings' : 'Provider Settings'}
                          </button>
                          )}
                          {!isManualMode && canManageProviderSettings && (
                          <button
                            onClick={() => { setShowWebhookLog(!showWebhookLog); if (!showWebhookLog) loadWebhookLog(selectedShip.trackingNumber || undefined); }}
                            className={`px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md transition-all flex items-center gap-0.5 ${showWebhookLog ? 'bg-violet-100 text-violet-700' : 'text-violet-500 hover:text-violet-700 hover:bg-violet-50'}`}
                            title="Webhook event log"
                          >
                            <span className="material-symbols-outlined text-xs">{showWebhookLog ? 'expand_less' : 'webhook'}</span>
                            {showWebhookLog ? 'Hide Log' : 'Webhook Log'}
                          </button>
                          )}
                        </div>
                      </div>

                      {providerError && (
                        <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                          <span className="material-symbols-outlined text-red-500 text-sm mt-0.5">error</span>
                          <div>
                            <p className="text-xs text-red-600 font-medium">{providerError.message}</p>
                            {providerError.retryable && <p className="text-[10px] text-red-400 mt-0.5">This error may be temporary. You can retry.</p>}
                          </div>
                        </div>
                      )}
                      {providerWarning && (
                        <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
                          <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">info</span>
                          <p className="text-xs text-amber-700 font-medium">{providerWarning}</p>
                        </div>
                      )}
                      {providerSuccess && (
                        <div className="px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-2">
                          <span className="material-symbols-outlined text-emerald-500 text-sm mt-0.5">check_circle</span>
                          <p className="text-xs text-emerald-700 font-medium">{providerSuccess}</p>
                        </div>
                      )}

                      {isManualMode && (
                        <div className="px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg flex items-start gap-2">
                          <span className="material-symbols-outlined text-slate-500 text-sm mt-0.5">edit_note</span>
                          <div>
                            <p className="text-xs text-slate-700 font-medium">Manual Shipment Mode</p>
                            <p className="text-[10px] text-slate-500 mt-0.5">
                              {activeProviderId
                                ? 'The shipping provider is active, but because carrier and service level were entered manually, this shipment is in manual mode. Provider-backed actions (address validation, rates, label purchase, tracking sync) are disabled for this shipment. Clear manual carrier and service level values to use provider features.'
                                : 'Carrier and service level were set manually. Provider-backed actions are not available.'}
                            </p>
                          </div>
                        </div>
                      )}

                      {!isManualMode && providerEnvironment === 'test' && activeProviderId && (
                        <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
                          <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">science</span>
                          <div>
                            <p className="text-xs text-amber-700 font-medium">Test Mode Active</p>
                            <p className="text-[10px] text-amber-600 mt-0.5">Labels, rates, and tracking use test credentials. No real charges will be made. Switch to production credentials in Provider Settings for live shipments.</p>
                          </div>
                        </div>
                      )}

                      {!isManualMode && showProviderSettings && canManageProviderSettings && (
                        <div className="bg-white rounded-xl border border-indigo-200 p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <p className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">Provider Configuration</p>
                            {providerSettingsLoading && <span className="material-symbols-outlined text-xs text-indigo-400 animate-spin">progress_activity</span>}
                          </div>
                          {providerStatuses.length === 0 && !providerSettingsLoading && (
                            <p className="text-xs text-slate-500">No providers configured. Go to full settings to add carrier API credentials.</p>
                          )}
                          {providerStatuses.map(ps => (
                            <div key={ps.providerId} className={`flex items-center justify-between p-3 rounded-lg border ${ps.isActive ? 'border-indigo-200 bg-indigo-50/50' : 'border-slate-100 bg-slate-50/50'}`}>
                              <div className="flex items-center gap-2">
                                <span className={`w-2 h-2 rounded-full ${ps.isActive ? 'bg-indigo-500' : 'bg-slate-300'}`} />
                                <span className="text-xs font-black text-slate-700 capitalize">{ps.providerId}</span>
                                {ps.isActive && <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest bg-indigo-100 text-indigo-600 rounded">Active</span>}
                                {ps.environment && (
                                  <span className={`px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest rounded ${ps.environment === 'test' ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600'}`}>
                                    {ps.environment === 'test' ? 'Test' : 'Live'}
                                  </span>
                                )}
                                {ps.lastTestResult === 'success' && (
                                  <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest bg-emerald-100 text-emerald-600 rounded">Verified</span>
                                )}
                                {ps.lastTestResult === 'failed' && (
                                  <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest bg-red-100 text-red-600 rounded">Failed</span>
                                )}
                                {!ps.lastTestResult && (
                                  <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest bg-slate-100 text-slate-400 rounded">Not Tested</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {ps.maskedCredentials && Object.values(ps.maskedCredentials).some(Boolean) && (
                                  <span className="text-[9px] text-slate-400">Credentials set</span>
                                )}
                                <button onClick={() => handleTestConnection(ps.providerId)} disabled={providerLoading !== null}
                                  className="px-2 py-1 text-[9px] font-bold text-indigo-500 hover:bg-indigo-50 rounded transition-all disabled:opacity-40">
                                  {providerLoading === 'test-connection' ? 'Testing...' : 'Test'}
                                </button>
                              </div>
                            </div>
                          ))}
                          <button onClick={() => navigate('/shipping/settings')}
                            className="w-full py-2 text-[10px] font-black uppercase tracking-widest text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50 rounded-lg border border-dashed border-indigo-200 transition-all flex items-center justify-center gap-1">
                            <span className="material-symbols-outlined text-xs">settings</span>
                            Shipping Settings — Providers
                          </button>
                        </div>
                      )}

                      {showWebhookLog && canManageProviderSettings && (
                        <div className="bg-white rounded-xl border border-violet-200 p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <p className="text-[10px] font-black text-violet-600 uppercase tracking-widest">Webhook Event Log</p>
                            <div className="flex items-center gap-2">
                              <select value={webhookLogFilter} onChange={e => { setWebhookLogFilter(e.target.value); }}
                                className="text-[10px] border border-violet-200 rounded px-1.5 py-0.5 text-violet-700 bg-violet-50">
                                <option value="all">All</option>
                                <option value="processed">Processed</option>
                                <option value="ignored">Ignored</option>
                                <option value="duplicate">Duplicate</option>
                                <option value="failed">Failed</option>
                              </select>
                              <button onClick={() => loadWebhookLog(selectedShip.trackingNumber || undefined)} disabled={webhookLogLoading}
                                className="text-[10px] font-bold text-violet-500 hover:text-violet-700 disabled:opacity-40">
                                {webhookLogLoading ? 'Loading...' : 'Refresh'}
                              </button>
                            </div>
                          </div>
                          {webhookLogEntries.length === 0 && !webhookLogLoading && (
                            <p className="text-xs text-slate-400 text-center py-4">No webhook events recorded yet.</p>
                          )}
                          {webhookLogLoading && (
                            <div className="flex items-center justify-center py-4">
                              <span className="material-symbols-outlined text-sm text-violet-400 animate-spin">progress_activity</span>
                            </div>
                          )}
                          <div className="space-y-1.5 max-h-60 overflow-y-auto">
                            {webhookLogEntries.map((entry: any) => (
                              <div key={entry.id} className={`p-2.5 rounded-lg border text-[10px] ${
                                entry.processingResult === 'failed' ? 'border-red-200 bg-red-50/50' :
                                entry.processingResult === 'duplicate' ? 'border-amber-200 bg-amber-50/50' :
                                entry.processingResult === 'ignored' ? 'border-slate-200 bg-slate-50/50' :
                                'border-violet-100 bg-violet-50/30'
                              }`}>
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-black text-slate-700">{entry.eventType}</span>
                                    <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest ${
                                      entry.processingResult === 'processed' ? 'bg-emerald-100 text-emerald-600' :
                                      entry.processingResult === 'failed' ? 'bg-red-100 text-red-600' :
                                      entry.processingResult === 'duplicate' ? 'bg-amber-100 text-amber-600' :
                                      'bg-slate-100 text-slate-500'
                                    }`}>{entry.processingResult}</span>
                                    {entry.source !== 'webhook' && (
                                      <span className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest bg-blue-100 text-blue-600">{entry.source}</span>
                                    )}
                                    {entry.isTestMode && (
                                      <span className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest bg-amber-100 text-amber-600">Test</span>
                                    )}
                                    {entry.signatureVerified && (
                                      <span className="material-symbols-outlined text-emerald-500 text-xs" title="Signature verified">verified</span>
                                    )}
                                  </div>
                                  {canManageProviderSettings && entry.processingResult === 'failed' && (
                                    <button onClick={() => handleReplayEvent(entry.id)} disabled={providerLoading === 'replay'}
                                      className="px-2 py-0.5 text-[9px] font-bold text-violet-500 hover:bg-violet-100 rounded transition-all disabled:opacity-40">
                                      Replay
                                    </button>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 mt-1 text-slate-400">
                                  <span>{entry.providerId}</span>
                                  {entry.trackingNumber && <span className="font-mono">{entry.trackingNumber}</span>}
                                  {entry.mappedStatus && <span>→ {entry.mappedStatus}</span>}
                                  <span>{new Date(entry.receivedAt).toLocaleString()}</span>
                                  {entry.retryCount > 0 && <span className="text-amber-500">retry #{entry.retryCount}</span>}
                                </div>
                                {entry.processingError && (
                                  <p className="text-red-500 mt-1">{entry.processingError}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {(selectedShip.syncFailureCount || 0) > 0 && (
                        <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                          <span className="material-symbols-outlined text-red-500 text-sm mt-0.5">sync_problem</span>
                          <div>
                            <p className="text-xs text-red-600 font-medium">Tracking sync failed ({selectedShip.syncFailureCount} attempt{selectedShip.syncFailureCount === 1 ? '' : 's'})</p>
                            {selectedShip.lastSyncError && <p className="text-[10px] text-red-400 mt-0.5">{selectedShip.lastSyncError}</p>}
                          </div>
                        </div>
                      )}

                      {selectedShip.addressValidation && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-400 font-bold">Address</span>
                          <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest ${
                            selectedShip.addressValidation.status === 'validated' ? 'bg-emerald-100 text-emerald-700' :
                            selectedShip.addressValidation.status === 'corrected' ? 'bg-blue-100 text-blue-700' :
                            selectedShip.addressValidation.status === 'failed' ? 'bg-red-100 text-red-700' :
                            'bg-slate-100 text-slate-500'
                          }`}>{selectedShip.addressValidation.status}</span>
                          {selectedShip.addressValidation.validatedAt && <span className="text-[10px] text-slate-400">{formatDateTime(selectedShip.addressValidation.validatedAt)}</span>}
                        </div>
                      )}

                      {selectedShip.selectedRate && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-400 font-bold">Service</span>
                          <span className="font-black text-slate-700">{selectedShip.selectedRate.carrier} {selectedShip.selectedRate.serviceName}</span>
                          <span className="font-black text-primary">${selectedShip.selectedRate.rate.toFixed(2)}</span>
                          {selectedShip.selectedRate.estimatedDays && <span className="text-slate-400">({selectedShip.selectedRate.estimatedDays}d)</span>}
                        </div>
                      )}

                      {!selectedShip.selectedRate && isManualMode && selectedShip.carrier && selectedShip.serviceLevel && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-400 font-bold">Manual Service</span>
                          <span className="font-black text-slate-700">{selectedShip.carrier} {selectedShip.serviceLevel}</span>
                          <span className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest bg-slate-200 text-slate-500 rounded">Manual</span>
                        </div>
                      )}

                      {selectedShip.label && (() => {
                        const lbl = selectedShip.label!;
                        const displayFmt = lbl.pdfUrl ? 'pdf' : getLabelActualFormat(lbl);
                        return (
                        <div className="flex items-center gap-2 text-xs flex-wrap">
                          <span className="text-slate-400 font-bold">Label</span>
                          <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-md text-[10px] font-black uppercase tracking-widest">Purchased</span>
                          <span className="text-slate-500 font-mono text-[10px]">{lbl.trackingNumber}</span>
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-widest bg-red-100 text-red-600">{displayFmt.toUpperCase()}</span>
                        </div>
                        );
                      })()}

                      {selectedShip.providerShipmentId && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-400 font-bold">Provider Ref</span>
                          <span className="text-slate-500 font-mono text-[10px]">{selectedShip.providerShipmentId}</span>
                        </div>
                      )}

                      {selectedShip.lastTrackingSyncAt && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-400 font-bold">Last Sync</span>
                          <span className="text-slate-500 text-[10px]">{formatDateTime(selectedShip.lastTrackingSyncAt)}</span>
                        </div>
                      )}

                      <div className="flex gap-2 flex-wrap pt-1">
                        {!isManualMode && canValidateAddress && !isWriteBlocked && isEditable(selectedShip.status) && !selectedShip.label && (
                          <button onClick={() => handleValidateAddress(selectedShip.id)} disabled={providerLoading !== null}
                            className="px-3 py-2 bg-white text-indigo-600 border border-indigo-200 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-50 transition-all disabled:opacity-40 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">{providerLoading === 'validate' ? 'hourglass_top' : 'verified'}</span>
                            {providerLoading === 'validate' ? 'Validating...' : 'Validate Address'}
                          </button>
                        )}

                        {!isManualMode && canFetchRates && !isWriteBlocked && ['Draft', 'Ready'].includes(selectedShip.status) && (() => {
                          const ratePrereqs = getRatePrerequisites(selectedShip);
                          const disabled = providerLoading !== null || ratePrereqs.length > 0;
                          return (
                            <div className="relative group">
                              <button onClick={() => handleFetchRates(selectedShip.id)} disabled={disabled}
                                className="px-3 py-2 bg-white text-indigo-600 border border-indigo-200 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-50 transition-all disabled:opacity-40 flex items-center gap-1"
                                title={ratePrereqs.length > 0 ? ratePrereqs.join(', ') : 'Get shipping rates from provider'}>
                                <span className="material-symbols-outlined text-sm">{providerLoading === 'rates' ? 'hourglass_top' : 'request_quote'}</span>
                                {providerLoading === 'rates' ? 'Fetching...' : 'Get Rates'}
                              </button>
                              {ratePrereqs.length > 0 && (
                                <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-10">
                                  <div className="bg-slate-800 text-white text-[10px] rounded-lg px-3 py-2 whitespace-nowrap shadow-lg">
                                    {ratePrereqs.map((p, i) => <div key={i}>• {p}</div>)}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {!isManualMode && canPurchaseLabel && !isWriteBlocked && selectedShip.status === 'Ready' && !selectedShip.label && (() => {
                          const labelPrereqs = getLabelPrerequisites(selectedShip);
                          const disabled = providerLoading !== null || labelPrereqs.length > 0;
                          return (
                            <div className="relative group">
                              <button onClick={() => handlePurchaseLabel(selectedShip.id)} disabled={disabled}
                                className="px-3 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all disabled:opacity-40 flex items-center gap-1 shadow-sm"
                                title={labelPrereqs.length > 0 ? labelPrereqs.join(', ') : 'Purchase shipping label'}>
                                <span className="material-symbols-outlined text-sm">{providerLoading === 'label' ? 'hourglass_top' : 'receipt'}</span>
                                {providerLoading === 'label' ? 'Purchasing...' : 'Purchase Label'}
                              </button>
                              {labelPrereqs.length > 0 && (
                                <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-10">
                                  <div className="bg-slate-800 text-white text-[10px] rounded-lg px-3 py-2 whitespace-nowrap shadow-lg">
                                    {labelPrereqs.map((p, i) => <div key={i}>• {p}</div>)}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {canPrintLabel && selectedShip.label?.url && (() => {
                          const label = selectedShip.label!;
                          const primaryUrl = label.pdfUrl || label.url;
                          const hasPdf = !!label.pdfUrl || getLabelActualFormat(label) === 'pdf';
                          return (
                          <div className="flex items-center gap-2">
                            <button onClick={() => {
                              const printWin = window.open(primaryUrl, '_blank');
                              if (printWin && hasPdf) { printWin.addEventListener('load', () => { try { printWin.print(); } catch {} }); }
                            }}
                              className="px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1 bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90">
                              <span className="material-symbols-outlined text-sm">print</span>
                              Print PDF Label
                            </button>
                            <button onClick={() => window.open(primaryUrl, '_blank')}
                              className="px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1 bg-white text-slate-600 border border-slate-200 hover:bg-slate-50">
                              <span className="material-symbols-outlined text-sm">picture_as_pdf</span>
                              View
                            </button>
                          </div>
                          );
                        })()}

                        {!isManualMode && canSyncTracking && !isWriteBlocked && selectedShip.trackingNumber && !['Draft', 'Ready', 'Delivered', 'Cancelled'].includes(selectedShip.status) && (
                          <button onClick={() => handleSyncTracking(selectedShip.id)} disabled={providerLoading !== null}
                            className="px-3 py-2 bg-white text-sky-600 border border-sky-200 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-sky-50 transition-all disabled:opacity-40 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">{providerLoading === 'tracking' ? 'hourglass_top' : 'sync'}</span>
                            {providerLoading === 'tracking' ? 'Syncing...' : 'Sync Tracking'}
                          </button>
                        )}
                      </div>
                    </div>
                      ); })()}

                    {showRatesPanel && availableRates.length > 0 && (
                      <div className="bg-sky-50/50 rounded-2xl p-5 border border-sky-100 space-y-3">
                        <div className="flex justify-between items-center">
                          <p className="text-[10px] font-black text-sky-600 uppercase tracking-widest flex items-center gap-1"><span className="material-symbols-outlined text-xs">local_offer</span>Available Rates</p>
                          <button onClick={() => setShowRatesPanel(false)} className="text-slate-400 hover:text-slate-600"><span className="material-symbols-outlined text-sm">close</span></button>
                        </div>
                        <div className="space-y-2">
                          {availableRates.map(rate => (
                            <div key={rate.id} className="flex items-center justify-between bg-white rounded-xl p-3 border border-sky-100 hover:border-primary/30 transition-all">
                              <div>
                                <p className="text-xs font-black text-slate-700">{rate.carrier} — {rate.serviceName}</p>
                                <p className="text-[10px] text-slate-400">
                                  {rate.estimatedDays ? `${rate.estimatedDays} day${rate.estimatedDays !== 1 ? 's' : ''}` : 'Delivery estimate N/A'}
                                  {rate.isGuaranteed && ' · Guaranteed'}
                                </p>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="text-sm font-black text-primary">${rate.rate.toFixed(2)}</span>
                                {!isWriteBlocked && (
                                  <button onClick={() => handleSelectRate(selectedShip.id, rate)}
                                    className="px-3 py-1.5 bg-primary text-white rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-primary/90 transition-all">
                                    Select
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {isPostDispatch(selectedShip.status) && (
                      <div className="px-3 py-2 bg-sky-50 border border-sky-200 rounded-lg flex items-start gap-2">
                        <span className="material-symbols-outlined text-sky-500 text-sm mt-0.5">info</span>
                        <div>
                          <p className="text-xs text-sky-700 font-medium">Post-dispatch status control</p>
                          <p className="text-[10px] text-sky-600 mt-0.5">
                            {selectedShip.status === 'Dispatched' && !hasCarrierAcceptance(selectedShip)
                              ? 'Shipment dispatched. Status updates (In Transit, Delivered, Exception) will be driven by carrier tracking events via Sync Tracking. Cancellation is available until the carrier accepts the package. You may mark the shipment as Rejected by Carrier if applicable.'
                              : selectedShip.status === 'Dispatched' && hasCarrierAcceptance(selectedShip)
                                ? 'Carrier has accepted the package. Status updates are now provider-driven only. Cancellation is no longer available. You may mark as Rejected by Carrier if applicable.'
                                : selectedShip.status === 'Rejected'
                                  ? 'This shipment was rejected by the carrier. No further transitions are available.'
                                  : selectedShip.status === 'Returned'
                                    ? 'This shipment has been returned. No further transitions are available.'
                                    : selectedShip.status === 'Delivered'
                                      ? 'Shipment delivered. You may mark as Returned if the package was sent back.'
                                      : selectedShip.status === 'Exception'
                                        ? 'An exception occurred. You may mark as Rejected by Carrier or Returned if applicable.'
                                        : `Status "${selectedShip.status}" is managed by carrier tracking events. Use Sync Tracking to get the latest carrier updates.`
                            }
                          </p>
                        </div>
                      </div>
                    )}

                    {selectedShip.status === 'Draft' && !hasRateSelected(selectedShip) && (
                      <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl">
                        <span className="material-symbols-outlined text-amber-500 text-sm">info</span>
                        <span className="text-[10px] font-bold text-amber-700">
                          {getShipmentMode(selectedShip) === 'manual'
                            ? 'Set carrier and service level (via Edit) before marking as Ready'
                            : 'Select a shipping rate or set carrier/service manually before marking as Ready'}
                        </span>
                      </div>
                    )}
                    {getNextStatuses(selectedShip.status, selectedShip).length > 0 && (
                      <div className="flex gap-2 flex-wrap">
                        {getNextStatuses(selectedShip.status, selectedShip).map(next => (
                          canDoTransition(selectedShip.status, next, selectedShip) && (
                            <button
                              key={next}
                              onClick={() => {
                                if (next === 'Rejected' || next === 'Returned') {
                                  setReasonModal({ id: selectedShip.id, newStatus: next });
                                } else {
                                  setShowStatusConfirm({ id: selectedShip.id, newStatus: next, label: `Move shipment to "${next}"?` });
                                }
                              }}
                              className={`px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95 ${
                                next === 'Cancelled'
                                  ? 'bg-red-50 text-red-600 border border-red-200 hover:bg-red-100'
                                  : next === 'Rejected'
                                    ? 'bg-orange-50 text-orange-600 border border-orange-200 hover:bg-orange-100'
                                    : next === 'Returned'
                                      ? 'bg-pink-50 text-pink-600 border border-pink-200 hover:bg-pink-100'
                                      : next === 'Dispatched'
                                        ? 'bg-primary text-white shadow-lg shadow-primary/20 hover:bg-primary/90'
                                        : next === 'Delivered'
                                          ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-600'
                                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                              }`}
                            >
                              {next}
                            </button>
                          )
                        ))}
                      </div>
                    )}
                  </>
                )}

                {detailTab === 'tracking' && (() => {
                  const manualEvents = [...selectedShip.events].map(e => ({ ...e, _source: 'manual' as const }));
                  const rawProviderEvents = selectedShip.providerTrackingEvents || [];
                  const isTestProvider = providerEnvironment === 'test';
                  const hasTestEvents = rawProviderEvents.some((e: any) => e.source === 'test_provider' || e.description?.startsWith('[TEST]'));
                  const providerEvents = rawProviderEvents.map(e => ({
                    id: e.id,
                    timestamp: e.timestamp,
                    status: e.status,
                    description: e.description,
                    location: e.location,
                    performedBy: undefined as string | undefined,
                    _source: ((e as any).source === 'test_provider' || e.description?.startsWith('[TEST]')) ? 'test_provider' as const
                      : (e as any).source === 'webhook' ? 'webhook' as const
                      : (e as any).source === 'replay' ? 'replay' as const
                      : 'provider' as const,
                    _processingResult: (e as any).processingResult as string | undefined,
                    _webhookEventId: (e as any).webhookEventId as string | undefined,
                    _receivedAt: (e as any).receivedAt as string | undefined,
                  }));
                  const allEvents = [...manualEvents, ...providerEvents]
                    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
                  const hasProviderEvents = providerEvents.length > 0;
                  return (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      {canUpdateTracking && !isPostDispatch(selectedShip.status) && selectedShip.status !== 'Cancelled' && (
                        <button onClick={() => { setEventDescription(''); setEventLocation(''); setAddEventModal(selectedShip.id); }} className="px-4 py-2.5 bg-primary/10 text-primary font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-primary/20 transition-all flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">add</span>Add Event
                        </button>
                      )}
                      {getShipmentMode(selectedShip) !== 'manual' && canSyncTracking && isTestProvider && activeProviderId && selectedShip.trackingNumber && !isWriteBlocked && (
                        <button onClick={() => handleSimulateTrackingEvent(selectedShip.id)} disabled={providerLoading !== null}
                          className="px-4 py-2.5 bg-amber-50 text-amber-700 border border-amber-200 font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-amber-100 transition-all disabled:opacity-40 flex items-center gap-1">
                          <span className="material-symbols-outlined text-sm">{providerLoading === 'simulate' ? 'hourglass_top' : 'science'}</span>
                          {providerLoading === 'simulate' ? 'Simulating...' : 'Simulate Provider Events'}
                        </button>
                      )}
                      {getShipmentMode(selectedShip) !== 'manual' && canSyncTracking && isTestProvider && activeProviderId?.toLowerCase() === 'easypost' && !isWriteBlocked && (
                        <div className="relative">
                          <button onClick={() => setShowTestTrackerMenu(!showTestTrackerMenu)}
                            className="px-4 py-2.5 bg-violet-50 text-violet-700 border border-violet-200 font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-violet-100 transition-all flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">bug_report</span>
                            Attach EasyPost Test Tracker
                          </button>
                          {showTestTrackerMenu && (
                            <div className="absolute top-full left-0 mt-1 z-20 bg-white border border-violet-200 rounded-xl shadow-lg p-2 w-80">
                              <p className="text-[9px] text-violet-500 font-bold uppercase tracking-widest px-2 py-1">Select Test Tracking Code</p>
                              {EASYPOST_TEST_TRACKERS.map(t => (
                                <button key={t.code} onClick={() => { handleAttachTestTracker(selectedShip.id, t.code); setShowTestTrackerMenu(false); }}
                                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-violet-50 transition-all">
                                  <p className="text-xs font-mono font-bold text-violet-700">{t.code}</p>
                                  <p className="text-[10px] text-slate-500">{t.description}</p>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {selectedShip.lastTrackingSyncAt && (
                      <div className="flex items-center gap-2 text-[10px] text-slate-400">
                        <span className="material-symbols-outlined text-xs">sync</span>
                        Last synced: {formatDateTime(selectedShip.lastTrackingSyncAt)}
                        {isTestProvider && <span className="px-1.5 py-0.5 bg-amber-100 text-amber-600 rounded text-[9px] font-black uppercase">Test Mode</span>}
                      </div>
                    )}

                    {isTestProvider && !hasProviderEvents && selectedShip.trackingNumber && !providerWarning && (
                      <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
                        <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">info</span>
                        <div>
                          <p className="text-xs text-amber-700 font-medium">No provider tracking events yet</p>
                          <p className="text-[10px] text-amber-600 mt-0.5">Use "Simulate Provider Events" to generate test events and verify your tracking timeline display.</p>
                        </div>
                      </div>
                    )}

                    {hasTestEvents && (
                      <div className="px-3 py-2 bg-amber-50/60 border border-amber-100 rounded-lg flex items-start gap-2">
                        <span className="material-symbols-outlined text-amber-400 text-sm mt-0.5">science</span>
                        <p className="text-[10px] text-amber-600">Events marked <span className="font-black">Test Provider</span> are simulated data generated in test mode. They do not represent real carrier activity.</p>
                      </div>
                    )}

                    {!isTestProvider && !hasProviderEvents && selectedShip.trackingNumber && (
                      <div className="px-3 py-2 bg-sky-50 border border-sky-200 rounded-lg flex items-start gap-2">
                        <span className="material-symbols-outlined text-sky-500 text-sm mt-0.5">info</span>
                        <div>
                          <p className="text-xs text-sky-700 font-medium">
                            {isPostDispatch(selectedShip.status) ? 'Carrier scan not yet received' : 'No provider tracking events yet'}
                          </p>
                          <p className="text-[10px] text-sky-600 mt-0.5">
                            {isPostDispatch(selectedShip.status)
                              ? 'This shipment has been dispatched but no carrier acceptance/scan event has been recorded yet. Use "Sync Tracking" to check for updates. Post-dispatch status changes (In Transit, Delivered, Exception) will be applied automatically when carrier events arrive.'
                              : 'Use "Sync Tracking" in Provider & Operations to fetch the latest carrier updates.'
                            }
                          </p>
                        </div>
                      </div>
                    )}

                    <div className="relative pl-8 space-y-0">
                      <div className="absolute left-3 top-2 bottom-2 w-px bg-slate-200" />
                      {allEvents.map((evt, i) => {
                        const isTest = evt._source === 'test_provider';
                        const isWebhook = evt._source === 'webhook';
                        const isReplay = evt._source === 'replay';
                        const isProvider = evt._source === 'provider' || isTest || isWebhook || isReplay;
                        const sourceLabel = isTest ? 'Test Provider' : isWebhook ? 'Webhook' : isReplay ? 'Replay' : isProvider ? 'Provider' : 'Manual';
                        return (
                        <div key={evt.id} className="relative pb-6 last:pb-0">
                          <div className={`absolute left-[-23px] top-1 w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                            i === 0 ? 'bg-primary border-primary' :
                            isTest ? 'bg-amber-50 border-amber-300' :
                            isReplay ? 'bg-violet-50 border-violet-300' :
                            isWebhook ? 'bg-purple-50 border-purple-300' :
                            isProvider ? 'bg-sky-50 border-sky-300' :
                            'bg-white border-slate-300'
                          }`}>
                            {i === 0 && <div className="w-2 h-2 rounded-full bg-white" />}
                          </div>
                          <div className="ml-2">
                            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                              <span className="text-xs font-black text-slate-700">{evt.status}</span>
                              <span className="text-[10px] text-slate-400">{formatDateTime(evt.timestamp)}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-widest ${
                                isTest ? 'bg-amber-100 text-amber-600' :
                                isReplay ? 'bg-violet-100 text-violet-600' :
                                isWebhook ? 'bg-purple-100 text-purple-600' :
                                isProvider ? 'bg-sky-100 text-sky-600' :
                                'bg-slate-100 text-slate-500'
                              }`}>{sourceLabel}</span>
                              {(evt as any)._processingResult && (evt as any)._processingResult !== 'processed' && (
                                <span className={`px-1 py-0.5 rounded text-[8px] font-black uppercase ${
                                  (evt as any)._processingResult === 'duplicate' ? 'bg-amber-100 text-amber-600' :
                                  (evt as any)._processingResult === 'failed' ? 'bg-red-100 text-red-600' :
                                  'bg-slate-100 text-slate-500'
                                }`}>{(evt as any)._processingResult}</span>
                              )}
                            </div>
                            <p className="text-xs text-slate-600">{evt.description}</p>
                            {evt.location && <p className="text-[10px] text-slate-400 mt-0.5">{evt.location}</p>}
                            {evt.performedBy && <p className="text-[10px] text-slate-400">by {evt.performedBy}</p>}
                            {(evt as any)._receivedAt && (evt as any)._receivedAt !== evt.timestamp && (
                              <p className="text-[9px] text-slate-300 mt-0.5">received: {formatDateTime((evt as any)._receivedAt)}</p>
                            )}
                          </div>
                        </div>
                        );
                      })}
                      {allEvents.length === 0 && (
                        <div className="flex flex-col items-center py-8 ml-[-32px]">
                          <span className="material-symbols-outlined text-3xl text-slate-300 mb-2">timeline</span>
                          <p className="text-sm font-bold text-slate-400">No tracking events yet</p>
                          <p className="text-xs text-slate-400 mt-1">Add an event manually or sync from your shipping provider.</p>
                        </div>
                      )}
                    </div>
                  </>
                  );
                })()}

                {detailTab === 'packages' && (
                  <>
                    {selectedShip.packages.length === 0 ? (
                      <div className="flex flex-col items-center py-8">
                        <span className="material-symbols-outlined text-3xl text-slate-300 mb-2">inventory_2</span>
                        <p className="text-sm font-bold text-slate-400">No packages added</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {selectedShip.packages.map((pkg, i) => (
                          <div key={pkg.id} className="bg-slate-50 rounded-2xl p-5">
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Package {i + 1}</p>
                            <div className="grid grid-cols-2 gap-3 text-xs">
                              {pkg.weight && <div><span className="text-slate-400 font-bold">Weight</span> <span className="font-black text-slate-700">{pkg.weight} {pkg.weightUnit || 'lb'}</span></div>}
                              {(pkg.length && pkg.width && pkg.height) && <div><span className="text-slate-400 font-bold">Dimensions</span> <span className="font-black text-slate-700">{pkg.length} x {pkg.width} x {pkg.height} {pkg.dimensionUnit || 'in'}</span></div>}
                              {pkg.declaredValue && <div><span className="text-slate-400 font-bold">Declared Value</span> <span className="font-black text-slate-700">${pkg.declaredValue}</span></div>}
                              {pkg.insuredValue && <div><span className="text-slate-400 font-bold">Insured Value</span> <span className="font-black text-slate-700">${pkg.insuredValue}</span></div>}
                              {pkg.contentsSummary && <div className="col-span-2"><span className="text-slate-400 font-bold">Contents</span> <span className="font-black text-slate-700">{pkg.contentsSummary}</span></div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}

        {showStatusConfirm && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-sm p-8 text-center">
              <span className="material-symbols-outlined text-4xl text-primary mb-4">help</span>
              <p className="text-sm font-bold text-slate-700 mb-6">{showStatusConfirm.label}</p>
              <div className="flex gap-3">
                <button onClick={() => setShowStatusConfirm(null)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                <button onClick={() => handleStatusTransition(showStatusConfirm.id, showStatusConfirm.newStatus)} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20">Confirm</button>
              </div>
            </motion.div>
          </div>
        )}

        {reasonModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8">
              <div className="flex items-center gap-3 mb-6">
                <span className={`material-symbols-outlined text-3xl ${reasonModal.newStatus === 'Rejected' ? 'text-orange-500' : reasonModal.newStatus === 'Packed' ? 'text-amber-500' : 'text-pink-500'}`}>
                  {reasonModal.newStatus === 'Rejected' ? 'block' : reasonModal.newStatus === 'Packed' ? 'undo' : 'assignment_return'}
                </span>
                <div>
                  <h3 className="text-lg font-black text-slate-800">
                    {reasonModal.newStatus === 'Rejected' ? 'Rejected by Carrier' : reasonModal.newStatus === 'Packed' ? 'Rollback to Packed' : 'Mark as Returned'}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {reasonModal.newStatus === 'Packed'
                      ? 'This will roll back from Dispatched to Packed. Select a reason for this operational correction.'
                      : 'Select a reason to proceed. This action will be recorded in the shipment timeline.'}
                  </p>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Reason *</label>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {(reasonModal.newStatus === 'Rejected' ? REJECTION_REASONS : reasonModal.newStatus === 'Packed' ? ROLLBACK_REASONS : RETURN_REASONS).map(reason => (
                      <button
                        key={reason}
                        onClick={() => setSelectedReason(reason)}
                        className={`w-full text-left px-3 py-2.5 rounded-xl text-xs transition-all border ${
                          selectedReason === reason
                            ? reasonModal.newStatus === 'Rejected'
                              ? 'bg-orange-50 border-orange-300 text-orange-700 font-bold'
                              : reasonModal.newStatus === 'Packed'
                              ? 'bg-amber-50 border-amber-300 text-amber-700 font-bold'
                              : 'bg-pink-50 border-pink-300 text-pink-700 font-bold'
                            : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        {reason}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Additional Notes (Optional)</label>
                  <textarea
                    value={reasonNotes}
                    onChange={e => setReasonNotes(e.target.value)}
                    placeholder="Any additional details..."
                    rows={2}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none"
                  />
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button onClick={() => { setReasonModal(null); setSelectedReason(''); setReasonNotes(''); }} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                <button
                  onClick={() => handleStatusTransition(reasonModal.id, reasonModal.newStatus, selectedReason, reasonNotes || undefined)}
                  disabled={!selectedReason}
                  className={`flex-1 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg transition-all ${
                    selectedReason
                      ? reasonModal.newStatus === 'Rejected'
                        ? 'bg-orange-500 text-white shadow-orange-500/20 hover:bg-orange-600'
                        : reasonModal.newStatus === 'Packed'
                        ? 'bg-amber-500 text-white shadow-amber-500/20 hover:bg-amber-600'
                        : 'bg-pink-500 text-white shadow-pink-500/20 hover:bg-pink-600'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
                  }`}
                >
                  {reasonModal.newStatus === 'Rejected' ? 'Confirm Rejection' : reasonModal.newStatus === 'Packed' ? 'Confirm Rollback' : 'Confirm Return'}
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {addEventModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8">
              <h3 className="text-lg font-black text-primary mb-6">Add Tracking Event</h3>
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Description *</label>
                  <input value={eventDescription} onChange={e => setEventDescription(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="e.g. Package arrived at sorting facility" />
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Location</label>
                  <input value={eventLocation} onChange={e => setEventLocation(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="e.g. Austin, TX" />
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button onClick={() => setAddEventModal(null)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                <button onClick={() => handleAddEvent(addEventModal)} disabled={!eventDescription.trim()} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 disabled:opacity-50">Add Event</button>
              </div>
            </motion.div>
          </div>
        )}

        {editingShipment && (() => {
          const editShipData = shipments.find(s => s.id === editingShipment);
          const packagesLocked = editShipData ? STATUS_ORDER.indexOf(editShipData.status) >= STATUS_ORDER.indexOf('Label Created') : false;
          const hasLabel = !!editShipData?.label;
          const hasSelectedRate = !!editShipData?.selectedRate;
          const trackingLocked = hasLabel;
          const carrierServiceLocked = hasLabel;
          const addressLocked = hasLabel;
          return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
              <div className="p-8 border-b border-slate-100 flex justify-between items-start shrink-0">
                <div>
                  <h3 className="text-lg font-black text-primary">Edit Shipment</h3>
                  {editShipData && <p className="text-xs text-slate-400 mt-0.5">{editShipData.shipmentNumber} · {editShipData.status}</p>}
                </div>
                <button onClick={() => setEditingShipment(null)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              {isWriteBlocked && (
                <div className="px-8 py-3 bg-amber-50 border-b border-amber-100 flex items-center gap-2">
                  <span className="material-symbols-outlined text-amber-600 text-sm">visibility</span>
                  <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest">Preview Mode — Changes will not be saved</p>
                </div>
              )}
              <div className="p-8 overflow-y-auto flex-1 space-y-4">
                {carrierServiceLocked && (
                  <div className="px-3 py-2 bg-indigo-50 border border-indigo-100 rounded-lg flex items-start gap-2">
                    <span className="material-symbols-outlined text-indigo-500 text-sm mt-0.5">info</span>
                    <p className="text-[10px] text-indigo-600 font-medium">
                      Carrier, service, and tracking are locked after label purchase.
                    </p>
                  </div>
                )}
                {!carrierServiceLocked && hasSelectedRate && (
                  <div className="px-3 py-2 bg-amber-50 border border-amber-100 rounded-lg flex items-start gap-2">
                    <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">info</span>
                    <p className="text-[10px] text-amber-600 font-medium">
                      Carrier and service are currently set from the provider-selected rate. Changing them manually will clear the selected rate and switch this shipment to manual mode.
                    </p>
                  </div>
                )}
                <div className="space-y-3">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><span className="material-symbols-outlined text-xs">warehouse</span>Origin Address {addressLocked && <span className="text-amber-500 ml-1">(locked)</span>}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={newOrigin.name} onChange={e => setNewOrigin(p => ({ ...p, name: e.target.value }))} disabled={addressLocked} className="col-span-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Name" />
                    <input value={newOrigin.line1} onChange={e => setNewOrigin(p => ({ ...p, line1: e.target.value }))} disabled={addressLocked} className="col-span-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Address line 1" />
                    <input value={newOrigin.city} onChange={e => setNewOrigin(p => ({ ...p, city: e.target.value }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="City" />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={newOrigin.state} onChange={e => setNewOrigin(p => ({ ...p, state: e.target.value }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="State" />
                      <input value={newOrigin.postalCode} onChange={e => setNewOrigin(p => ({ ...p, postalCode: e.target.value }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="ZIP" />
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><span className="material-symbols-outlined text-xs">local_shipping</span>Destination Address {addressLocked && <span className="text-amber-500 ml-1">(locked)</span>}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={newDest.name} onChange={e => setNewDest(p => ({ ...p, name: e.target.value }))} disabled={addressLocked} className="col-span-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Name" />
                    <input value={newDest.line1} onChange={e => setNewDest(p => ({ ...p, line1: e.target.value }))} disabled={addressLocked} className="col-span-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Address line 1" />
                    <input value={newDest.city} onChange={e => setNewDest(p => ({ ...p, city: e.target.value }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="City" />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={newDest.state} onChange={e => setNewDest(p => ({ ...p, state: e.target.value }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="State" />
                      <input value={newDest.postalCode} onChange={e => setNewDest(p => ({ ...p, postalCode: e.target.value }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="ZIP" />
                    </div>
                    <input value={newDest.phone || ''} onChange={e => setNewDest(p => ({ ...p, phone: e.target.value || undefined }))} disabled={addressLocked} className="col-span-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Phone (required for UPS/FedEx)" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Carrier {carrierServiceLocked && <span className="text-amber-500 ml-1">(locked)</span>}</label>
                  <select value={newCarrier} onChange={e => setNewCarrier(e.target.value)} disabled={carrierServiceLocked} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed">
                    <option value="">Select carrier...</option>
                    {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Service Level {carrierServiceLocked && <span className="text-amber-500 ml-1">(locked)</span>}</label>
                  <select value={newService} onChange={e => setNewService(e.target.value)} disabled={carrierServiceLocked} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed">
                    <option value="">Select service...</option>
                    {SERVICE_LEVELS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tracking Number {trackingLocked && <span className="text-amber-500 ml-1">(locked)</span>}</label>
                  <input value={newTracking} onChange={e => setNewTracking(e.target.value)} disabled={trackingLocked} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono disabled:opacity-50 disabled:cursor-not-allowed" placeholder={trackingLocked ? 'Set by label purchase' : 'Enter tracking number'} />
                </div>
                {canViewCosts && (
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Shipping Cost ($)</label>
                    <input type="number" step="0.01" value={newCost} onChange={e => setNewCost(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="0.00" />
                  </div>
                )}
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Notes</label>
                  <textarea value={newNotes} onChange={e => setNewNotes(e.target.value)} rows={3} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none" placeholder="Internal notes..." />
                </div>

                <div>
                  <div className="flex justify-between items-center mb-3">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
                      <span className="material-symbols-outlined text-xs">package_2</span>Packages
                      {packagesLocked && <span className="text-amber-500 ml-1">(locked)</span>}
                    </p>
                    {!packagesLocked && (
                      <button onClick={() => addPackageRow('edit')} className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-0.5 hover:text-primary/70"><span className="material-symbols-outlined text-sm">add</span>Add</button>
                    )}
                  </div>
                  {editPackages.length === 0 ? (
                    <p className="text-xs text-slate-400 italic">No packages.</p>
                  ) : (
                    <div className="space-y-3">
                      {editPackages.map((pkg, i) => (
                        <div key={pkg.id} className="bg-slate-50 rounded-xl p-4 space-y-2">
                          <div className="flex justify-between items-center mb-1">
                            <p className="text-[10px] font-black text-slate-400 uppercase">Package {i + 1}</p>
                            {!packagesLocked && <button onClick={() => removePackage('edit', pkg.id)} className="text-slate-400 hover:text-red-500"><span className="material-symbols-outlined text-sm">close</span></button>}
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <input type="number" step="0.1" placeholder="Weight" disabled={packagesLocked} value={pkg.weight || ''} onChange={e => updatePackageField('edit', pkg.id, 'weight', e.target.value ? parseFloat(e.target.value) : undefined)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" />
                            <input type="number" step="0.1" placeholder="Length" disabled={packagesLocked} value={pkg.length || ''} onChange={e => updatePackageField('edit', pkg.id, 'length', e.target.value ? parseFloat(e.target.value) : undefined)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" />
                            <input type="number" step="0.01" placeholder="Declared $" disabled={packagesLocked} value={pkg.declaredValue || ''} onChange={e => updatePackageField('edit', pkg.id, 'declaredValue', e.target.value ? parseFloat(e.target.value) : undefined)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" />
                          </div>
                          <input placeholder="Contents summary" disabled={packagesLocked} value={pkg.contentsSummary || ''} onChange={e => updatePackageField('edit', pkg.id, 'contentsSummary', e.target.value || undefined)} className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="p-8 border-t border-slate-100 flex gap-3 shrink-0">
                <button onClick={() => setEditingShipment(null)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                <button onClick={handleSaveEdit} disabled={isWriteBlocked} className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 disabled:opacity-50">
                  {isWriteBlocked ? 'Preview Only' : 'Save Changes'}
                </button>
              </div>
            </motion.div>
          </div>
          );
        })()}

        {showCreateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-start shrink-0">
                <div>
                  <h2 className="text-xl font-black text-primary">New Shipment</h2>
                  <p className="text-sm text-slate-500 mt-1">{newSourceNumber ? `From ${newSourceNumber}` : 'Create a new shipment record'}</p>
                </div>
                <button onClick={() => setShowCreateModal(false)} className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 hover:text-primary">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              {isWriteBlocked && (
                <div className="px-8 py-3 bg-amber-50 border-b border-amber-100 flex items-center gap-2">
                  <span className="material-symbols-outlined text-amber-600 text-sm">visibility</span>
                  <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest">Preview Mode — Shipment will not be saved</p>
                </div>
              )}
              <div className="p-8 overflow-y-auto flex-1 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Shipment Type *</label>
                    <select value={newType} onChange={e => setNewType(e.target.value as ShipmentType)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                      {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Source Type *</label>
                    <select value={newSourceType} onChange={e => { setNewSourceType(e.target.value as ShipmentSourceType); setSourceResolved(null); setSourceResolveError(null); setNewSourceId(''); setSourceItems([]); setNewPackages([]); }} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                      {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Source Reference Number</label>
                  <div className="flex gap-2">
                    <input value={newSourceNumber} onChange={e => { setNewSourceNumber(e.target.value); setSourceResolved(null); setSourceResolveError(null); }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); resolveSourceReference(); } }}
                      className="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                      placeholder={newSourceType === 'invoice' ? 'e.g. INV-2026-001' : newSourceType === 'repair' ? 'e.g. T-1001' : newSourceType === 'transfer' ? 'e.g. TRF-2026-001' : 'e.g. RMA-2026-001'} />
                    <button type="button" onClick={resolveSourceReference} disabled={isResolving || !newSourceNumber.trim()}
                      className="px-4 py-3 bg-primary text-white font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shrink-0">
                      <span className="material-symbols-outlined text-sm">{isResolving ? 'hourglass_top' : 'search'}</span>
                      Resolve
                    </button>
                  </div>
                  {sourceResolveError && (
                    <div className="mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                      <span className="material-symbols-outlined text-red-500 text-sm mt-0.5">error</span>
                      <p className="text-xs text-red-600 font-medium">{sourceResolveError}</p>
                    </div>
                  )}
                  {sourceResolved && (
                    <div className="mt-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg flex items-start gap-2">
                      <span className="material-symbols-outlined text-emerald-500 text-sm mt-0.5">check_circle</span>
                      <p className="text-xs text-emerald-700 font-medium">{sourceResolved}</p>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Origin Address</p>
                    <input value={newOrigin.name} onChange={e => setNewOrigin({ ...newOrigin, name: e.target.value })} placeholder="Name *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <input value={newOrigin.line1} onChange={e => setNewOrigin({ ...newOrigin, line1: e.target.value })} placeholder="Address Line 1 *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={newOrigin.city} onChange={e => setNewOrigin({ ...newOrigin, city: e.target.value })} placeholder="City *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                      <input value={newOrigin.state} onChange={e => setNewOrigin({ ...newOrigin, state: e.target.value })} placeholder="State *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>
                    <input value={newOrigin.postalCode} onChange={e => setNewOrigin({ ...newOrigin, postalCode: e.target.value })} placeholder="Postal Code *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                  </div>
                  <div className="space-y-3">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Destination Address</p>
                    <input value={newDest.name} onChange={e => setNewDest({ ...newDest, name: e.target.value })} placeholder="Recipient Name *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <input value={newDest.line1} onChange={e => setNewDest({ ...newDest, line1: e.target.value })} placeholder="Address Line 1 *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={newDest.city} onChange={e => setNewDest({ ...newDest, city: e.target.value })} placeholder="City *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                      <input value={newDest.state} onChange={e => setNewDest({ ...newDest, state: e.target.value })} placeholder="State *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>
                    <div className="relative">
                      <input value={newDest.postalCode} onChange={e => {
                        const val = e.target.value;
                        setNewDest(prev => {
                          const updated = { ...prev, postalCode: val };
                          const zip = val.trim();
                          if (zip.length === 5) {
                            const lookup = lookupZipCode(zip);
                            if (lookup) {
                              updated.city = lookup.city;
                              updated.state = lookup.state;
                            }
                          }
                          return updated;
                        });
                      }} placeholder="Postal Code *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                      {newDest.postalCode.trim().length === 5 && lookupZipCode(newDest.postalCode.trim()) && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500">
                          <span className="material-symbols-outlined text-sm">check_circle</span>
                        </span>
                      )}
                    </div>
                    {newDest.postalCode.trim().length === 5 && !lookupZipCode(newDest.postalCode.trim()) && (
                      <p className="text-[10px] text-slate-400 -mt-1 flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">info</span>
                        Zip not in local database. Enter city/state manually.
                      </p>
                    )}
                  </div>
                </div>

                {sourceItems.length > 0 && (
                  <div className="bg-sky-50 rounded-2xl p-5 border border-sky-100">
                    <p className="text-[10px] font-black text-sky-600 uppercase tracking-widest mb-3 flex items-center gap-1"><span className="material-symbols-outlined text-xs">inventory_2</span>Source Items</p>
                    <div className="space-y-1.5">
                      {sourceItems.map(item => (
                        <div key={item.id} className="flex justify-between items-center bg-white/80 px-3 py-2 rounded-lg text-xs">
                          <span className="font-bold text-slate-700">{item.name}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-slate-500">x{item.quantity}</span>
                            {item.price !== undefined && <span className="font-black text-primary">${(item.price * item.quantity).toFixed(2)}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex justify-between items-center mb-3">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><span className="material-symbols-outlined text-xs">package_2</span>Packages</p>
                    <button onClick={() => addPackageRow('create')} className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-0.5 hover:text-primary/70"><span className="material-symbols-outlined text-sm">add</span>Add Package</button>
                  </div>
                  {newPackages.length === 0 ? (
                    <p className="text-xs text-slate-400 italic">No packages added yet. Click Add Package above.</p>
                  ) : (
                    <div className="space-y-3">
                      {newPackages.map((pkg, i) => (
                        <div key={pkg.id} className="bg-slate-50 rounded-xl p-4 space-y-2 relative">
                          <div className="flex justify-between items-center mb-1">
                            <p className="text-[10px] font-black text-slate-400 uppercase">Package {i + 1}</p>
                            <button onClick={() => removePackage('create', pkg.id)} className="text-slate-400 hover:text-red-500"><span className="material-symbols-outlined text-sm">close</span></button>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <input type="number" step="0.1" placeholder="Weight" value={pkg.weight || ''} onChange={e => updatePackageField('create', pkg.id, 'weight', e.target.value ? parseFloat(e.target.value) : undefined)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
                            <input type="number" step="0.1" placeholder="L x W x H" value={pkg.length || ''} onChange={e => updatePackageField('create', pkg.id, 'length', e.target.value ? parseFloat(e.target.value) : undefined)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
                            <input type="number" step="0.01" placeholder="Declared $" value={pkg.declaredValue || ''} onChange={e => updatePackageField('create', pkg.id, 'declaredValue', e.target.value ? parseFloat(e.target.value) : undefined)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
                          </div>
                          <input placeholder="Contents summary" value={pkg.contentsSummary || ''} onChange={e => updatePackageField('create', pkg.id, 'contentsSummary', e.target.value || undefined)} className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Carrier</label>
                    <select value={newCarrier} onChange={e => setNewCarrier(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                      <option value="">Select carrier...</option>
                      {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Service Level</label>
                    <select value={newService} onChange={e => setNewService(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20">
                      <option value="">Select service...</option>
                      {SERVICE_LEVELS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                <div className={`grid ${canViewCosts ? 'grid-cols-2' : 'grid-cols-1'} gap-4`}>
                  <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Tracking Number</label>
                    <input value={newTracking} onChange={e => setNewTracking(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 font-mono" placeholder="Enter if available" />
                  </div>
                  {canViewCosts && (
                    <div>
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Shipping Cost ($)</label>
                      <input type="number" step="0.01" value={newCost} onChange={e => setNewCost(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="0.00" />
                    </div>
                  )}
                </div>
                <div>
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 block">Notes</label>
                  <textarea value={newNotes} onChange={e => setNewNotes(e.target.value)} rows={2} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none" placeholder="Internal notes..." />
                </div>
              </div>
              <div className="p-8 border-t border-slate-100 bg-slate-50/30 flex gap-3 shrink-0">
                <button onClick={() => setShowCreateModal(false)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                <button
                  onClick={handleCreateShipment}
                  disabled={!newOrigin.name || !newOrigin.line1 || !newDest.name || !newDest.line1 || isWriteBlocked}
                  className="flex-1 py-3 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 disabled:opacity-50"
                >
                  {isWriteBlocked ? 'Preview Only' : 'Create Shipment'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </PageShell>
  );
}
