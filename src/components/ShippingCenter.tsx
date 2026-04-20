import React, { useState, useMemo, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useStoreLocalState } from '../context/StoreLocalState';
import { useAccess } from '../context/AccessContext';
import { Shipment, ShipmentStatus, ShipmentSourceType, ShipmentType, ShipmentAddress, ShipmentPackage, ShipmentEvent, ShippingRate, AddressValidationResult, ProviderTrackingEvent, ServicePoint, PickupRequest, PickupRequestStatus } from '../types';
import * as shippingApi from '../shipping/shippingApiClient';
import type { ProviderError } from '../shipping/types';
import type { ReturnPrefill } from './ReturnsPortal';
import PageShell from './PageShell';
import { TrackingNumber } from './shared/TrackingNumber';
import ShippingProvidersPage from './ShippingProvidersPage';
import { featureMatrix as staticFeatureMatrix } from '../owner/mockData';
import { normalizeStateCode, normalizeZip, normalizePhone } from '../utils/inputNormalizers';

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
  const { checkPermission, checkSubPermission, hasPermission, isWriteBlocked, canAccess, tenant } = useAccess();
  // Force re-render when System Owner Plans & Features matrix changes via sessionStorage.
  // Without this, toggling a feature in the System Owner UI in another tab would leave
  // ShippingCenter's gating stale until next mount. Storage events fire on cross-document
  // writes; we also listen for a same-document custom 'features_data:changed' event so
  // PlansPage edits in the same tab propagate immediately.
  const [, setFeatureStateTick] = useState(0);
  useEffect(() => {
    const bump = () => setFeatureStateTick(t => t + 1);
    const onStorage = (e: StorageEvent) => { if (e.key === 'features_data') bump(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('features_data:changed', bump as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('features_data:changed', bump as EventListener);
    };
  }, []);
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
  const canSelectServicePoint = checkSubPermission('select_service_point');
  const canRequestPickup = checkSubPermission('request_carrier_pickup');
  const canCancelPickup = checkSubPermission('cancel_carrier_pickup');
  // Live plan-feature gating. Reads the System Owner matrix override directly from
  // sessionStorage on every render (the storage/custom-event listener above triggers
  // a re-render when PlansPage saves), then falls back to the static `featureMatrix`
  // import. This is the SINGLE source of truth used by both UI gating and action
  // handlers, so a feature toggled off by a System Owner cannot leave a stale UI
  // showing the capability as available.
  function isPlanFeatureLive(featureId: string): boolean {
    if (!tenant) return false;
    const planKey = (tenant.plan as string) === 'starter' ? 'essential' : (tenant.plan as string);
    let matrix: Array<{ id: string; planAvailability?: Record<string, boolean>; lifecycle?: string }> = [];
    try {
      const raw = sessionStorage.getItem('features_data');
      if (raw) matrix = JSON.parse(raw);
    } catch {}
    if (!Array.isArray(matrix) || matrix.length === 0) {
      matrix = staticFeatureMatrix as typeof matrix;
    }
    const entry = matrix.find(f => f.id === featureId);
    if (!entry || !entry.planAvailability) return hasPermission(featureId);
    return !!entry.planAvailability[planKey];
  }
  const planAllowsServicePoints = isPlanFeatureLive('service_points');
  const planAllowsPickupRequests = isPlanFeatureLive('pickup_requests');

  const [activeTab, setActiveTab] = useState<'shipments' | 'settings'>('shipments');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ShipmentStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<ShipmentSourceType | 'all'>('all');
  const [selectedShipment, setSelectedShipment] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'overview' | 'tracking' | 'packages' | 'logistics'>('overview');
  // Service Points & Pickup Requests (Phase 2) — UI state
  const [showServicePointModal, setShowServicePointModal] = useState<string | null>(null);
  const [servicePointSearchResults, setServicePointSearchResults] = useState<ServicePoint[]>([]);
  // Manual service-point entry form. Used when live carrier locator is unavailable
  // (i.e. no carrier-specific locator adapter is configured for this carrier). Operator
  // types in the carrier-issued service-point reference they obtained out-of-band.
  const [manualSpForm, setManualSpForm] = useState<{ id: string; name: string; type: string; line1: string; city: string; state: string; postalCode: string; phone: string }>({
    id: '', name: '', type: 'parcel_locker', line1: '', city: '', state: '', postalCode: '', phone: '',
  });
  const [manualSpSubmitting, setManualSpSubmitting] = useState(false);
  const [servicePointLoading, setServicePointLoading] = useState(false);
  const [servicePointNotes, setServicePointNotes] = useState('');
  const [servicePointZipSearch, setServicePointZipSearch] = useState('');
  const [pickupForm, setPickupForm] = useState<{ date: string; windowStart: string; windowEnd: string; contactName: string; contactPhone: string; notes: string }>({
    date: '',
    windowStart: '09:00',
    windowEnd: '17:00',
    contactName: '',
    contactPhone: '',
    notes: '',
  });
  const [pickupSubmitting, setPickupSubmitting] = useState(false);
  // Inline structured outcome of the last pickup attempt — rendered right
  // above the Request button so the operator always sees a truthful result
  // (success, partial, or failure) without having to scroll back up to the
  // page-level providerError/providerSuccess banners. Cleared when the form
  // is reopened or a fresh attempt begins.
  type PickupAttemptResult = {
    kind: 'success' | 'partial' | 'error' | 'info';
    title: string;
    detail: string;
    steps: { label: string; status: 'ok' | 'fail' | 'skip' | 'pending'; note?: string }[];
    code?: string;
    providerPickupId?: string;
    confirmationNumber?: string;
    cost?: number;
    currency?: string;
    rawError?: string;
    // Structured upstream-provider diagnostics so the operator can see the
    // *actual* failure cause (e.g. EasyPost field-level validation) rather
    // than the generic semantic-error wrapper.
    stage?: string;
    httpStatus?: number;
    providerCode?: string;
    providerMessage?: string;
    fieldErrors?: { field?: string; message: string; code?: string; suggestion?: string }[];
    // Concise prerequisite snapshot — what we sent to the provider, so the
    // operator can see at a glance whether the cause is missing app context
    // (no shipment ref, bad window, manual address) vs a true provider issue.
    context?: { label: string; value: string }[];
    detailsCollapsed?: string; // multi-line raw detail bundle for "Show details"
  };
  const [pickupAttemptResult, setPickupAttemptResult] = useState<PickupAttemptResult | null>(null);
  // Phase 2.9 — pickup-rates selection panel. After pickup.create returns,
  // this holds the provider-returned rates so the operator can pick the
  // exact one (with the exact fee) before pickup.buy is called. Empty
  // `rates` with kind='no_rates' means the provider explicitly returned
  // zero rates — that is rendered as an honest pre-booking no-rates
  // state and is NOT persisted as a partial_failed PickupRequest.
  type PickupRatesPanel = {
    shipmentId: string;
    providerPickupId: string;
    providerId?: string;
    rates: { id: string; providerRateId: string; carrier: string; service: string; rate: number; currency: string }[];
    selectedRateId?: string; // providerRateId of the chosen rate
    fetchedAt: string;
    kind: 'rates' | 'no_rates';
    formSnapshot: { date: string; windowStart: string; windowEnd: string };
  };
  const [pickupRatesPanel, setPickupRatesPanel] = useState<PickupRatesPanel | null>(null);
  const [pickupCancelReason, setPickupCancelReason] = useState('');
  // Phase 2.10 — pickup cancellation confirmation modal. The previous
  // direct-call pattern (clicking Cancel Pickup → fire-and-forget) gave
  // operators no warning before a live carrier-cancel call and no clear
  // outcome state when the call hung or the network dropped between
  // clicking and the toast appearing. We now stage the cancel through a
  // modal that:
  //   1. Names the carrier + confirmation number that will be cancelled.
  //   2. Distinguishes live carrier cancellation vs local-only cancellation.
  //   3. Has its own in-flight + result fields so the operator sees
  //      "cancelling…" → "cancelled" or "failed" without ambiguity.
  // The modal is also the single place we call handleCancelPickup from now,
  // so the two pickup-cancel entry points (panel button + status panel
  // button) cannot diverge in confirmation behavior.
  const [pickupCancelModal, setPickupCancelModal] = useState<{
    shipmentId: string;
    carrier: string;
    confirmationNumber?: string;
    isLive: boolean;
    inFlight: boolean;
    result?: { ok: boolean; message: string };
  } | null>(null);
  // Phase 2.10 — shipment-cancel dependency on confirmed pickup. When a
  // shipment has an active pickup booking, the operator must cancel the
  // pickup FIRST so the carrier doesn't show up at the door for a void
  // shipment. We surface this as an explicit blocking modal rather than a
  // silent button-disable so the operator knows what to do next.
  const [shipmentCancelBlocked, setShipmentCancelBlocked] = useState<{
    shipmentId: string;
    carrier: string;
    confirmationNumber?: string;
    pickupStatus: PickupRequestStatus;
  } | null>(null);
  // True pickup-address verification state — separate from the shipment
  // origin's shipping-address validation. Keyed by shipmentId. The
  // `fingerprint` is a stable hash of the address fields the carriers care
  // about; if the operator edits the origin, the fingerprint changes and
  // any prior verification is treated as 'stale' (must re-verify before
  // requesting pickup). 'corrected' results require explicit operator
  // acceptance before pickup is allowed (operator may accept the suggested
  // address or revise the origin manually). This works generically across
  // any EasyPost-supported pickup carrier (USPS, UPS, FedEx, …) — EasyPost's
  // delivery verification is carrier-agnostic.
  type PickupVerify = {
    fingerprint: string;
    status: 'verified' | 'corrected' | 'failed';
    suggestedAddress?: ShipmentAddress;
    messages: string[];
    providerRef?: string;
    verifiedAt: string;
    accepted?: boolean; // for 'corrected': operator accepted the suggestion
    errorCode?: string;
    errorMessage?: string;
    // Captured for the audit panel so the operator can see exactly what was
    // sent to the verification call vs. what the carrier returned vs. what
    // would be sent to pickup_create.
    submittedAddress?: ShipmentAddress;
    details?: Record<string, unknown>;
    warnings?: { code?: string; message: string; field?: string }[];
  };
  const [pickupAddrVerify, setPickupAddrVerify] = useState<Record<string, PickupVerify>>({});
  const [pickupVerifying, setPickupVerifying] = useState<Record<string, boolean>>({});
  // Pickup-eligibility state (Phase 2.5.8). Distinct from address verification:
  //   - delivery verification (PickupVerify) only proves the address is
  //     DELIVERABLE — i.e. the carrier could deliver mail there.
  //   - pickup eligibility proves the carrier will actually ACCEPT the
  //     address for a pickup_create call. EasyPost / USPS have no separate
  //     official pickup-eligibility endpoint, so the only true proof point
  //     is the result of pickup_create itself. We persist that result here,
  //     keyed by the resolved-pickup-address fingerprint, so an address
  //     snapshot that already failed pickup_create cannot keep showing as
  //     "ready" until the operator changes the address.
  type PickupEligibility = {
    // Phase 2.6.1 — `fingerprint` is now the FULL payload fingerprint
    // (address + contact name + normalized phone + instructions + window),
    // not just the address. Any provider-relevant edit invalidates the
    // memory and re-opens the retry path. `addrFingerprint` is kept
    // separately for diagnostics / display so we can tell whether the
    // operator changed only contact info vs. the address itself.
    fingerprint: string;
    addrFingerprint?: string;
    status: 'confirmed' | 'failed';
    message?: string;
    providerCode?: string;
    httpStatus?: number;
    attemptedAt: string;
    providerPickupId?: string;
  };
  const [pickupEligibility, setPickupEligibility] = useState<Record<string, PickupEligibility>>({});
  // Phase 2.6 — operator is currently editing the pickup-only override
  // address for this shipment. Distinct from the main edit-shipment modal
  // because origin is locked once the label is purchased; the override is
  // not. Stored as { [shipmentId]: ShipmentAddress draft }.
  const [pickupOverrideDraft, setPickupOverrideDraft] = useState<Record<string, ShipmentAddress>>({});
  const [pickupOverrideDetailDraft, setPickupOverrideDetailDraft] = useState<Record<string, string>>({});
  // Carrier Locator per-store configuration. Persisted in sessionStorage.
  // Each adapter is independently togglable so an operator can ship via UPS
  // only without configuring USPS/FedEx. Status reflects scaffolding state
  // honestly — no adapter currently performs a live API call (returns
  // {unavailable:true} from src/shipping/locators/*), so even when an operator
  // marks an adapter "configured" it cannot yet verify against the carrier.
  type LocatorAdapterStatus = 'not_configured' | 'configured' | 'verified' | 'verification_failed';
  type LocatorAdapterConfig = {
    enabled: boolean;
    environment: 'sandbox' | 'production';
    credentialRef: string;
    status: LocatorAdapterStatus;
    lastVerifiedAt?: string;
    lastVerifyMessage?: string;
  };
  const LOCATOR_DEFINITIONS = [
    { id: 'usps' as const, name: 'USPS Locations', desc: 'Post offices, contract postal units, parcel lockers (gopost).', envHint: 'USPS_USER_ID', docs: 'https://developer.usps.com/' },
    { id: 'ups' as const, name: 'UPS Locator', desc: 'UPS Access Points, UPS Stores, drop boxes.', envHint: 'UPS_CLIENT_ID + UPS_CLIENT_SECRET', docs: 'https://developer.ups.com/' },
    { id: 'fedex' as const, name: 'FedEx Locations', desc: 'FedEx Office, FedEx Ship Centers, Authorized ShipCenters, Drop Boxes.', envHint: 'FEDEX_CLIENT_ID + FEDEX_CLIENT_SECRET', docs: 'https://developer.fedex.com/' },
  ];
  const LOCATOR_STORAGE_KEY = 'locator_adapters_config_v1';
  const defaultLocatorConfig = (): Record<string, LocatorAdapterConfig> => ({
    usps: { enabled: false, environment: 'sandbox', credentialRef: '', status: 'not_configured' },
    ups: { enabled: false, environment: 'sandbox', credentialRef: '', status: 'not_configured' },
    fedex: { enabled: false, environment: 'sandbox', credentialRef: '', status: 'not_configured' },
  });
  const [locatorConfig, setLocatorConfig] = useState<Record<string, LocatorAdapterConfig>>(() => {
    try {
      const raw = typeof window !== 'undefined' ? sessionStorage.getItem(LOCATOR_STORAGE_KEY) : null;
      if (raw) return { ...defaultLocatorConfig(), ...JSON.parse(raw) };
    } catch { /* swallow */ }
    return defaultLocatorConfig();
  });
  function persistLocatorConfig(next: Record<string, LocatorAdapterConfig>) {
    setLocatorConfig(next);
    try { sessionStorage.setItem(LOCATOR_STORAGE_KEY, JSON.stringify(next)); } catch { /* swallow */ }
  }
  function updateLocatorAdapter(id: string, patch: Partial<LocatorAdapterConfig>) {
    const current = locatorConfig[id] || { enabled: false, environment: 'sandbox', credentialRef: '', status: 'not_configured' as const };
    const merged: LocatorAdapterConfig = { ...current, ...patch };
    // Re-derive status from inputs unless an explicit status was passed in.
    if (!('status' in patch)) {
      merged.status = merged.enabled && merged.credentialRef.trim().length > 0 ? 'configured' : 'not_configured';
    }
    persistLocatorConfig({ ...locatorConfig, [id]: merged });
  }
  async function handleVerifyLocator(id: string) {
    const cfg = locatorConfig[id];
    if (!cfg || !cfg.enabled || !cfg.credentialRef.trim()) {
      setProviderError(friendlyProviderError({ code: 'NOT_CONFIGURED', message: 'Enable the adapter and enter a credential reference before verifying.' }));
      return;
    }
    // Honest stub: the underlying locator adapters in src/shipping/locators/*
    // currently return {unavailable:true, configHint} from findServicePoints.
    // A live verify endpoint is not yet wired, so we record the attempt and
    // mark the adapter verification_failed with an explanatory message rather
    // than fake a success.
    const now = new Date().toISOString();
    updateLocatorAdapter(id, {
      status: 'verification_failed',
      lastVerifiedAt: now,
      lastVerifyMessage: `Live verification is not wired yet. The ${id.toUpperCase()} adapter scaffold (src/shipping/locators/${id}Locator.ts) returns unavailable until the carrier API call is implemented. Credentials are stored locally per session for forward-compat.`,
    });
    setProviderError(friendlyProviderError({ code: 'NOT_IMPLEMENTED', message: `Live ${id.toUpperCase()} locator verification is not wired in this app yet. Configuration saved for forward-compat — the adapter will use it once the API call lands.` }));
  }
  function locatorStatusSummary(): { configured: number; enabled: number; total: number } {
    const adapters: LocatorAdapterConfig[] = Object.values(locatorConfig);
    return {
      configured: adapters.filter(a => a.status === 'configured' || a.status === 'verified').length,
      enabled: adapters.filter(a => a.enabled).length,
      total: adapters.length,
    };
  }
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

  const [showBulkSyncModal, setShowBulkSyncModal] = useState(false);
  const [bulkSyncRunning, setBulkSyncRunning] = useState(false);
  const [bulkSyncProgress, setBulkSyncProgress] = useState<{ current: number; total: number } | null>(null);
  const [bulkSyncResults, setBulkSyncResults] = useState<shippingApi.BulkSyncResult[] | null>(null);
  const [bulkSyncSummary, setBulkSyncSummary] = useState<{ total: number; updated: number; unchanged: number; failed: number; testLimitation: number } | null>(null);
  const [bulkSyncFilters, setBulkSyncFilters] = useState({
    inFlightOnly: true,
    includeTerminal: false,
    syncFailuresOnly: false,
    staleDays: 0,
  });

  const STORE_ADDRESS: ShipmentAddress = { name: 'Main Warehouse', line1: '100 Commerce Dr', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US', phone: '512-555-0100' };

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
    const state = location.state as { openCreate?: boolean; prefill?: ShipmentPrefill; openShipmentId?: string } | null;
    if (state?.openShipmentId) {
      const exists = shipments.some(s => s.id === state.openShipmentId);
      if (exists) {
        setSelectedShipment(state.openShipmentId);
        setDetailTab('overview');
        navigate(location.pathname, { replace: true, state: null });
        return;
      }
    }
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

    // Phase 2.10 — shipment-cancel dependency on confirmed pickup (Option A:
    // block first, require explicit pickup-cancel as a separate operator
    // action). Allowing a shipment to flip to Cancelled while a carrier
    // pickup is still on the books would cause the truck to arrive at a
    // void shipment, which is exactly the operational error this guard
    // exists to prevent. The operator gets a dedicated modal naming the
    // carrier + confirmation # and pointing at the Cancel Pickup action,
    // not a silent disabled button.
    if (newStatus === 'Cancelled' && shipment?.pickupRequest && PICKUP_CANCELLABLE_STATUSES.includes(shipment.pickupRequest.status)) {
      setShipmentCancelBlocked({
        shipmentId: id,
        carrier: shipment.pickupRequest.carrier,
        confirmationNumber: shipment.pickupRequest.confirmationNumber,
        pickupStatus: shipment.pickupRequest.status,
      });
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
    const originChanged = shipment && (
      newOrigin.line1 !== shipment.originAddress.line1 ||
      newOrigin.city !== shipment.originAddress.city ||
      newOrigin.state !== shipment.originAddress.state ||
      newOrigin.postalCode !== shipment.originAddress.postalCode
    );
    if (originChanged && shipment?.originAddressValidation) {
      updates.originAddressValidation = undefined;
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
    // If the upstream provider already returned structured field-level errors,
    // those are *more specific* than any generic message we'd substitute below.
    // Pass them through unchanged so the operator sees the real cause.
    if (raw.fieldErrors && raw.fieldErrors.length > 0) return raw;
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
    // Phase 2.9.1 — preserve stage-tagged pickup timeouts verbatim so QA can
    // tell create-stage timeouts (provider hung on pickup.create) apart from
    // buy-stage timeouts (provider hung on pickup.buy after rates were
    // returned). Adapter-side codes are PICKUP_CREATE_TIMEOUT /
    // PICKUP_LOOKUP_TIMEOUT / PICKUP_BUY_TIMEOUT and the message already
    // names the stage and elapsed seconds.
    // Phase 2.9.3 — extended to include label-stage timeouts.
    if (
      raw.code === 'PICKUP_CREATE_TIMEOUT' ||
      raw.code === 'PICKUP_LOOKUP_TIMEOUT' ||
      raw.code === 'PICKUP_BUY_TIMEOUT' ||
      raw.code === 'SHIPMENT_CREATE_TIMEOUT' ||
      raw.code === 'LABEL_PURCHASE_TIMEOUT'
    ) {
      return { ...raw, retryable: true };
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      const stageNote = raw.stage ? ` (stage: ${raw.stage})` : '';
      return { ...raw, message: `Request to the shipping provider timed out${stageNote}. Please try again.`, retryable: true };
    }
    if (raw.code === 'VALIDATION_FAILED' || msg.includes('invalid address') || msg.includes('validation')) {
      return { ...raw, message: `Address validation issue: ${raw.message}` };
    }
    return raw;
  }

  function hasShippablePackages(shipment: Shipment): boolean {
    return shipment.packages.length > 0 && shipment.packages.some(p => p.weight || p.contentsSummary || p.declaredValue);
  }

  // Phase 2.7 — explicit two-stage address-readiness state machine.
  // Operator-facing states for an address side:
  //   'unchecked'         — never verified (or last attempt failed)
  //   'corrected'         — provider returned a suggested address; the
  //                         shipment field has been swapped to that
  //                         suggestion but it has NOT yet been re-verified
  //   'validated'         — provider returned validated AND the current
  //                         shipment address still matches the snapshot
  //                         that was validated (no edits since)
  //   'stale_after_edit'  — was previously validated, but the operator has
  //                         since edited a rating-relevant address field;
  //                         must be re-checked and re-validated
  //   'failed'            — provider explicitly rejected the address
  //
  // Get Rates is gated on BOTH sides being in 'validated' state. 'corrected'
  // and 'stale_after_edit' are NOT acceptance states — the operator must
  // proceed through Check → Validate again.
  type AddressReadinessState = 'unchecked' | 'corrected' | 'validated' | 'stale_after_edit' | 'failed';

  // Address-shape fingerprint (line1/line2/city/state/postal/country). Used to
  // detect when the current shipment address differs from the one that was
  // validated. Carrier validation only verifies address shape — name/phone
  // changes do NOT invalidate verification, so they're excluded.
  function addrShapeFingerprint(addr: ShipmentAddress | undefined | null): string {
    if (!addr) return '';
    const norm = (s: string | undefined) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return [norm(addr.line1), norm(addr.line2), norm(addr.city), norm(addr.state), norm(addr.postalCode), norm(addr.country)].join('|');
  }

  function getAddressReadinessForSide(
    shipment: Shipment,
    side: 'origin' | 'destination'
  ): AddressReadinessState {
    const validation = side === 'origin' ? shipment.originAddressValidation : shipment.addressValidation;
    const currentAddr = side === 'origin' ? shipment.originAddress : shipment.destinationAddress;
    if (!validation) return 'unchecked';
    if (validation.status === 'failed') return 'unchecked';
    // Compare current address to the snapshot that was actually evaluated.
    // For 'validated' results, the snapshot is `originalAddress` (since the
    // address WAS the one that passed). For 'corrected' results, the snapshot
    // we expect to validate next is the `suggestedAddress` that we swapped
    // into the shipment field.
    const snapshot = validation.status === 'corrected'
      ? (validation.suggestedAddress || validation.originalAddress)
      : (validation.originalAddress);
    const currentFp = addrShapeFingerprint(currentAddr);
    const snapshotFp = addrShapeFingerprint(snapshot);
    if (validation.status === 'validated') {
      return currentFp === snapshotFp ? 'validated' : 'stale_after_edit';
    }
    if (validation.status === 'corrected') {
      // If the operator edited away from the suggestion, we treat that as
      // unchecked rather than corrected — the suggestion is no longer the
      // address in the form, so re-checking from scratch is honest.
      return currentFp === snapshotFp ? 'corrected' : 'unchecked';
    }
    return 'unchecked';
  }

  // Strict validated-and-fresh readiness. Per operational policy, a `corrected`
  // result is an INTERMEDIATE state and must NOT unlock Get Rates. Likewise a
  // previously-validated address that has since been edited is `stale_after_edit`
  // and must NOT remain accepted — both conditions force the operator back
  // through Check → Validate before rates can be fetched.
  function isAddressAccepted(shipment: Shipment): boolean {
    return getAddressReadinessForSide(shipment, 'destination') === 'validated';
  }

  function isOriginAddressAccepted(shipment: Shipment): boolean {
    return getAddressReadinessForSide(shipment, 'origin') === 'validated';
  }

  // =====================================================================================
  // Service Points & Pickup Requests (Phase 2) — provider capability + handlers
  // =====================================================================================
  // Capability map is honest: it reflects what each provider's adapter actually supports
  // today. Manual mode is always false for both since by definition manual shipments are
  // not orchestrated through a provider API. To enable a provider, set the flag here AND
  // implement the corresponding adapter calls (this UI talks to a stub for now — clearly
  // labeled in the modal so operators understand the data is not live carrier inventory).
  // Provider capability map. Each provider differs in what it actually supports.
  // Service-point lookup is intentionally false everywhere because no provider in our
  // current stack exposes a unified service-point locator (see Phase 2.4 audit notes
  // in replit.md and the Carrier Locator Settings card in Settings → Carrier Locators).
  // Live service-point search requires carrier-specific adapters (USPS / UPS / FedEx)
  // configured per store; until those adapters are wired, the modal shows an honest
  // unavailable state with a manual-entry fallback.
  //
  // Pickup capability fields are provider-specific and reflect real-world behavior:
  //   - supportsPickupRequests:           does the provider expose a pickup API at all
  //   - supportsPickupCancellation:       can the pickup be cancelled via API
  //   - pickupRequiresProviderConfirmation: true => UI must wait for carrier confirmation
  //   - pickupMayRequireRateSelectionOrPurchase: true => carrier may bill per pickup
  //   - pickupCarrierCoverage:            list of carriers the provider can schedule pickups for
  //   - pickupStatusModel:                'request_lifecycle' | 'webhook_streamed'
  type ProviderCaps = {
    servicePoints: boolean;
    // Capability declaration (does the provider expose pickup at all)
    pickupRequests: boolean;
    // Live wiring: is the in-app booking flow actually wired to the real
    // provider API right now? When false, the UI must clearly say so and fall
    // back to a local-only pickup record (no fake confirmation number).
    supportsLivePickupBooking: boolean;
    supportsPickupCancellation: boolean;
    pickupRequiresProviderConfirmation: boolean;
    // EasyPost-style: create returns rates, then a separate /buy purchases.
    pickupNeedsRateSelection: boolean;
    pickupNeedsRatePurchase: boolean;
    // Whether the provider needs the underlying provider shipment id (set when
    // a label was bought) to attach the pickup to.
    pickupNeedsProviderShipmentId: boolean;
    // Whether the provider needs a per-carrier account/connection on file
    // (e.g. ShipStation per-carrier connect screens).
    pickupNeedsCarrierAccount: boolean;
    // ─── Required-field model (carrier-/provider-specific) ─────────────
    // Each flag declares an explicit booking requirement of the provider's
    // pickup endpoint. The preflight (`getPickupPayloadPreflight`) and the
    // operator UI both read these flags so requirements are never implicit
    // or scattered. EasyPost, Shippo, and ShipStation are all modeled here
    // as first-class providers.
    pickupRequiresVerifiedAddress: boolean;     // address must be carrier-verified
    pickupRequiresPickupWindow: boolean;        // min_datetime/max_datetime needed
    pickupRequiresContactName: boolean;         // person to ask for at the door
    pickupRequiresContactPhone: boolean;        // driver-callable phone number
    pickupRequiresInstructions: boolean;        // pickup instructions / notes
    pickupRequiresLabelIds: boolean;            // Shippo: transactions[] of bought label ids
    // ───────────────────────────────────────────────────────────────────
    pickupCarrierCoverage: string[];
    pickupStatusModel: 'request_lifecycle' | 'webhook_streamed';
    pickupTestModeLimitations: string;
    pickupAuditNote: string;
  };
  const PROVIDER_CAPABILITIES: Record<string, ProviderCaps> = {
    easypost: {
      servicePoints: false,
      pickupRequests: true,
      supportsLivePickupBooking: true,
      supportsPickupCancellation: true,
      pickupRequiresProviderConfirmation: true,
      pickupNeedsRateSelection: true,
      pickupNeedsRatePurchase: true,
      pickupNeedsProviderShipmentId: true,
      pickupNeedsCarrierAccount: false,
      pickupRequiresVerifiedAddress: true,
      pickupRequiresPickupWindow: true,
      pickupRequiresContactName: true,
      pickupRequiresContactPhone: true,
      // Confirmed at runtime — EasyPost rejects /v2/pickups without
      // `instructions`. The field must be a non-empty string telling the
      // driver where/how to pick up the parcel ("Front desk", "Side door
      // ring bell", "Back loading dock 3"). We require it in the form.
      pickupRequiresInstructions: true,
      pickupRequiresLabelIds: false,
      pickupCarrierCoverage: ['USPS', 'UPS', 'FedEx', 'DHL'],
      pickupStatusModel: 'webhook_streamed',
      pickupTestModeLimitations: 'EasyPost test mode (api keys starting with EZTK_) does not actually dispatch a carrier; pickups can be created/bought/cancelled but no truck arrives. Use a production key for real pickups.',
      pickupAuditNote: 'EasyPost pickups: POST /v2/pickups (requires address, shipment id, min/max_datetime, instructions) → returns pickup_rates → POST /v2/pickups/{id}/buy with carrier+service. A carrier confirmation number is issued after buy. Live API is wired in this app (server adapter calls real EasyPost).',
    },
    shippo: {
      servicePoints: false,
      pickupRequests: true,
      supportsLivePickupBooking: false,
      supportsPickupCancellation: true,
      pickupRequiresProviderConfirmation: false,
      pickupNeedsRateSelection: false,
      pickupNeedsRatePurchase: false,
      pickupNeedsProviderShipmentId: false,
      pickupNeedsCarrierAccount: true,
      // Shippo's /pickups endpoint requires: carrier_account, location
      // (address + building_location_type + instructions), requested_start
      // /end_time, transactions[] (label IDs to be picked up). All four
      // are real provider requirements, modeled here even though the
      // adapter is currently capability-gated to a local-only record.
      pickupRequiresVerifiedAddress: true,
      pickupRequiresPickupWindow: true,
      pickupRequiresContactName: true,
      pickupRequiresContactPhone: true,
      pickupRequiresInstructions: true,
      pickupRequiresLabelIds: true,
      pickupCarrierCoverage: ['USPS', 'UPS', 'DHL Express'],
      pickupStatusModel: 'request_lifecycle',
      pickupTestModeLimitations: 'Shippo test mode supports /pickups create+cancel without dispatching a carrier. Live wiring in this app is not yet done.',
      pickupAuditNote: 'Shippo pickups: single-shot POST /pickups (requires carrier_account, location.address, location.instructions, requested_start_time/end_time, transactions[]) returns confirmation_code (no separate buy). Adapter is capability-gated in this app — local-only pickup record will be created instead. Switch to EasyPost for live booking.',
    },
    shipstation: {
      servicePoints: false,
      // Capability is true (the model supports a pickup record) but live API
      // is not — ShipStation has no generic pickup endpoint.
      pickupRequests: true,
      supportsLivePickupBooking: false,
      supportsPickupCancellation: false,
      pickupRequiresProviderConfirmation: false,
      pickupNeedsRateSelection: false,
      pickupNeedsRatePurchase: false,
      pickupNeedsProviderShipmentId: false,
      pickupNeedsCarrierAccount: true,
      // ShipStation has NO generic pickup API — there is nothing to
      // preflight at the provider layer. We still capture pickup window
      // and contact info as an internal record so the operator has it
      // when scheduling with the carrier directly. Provider-required
      // fields are all false because there is no provider call.
      pickupRequiresVerifiedAddress: false,
      pickupRequiresPickupWindow: false,
      pickupRequiresContactName: false,
      pickupRequiresContactPhone: false,
      pickupRequiresInstructions: false,
      pickupRequiresLabelIds: false,
      pickupCarrierCoverage: [],
      pickupStatusModel: 'request_lifecycle',
      pickupTestModeLimitations: 'ShipStation does not expose pickup booking via API in any environment. Pickups are scheduled in ShipStation’s own UI or directly with the carrier.',
      pickupAuditNote: 'ShipStation pickups: no generic API. App will record a local-only pickup intent (no confirmation number). Operator must schedule with the carrier separately. Switch to EasyPost for live in-app booking.',
    },
  };

  function getProviderCapabilities(shipment: Shipment): { servicePoints: boolean; pickupRequests: boolean; reason?: string; spReason?: string; puReason?: string } {
    const isManual = getShipmentMode(shipment) === 'manual';
    if (isManual) {
      const r = 'Manual mode — not provider-orchestrated. No active shipping provider configured for this shipment.';
      return { servicePoints: false, pickupRequests: false, reason: r, spReason: `Service points not available for this shipment. ${r}`, puReason: `Carrier pickup not available for this shipment. ${r}` };
    }
    if (!activeProviderId) {
      const r = 'No active shipping provider configured.';
      return { servicePoints: false, pickupRequests: false, reason: r, spReason: `Service points not available for this shipment. ${r}`, puReason: `Carrier pickup not available for this shipment. ${r}` };
    }
    const caps = PROVIDER_CAPABILITIES[activeProviderId.toLowerCase()];
    if (!caps) {
      const r = `Provider "${activeProviderId}" capabilities not registered.`;
      return { servicePoints: false, pickupRequests: false, reason: r, spReason: `Service points not available for this shipment. ${r}`, puReason: `Carrier pickup not available for this shipment. ${r}` };
    }
    // Plan-level gating: System Owner Plans & Features matrix governs whether the
    // tenant's plan exposes service-point and/or pickup-request capabilities at all.
    // hasPermission() reads planFeatures + matrix overrides from sessionStorage.
    const planSP = planAllowsServicePoints;
    const planPU = planAllowsPickupRequests;
    const sp = caps.servicePoints && planSP;
    const pu = caps.pickupRequests && planPU;
    return {
      servicePoints: sp,
      pickupRequests: pu,
      reason: !sp && !pu ? 'Not available for this shipment.' : undefined,
      spReason: !sp
        ? (!caps.servicePoints
            ? `Service points not available for this shipment. The active provider (${activeProviderId}) does not expose a service-point selection API.`
            : `Service points are not included in your current plan.`)
        : undefined,
      puReason: !pu
        ? (!caps.pickupRequests
            ? `Carrier pickup not available for this shipment. The active provider (${activeProviderId}) does not expose a pickup-request API.`
            : `Carrier pickup is not included in your current plan.`)
        : undefined,
    };
  }

  // Lifecycle gates. Service-point selection is allowed before dispatch (the choice of
  // handoff method is meaningful only pre-dispatch). Pickup request requires a label
  // so the carrier has something to scan, and is also blocked once dispatched. Cancelling
  // a pickup is allowed up until the pickup completes.
  // Per QA business rule (Phase 2.2): Service Point and Carrier Pickup actions
  // are only meaningful when the shipment is fully Packed and ready for handoff.
  // Earlier statuses (Draft / Ready / Label Created) keep the controls locked
  // with a clear "shipment must be Packed" message. Manual-mode shipments are
  // unaffected because the entire Logistics tab is gated by provider capability.
  const SERVICE_POINT_EDITABLE_STATUSES: ShipmentStatus[] = ['Packed'];
  const PICKUP_REQUESTABLE_STATUSES: ShipmentStatus[] = ['Packed'];
  // Phase 2.6.1 — `partial_failed` is included so the operator can cancel
  // an orphaned provider pickup record (created but not booked). Without
  // cancel access these dangle on the EasyPost account forever.
  const PICKUP_CANCELLABLE_STATUSES: PickupRequestStatus[] = ['requested', 'scheduled', 'confirmed', 'partial_failed'];

  // Unified eligibility evaluators. Used everywhere — UI gating, action-handler
  // pre-checks, ZIP search activation — to guarantee a single source of truth.
  // Reason ordering matches operator priority: provider → plan → permission →
  // lifecycle → mutex. The first failing reason is surfaced.
  type Eligibility = { eligible: boolean; reason?: string; category?: 'provider' | 'plan' | 'permission' | 'lifecycle' | 'mutex' | 'pickup_address' | 'pickup_address_unverified' | 'pickup_payload' | 'pickup_address_ineligible' };
  function getServicePointEligibility(shipment: Shipment): Eligibility {
    // LIVE locator eligibility. Currently always fails at the provider category until
    // a carrier-specific locator adapter is configured under Settings → Carrier Locators.
    const caps = getProviderCapabilities(shipment);
    if (!caps.servicePoints) {
      const isManual = getShipmentMode(shipment) === 'manual';
      const isProviderMissing = !activeProviderId;
      if (isManual || isProviderMissing) return { eligible: false, reason: caps.spReason || caps.reason, category: 'provider' };
      if (!planAllowsServicePoints) return { eligible: false, reason: 'Service points are not included in your current plan.', category: 'plan' };
      return {
        eligible: false,
        reason: 'Live carrier service-point lookup requires carrier-specific production credentials and a carrier-specific locator adapter (USPS Locations, UPS Locator, FedEx Locations). Currently unavailable. Use manual entry below.',
        category: 'provider',
      };
    }
    if (!canSelectServicePoint) return { eligible: false, reason: 'You do not have permission to select a service point.', category: 'permission' };
    if (!SERVICE_POINT_EDITABLE_STATUSES.includes(shipment.status)) {
      return { eligible: false, reason: `Shipment must be Packed before a service point can be selected. Current status: ${shipment.status}.`, category: 'lifecycle' };
    }
    const pr = shipment.pickupRequest;
    if (pr && PICKUP_CANCELLABLE_STATUSES.includes(pr.status)) {
      return { eligible: false, reason: 'A carrier pickup is active. Cancel it first to switch to a service-point drop-off.', category: 'mutex' };
    }
    return { eligible: true };
  }
  // Manual entry eligibility — does NOT require provider locator capability, because
  // manual entry is the operator typing in a carrier-issued service-point reference
  // they obtained out-of-band (carrier website, customer email, etc.). Plan,
  // permission, lifecycle, and mutex still apply identically.
  function getServicePointManualEntryEligibility(shipment: Shipment): Eligibility {
    if (getShipmentMode(shipment) === 'manual') return { eligible: false, reason: 'Manual mode shipments are not provider-orchestrated. Service-point handoff is recorded directly on the shipment.', category: 'provider' };
    if (!activeProviderId) return { eligible: false, reason: 'No active shipping provider configured.', category: 'provider' };
    if (!planAllowsServicePoints) return { eligible: false, reason: 'Service points are not included in your current plan.', category: 'plan' };
    if (!canSelectServicePoint) return { eligible: false, reason: 'You do not have permission to select a service point.', category: 'permission' };
    if (!SERVICE_POINT_EDITABLE_STATUSES.includes(shipment.status)) {
      return { eligible: false, reason: `Shipment must be Packed before a service point can be selected. Current status: ${shipment.status}.`, category: 'lifecycle' };
    }
    const pr = shipment.pickupRequest;
    if (pr && PICKUP_CANCELLABLE_STATUSES.includes(pr.status)) {
      return { eligible: false, reason: 'A carrier pickup is active. Cancel it first to switch to a service-point drop-off.', category: 'mutex' };
    }
    return { eligible: true };
  }
  // ─────────────────────────────────────────────────────────────────────
  // Pickup address — single source of truth.
  //
  // EasyPost (and every other pickup-capable carrier we've integrated) needs
  // an explicit address for the *pickup location*. Earlier code passed
  // `pickupAddress: ship.originAddress` AND `is_account_address: true` at the
  // same time, which is contradictory: `is_account_address: true` tells
  // EasyPost "this is the address registered on my EasyPost account, you
  // don't need to verify it" — when the supplied address differs from the
  // account address (which is the normal multi-store case here), EasyPost
  // rejects with semantic-error / address-validation failures.
  //
  // Source-of-truth rule: pickup ALWAYS uses the shipment origin address
  // (`shipment.originAddress`) — i.e. the same address the operator already
  // validates for shipping. We never silently reach into a provider account
  // address. `isAccountAddress` is forced to `false` so EasyPost validates
  // and uses the address we sent. If a shop later wants account-address
  // mode, that becomes an explicit per-store setting (out of scope).
  // ─────────────────────────────────────────────────────────────────────
  function resolvePickupAddress(shipment: Shipment): { address: ShipmentAddress; source: 'shipment_origin' | 'pickup_override'; sourceLabel: string } {
    // Phase 2.6 — pickup-only override takes precedence when set. The
    // override is intentionally separate from originAddress so that label
    // from_address (locked once the label is purchased) and the pickup
    // dispatch address can diverge. This is the dedicated recovery path
    // when the carrier rejects the origin for pickup booking but the
    // label is already paid for. The override never touches the printed
    // label.
    if (shipment.pickupOverrideAddress) {
      const ov = shipment.pickupOverrideAddress;
      // pickupLocationDetail is operator-supplied dispatch context. If
      // line2 is empty on the override, mirror the detail into line2 so
      // the carrier sees suite/dock/door/unit alongside the street. If
      // line2 is already set, leave it alone — operator intent wins.
      const merged: ShipmentAddress = shipment.pickupLocationDetail && (!ov.line2 || !ov.line2.trim())
        ? { ...ov, line2: shipment.pickupLocationDetail }
        : ov;
      return {
        address: merged,
        source: 'pickup_override',
        sourceLabel: 'Pickup-only dispatch address (overrides label from-address for the driver)',
      };
    }
    return {
      address: shipment.originAddress,
      source: 'shipment_origin',
      sourceLabel: 'Shipment origin address (the address you validated for shipping)',
    };
  }

  // Preflight validation against the *actual* pickup address that will be
  // sent to the provider — this runs BEFORE the EasyPost call so obviously
  // incomplete pickup input never reaches the network. Returns the list of
  // missing/invalid fields so the UI can show the operator exactly what to
  // fix and where (origin address editor).
  function validatePickupAddress(addr: ShipmentAddress | undefined | null): { ready: boolean; missing: string[]; warnings: string[] } {
    const missing: string[] = [];
    const warnings: string[] = [];
    if (!addr) return { ready: false, missing: ['address'], warnings: [] };
    if (!addr.line1 || !addr.line1.trim()) missing.push('Street address (line 1)');
    if (!addr.city || !addr.city.trim()) missing.push('City');
    if (!addr.state || !addr.state.trim()) missing.push('State / region');
    if (!addr.postalCode || !addr.postalCode.trim()) missing.push('Postal / ZIP code');
    if (!addr.country || !addr.country.trim()) missing.push('Country');
    // Carriers require either a person (name) OR a company at the pickup
    // location so the driver knows whom to ask for. Either is acceptable.
    if ((!addr.name || !addr.name.trim()) && (!addr.company || !addr.company.trim())) {
      missing.push('Contact name or company');
    }
    // Phone is required by EasyPost for pickup. The fallback chain in the
    // caller is `pickupForm.contactPhone` → `addr.phone`, so we accept either
    // here. The check happens in handleRequestPickup which also has form data.
    if (!addr.phone || addr.phone.replace(/\D/g, '').length < 10) {
      warnings.push('Phone (recommended; carrier driver may not be able to reach contact)');
    }
    return { ready: missing.length === 0, missing, warnings };
  }

  // Stable fingerprint used to detect when the resolved pickup address has
  // changed since the last verification. Carrier validation is sensitive to
  // line1/line2/city/state/postal/country only — name/phone changes do not
  // invalidate a delivery verification, so we exclude them. Case- and
  // whitespace-insensitive so trivial edits don't churn the verification.
  function pickupAddrFingerprint(addr: ShipmentAddress | undefined | null): string {
    if (!addr) return '';
    const norm = (s: string | undefined) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return [norm(addr.line1), norm(addr.line2), norm(addr.city), norm(addr.state), norm(addr.postalCode), norm(addr.country)].join('|');
  }

  // Phase 2.6.1 — provider-critical pickup PAYLOAD fingerprint. Used for
  // pickup-eligibility memory invalidation. Includes every field the
  // provider booking call actually sends, so changing any of them clears
  // the prior failed-attempt memory and reopens the retry path. The
  // address-only `pickupAddrFingerprint` above is intentionally NARROWER:
  // it scopes the address-verification record because verification really
  // is about the address only — but eligibility (the carrier-rejected-this-
  // exact-payload memory) must respond to contact/window/instructions
  // edits too, otherwise the operator sees "ineligible" indefinitely after
  // fixing a contact-phone mutation that caused the original rejection.
  function pickupContactDigits(s: string | undefined | null): string {
    return (s || '').replace(/\D/g, '');
  }
  function pickupPayloadFingerprint(shipment: Shipment, form: { contactName: string; contactPhone: string; notes: string; date: string; windowStart: string; windowEnd: string }): string {
    const addr = resolvePickupAddress(shipment).address;
    const norm = (s: string | undefined) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const contactName = norm(form.contactName.trim() || addr.name || addr.company);
    // Phone normalized to digits-only (10-digit US after stripping leading
    // 1) so cosmetic edits like adding/removing dashes/parens do NOT
    // invalidate the memory, but a real digit change does.
    const phoneRaw = form.contactPhone.trim() || addr.phone || '';
    const phoneDigits = pickupContactDigits(phoneRaw);
    const phoneCanonical = phoneDigits.length === 11 && phoneDigits.startsWith('1') ? phoneDigits.slice(1) : phoneDigits;
    const instructions = norm([shipment.pickupLocationDetail?.trim(), form.notes.trim()].filter(Boolean).join(' — '));
    return [
      pickupAddrFingerprint(addr),
      contactName,
      phoneCanonical,
      instructions,
      norm(form.date),
      norm(form.windowStart),
      norm(form.windowEnd),
    ].join('||');
  }

  // Resolve the operator-facing pickup-address verification status for a
  // shipment. This is what the eligibility gate and the pickup banner read.
  // Status semantics are intentionally narrow:
  //   - unverified: no verification attempt has been recorded
  //   - verifying: a verification call is currently in flight
  //   - stale: a prior verification exists but the address has been edited
  //            since (fingerprint mismatch) — must re-verify
  //   - verified: passed strict verification on the current address
  //   - corrected_pending: provider returned a corrected/normalized address
  //                       and the operator has not yet accepted it
  //   - corrected_accepted: the operator accepted the corrected address
  //                        AND that corrected address is now the origin
  //                        (fingerprint matches the suggestion) — equivalent
  //                        to verified for booking purposes
  //   - failed: provider rejected the address; pickup must remain blocked
  type PickupVerifyStatus = 'unverified' | 'verifying' | 'stale' | 'verified' | 'corrected_pending' | 'corrected_accepted' | 'failed';
  function getPickupVerificationStatus(shipment: Shipment): { status: PickupVerifyStatus; record?: PickupVerify; currentFingerprint: string } {
    const resolved = resolvePickupAddress(shipment);
    const currentFingerprint = pickupAddrFingerprint(resolved.address);
    if (pickupVerifying[shipment.id]) return { status: 'verifying', currentFingerprint };
    const rec = pickupAddrVerify[shipment.id];
    if (rec) {
      if (rec.fingerprint !== currentFingerprint) return { status: 'stale', record: rec, currentFingerprint };
      if (rec.status === 'verified') return { status: 'verified', record: rec, currentFingerprint };
      if (rec.status === 'failed') return { status: 'failed', record: rec, currentFingerprint };
      if (rec.status === 'corrected') return { status: rec.accepted ? 'corrected_accepted' : 'corrected_pending', record: rec, currentFingerprint };
    }
    // Free pass: if the shipment's origin shipping-address validation is
    // already 'validated' (or accepted-corrected) AND its fingerprint
    // matches the current origin, treat as verified for pickup too. The
    // pickup address IS the shipment origin (resolvePickupAddress) and the
    // EasyPost delivery-verification endpoint is the same, so a fresh
    // shipping-side verification is equally valid for pickup readiness.
    // Phase 2.6 — DO NOT extend this free pass when a pickup-override
    // address is active. The origin's validation says nothing about the
    // override, so the override must be verified on its own.
    if (resolved.source === 'pickup_override') {
      return { status: 'unverified', currentFingerprint };
    }
    const sv = shipment.originAddressValidation;
    if (sv && (sv.status === 'validated' || (sv.status === 'corrected' && sv.accepted))) {
      const svFp = pickupAddrFingerprint(sv.suggestedAddress || sv.originalAddress);
      if (svFp === currentFingerprint) {
        return {
          status: 'verified',
          record: { fingerprint: currentFingerprint, status: 'verified', messages: sv.messages || [], providerRef: sv.providerRef, verifiedAt: sv.validatedAt || new Date().toISOString() },
          currentFingerprint,
        };
      }
    }
    return { status: 'unverified', currentFingerprint };
  }

  // Phase 2.5.8 — pickup-eligibility lookup. Distinct from delivery
  // verification. Returns:
  //   - 'unknown'   : never attempted on this address snapshot, or the
  //                   address has changed since the last attempt
  //                   (fingerprint mismatch invalidates prior memory)
  //   - 'confirmed' : pickup_create succeeded for this exact snapshot
  //   - 'failed'    : pickup_create failed for this exact snapshot — the
  //                   carrier rejected the address for pickup booking,
  //                   regardless of whether delivery verification passed.
  //                   The UI must NOT present a "ready" state until the
  //                   address changes or a fresh successful create occurs.
  type PickupEligibilityStatus = 'unknown' | 'confirmed' | 'failed';
  // Phase 2.7 — Pickup Forecast at Get Rates time. CARRIER-AWARE, NON-FINAL.
  // This is an estimate the operator sees on each returned rate row to help
  // them compare options. It is NOT a booking and does NOT promise success.
  // The real pickup create/buy flow remains the authoritative source of
  // truth — same as today.
  //
  // States:
  //   'likely'           — High confidence the carrier supports a pickup at
  //                        this service level when an EasyPost provider is
  //                        active. (USPS over EasyPost.)
  //   'final_check'      — Pickup-capable, but carrier-side cutoffs / lead
  //                        times / account configuration determine whether
  //                        the actual pickup_create call will return rates.
  //                        The operator should expect to confirm this after
  //                        label purchase. (UPS / FedEx / DHL over EasyPost.)
  //   'setup_required'   — Provider/account configuration is needed before
  //                        pickup will succeed (e.g. provider not connected,
  //                        capability flag off, missing credentials).
  //   'not_capable'      — The active provider explicitly cannot book a
  //                        pickup (capability flag is false). Operator must
  //                        use drop-off / Service Point.
  //   'unknown'          — Forecast cannot be computed (manual mode, unknown
  //                        carrier, or no active provider). The operator
  //                        will only know after attempting pickup booking.
  type PickupForecastState = 'likely' | 'final_check' | 'setup_required' | 'not_capable' | 'unknown';

  // Phase 2.7.1 — UPS service-family pickup classification.
  //
  // Background: UPS is not a single pickup-capable bucket through EasyPost.
  // QA confirmed at least one selected UPS service returned
  // "UPS DAP pickup rates are not supported" at pickup_create time. The
  // root cause is that EasyPost exposes multiple UPS rate sources whose
  // pickup eligibility is not uniform:
  //
  //   - UPSDAP carrier account (Daily/Direct Account Program rates) —
  //     EasyPost has historically returned the literal error
  //     "UPS DAP pickup rates are not supported" when pickup_create is
  //     attempted against rates carrying carrier="UPSDAP". Treat as
  //     not_capable (drop-off only).
  //
  //   - UPS Mail Innovations and UPS SurePost / Ground Saver —
  //     final-mile delivery is handed off to USPS. Pickup at the shipper
  //     for these services is constrained / typically unsupported through
  //     EasyPost's pickup flow. Treat as not_capable.
  //
  //   - Standard UPS services (Ground, NextDayAir family, 2nd/3rd Day,
  //     Worldwide Express / Saver / Expedited / Standard) — pickup is
  //     supported but always subject to per-zone cutoffs / lead-times,
  //     so we keep them at final_check (truthful: cannot promise).
  //
  //   - Anything outside those sets — unknown rather than guessing.
  //
  // Evidence basis: rate.carrier (the EasyPost carrier string, e.g.
  // "UPSDAP" vs "UPS"), rate.serviceCode (machine code), and
  // rate.serviceName (display string). We match conservatively on all
  // three so a slight drift in any one field does not silently
  // misclassify a service. We do not fabricate a classification just
  // because the carrier string contains "UPS".
  type UpsPickupClass = 'final_check' | 'not_capable' | 'unknown';
  function classifyUpsServicePickup(rate: ShippingRate): { state: UpsPickupClass; label: string; detail: string } {
    const carrier = (rate.carrier || '').toUpperCase().replace(/\s+/g, '');
    const code = (rate.serviceCode || '').toUpperCase().replace(/[\s_-]+/g, '');
    const name = (rate.serviceName || '').toUpperCase();

    // Hard not_capable: UPSDAP carrier account. EasyPost surfaces these
    // as carrier="UPSDAP" and the live pickup_create call returns
    // "UPS DAP pickup rates are not supported".
    if (carrier === 'UPSDAP') {
      return {
        state: 'not_capable',
        label: 'Not pickup-capable (UPS DAP)',
        detail: 'This rate is from the UPS DAP (Daily/Direct Account Program) account. Scheduled pickup is not supported for DAP rates through the current provider flow. Use drop-off, or choose a non-DAP UPS service to enable pickup.',
      };
    }

    // UPS SurePost / Ground Saver — final mile is USPS, pickup at the
    // shipper for the UPS leg is not bookable through EasyPost's pickup
    // flow in practice.
    const isSurePostOrGroundSaver =
      code === 'UPSSUREPOST' ||
      code === 'SUREPOST' ||
      code === 'UPSGROUNDSAVER' ||
      code === 'GROUNDSAVER' ||
      name.includes('SUREPOST') ||
      name.includes('GROUND SAVER');
    if (isSurePostOrGroundSaver) {
      return {
        state: 'not_capable',
        label: 'Not pickup-capable (USPS final mile)',
        detail: 'UPS SurePost / Ground Saver hand the final mile to USPS. Scheduled UPS pickup is not bookable for these services through the current provider flow. Use drop-off, or choose a standard UPS service.',
      };
    }

    // UPS Mail Innovations family — also USPS-handoff oriented, no
    // bookable UPS pickup through the provider flow.
    const isMailInnovations =
      carrier.includes('UPSMAILINNOVATIONS') ||
      code.includes('MAILINNOVATIONS') ||
      name.includes('MAIL INNOVATIONS');
    if (isMailInnovations) {
      return {
        state: 'not_capable',
        label: 'Not pickup-capable (UPS Mail Innovations)',
        detail: 'UPS Mail Innovations is a USPS-handoff product. Scheduled UPS pickup is not supported through the current provider flow. Use drop-off or choose a standard UPS service.',
      };
    }

    // Known pickup-capable UPS services — Ground, NextDayAir variants,
    // SecondDayAir variants, 3DaySelect, and Worldwide international
    // services. All still final_check because cutoffs / lead-times
    // determine whether the chosen pickup window will actually book.
    const knownFinalCheckCodes = new Set([
      'GROUND',
      'UPSGROUND',
      'NEXTDAYAIR',
      'NEXTDAYAIRSAVER',
      'NEXTDAYAIREARLYAM',
      'NEXTDAYAIREARLY',
      'SECONDDAYAIR',
      '2NDDAYAIR',
      'SECONDDAYAIRAM',
      '2NDDAYAIRAM',
      'THREEDAYSELECT',
      '3DAYSELECT',
      'STANDARD',
      'UPSSTANDARD',
      'EXPRESS',
      'UPSEXPRESS',
      'EXPRESSPLUS',
      'UPSEXPRESSPLUS',
      'EXPRESSSAVER',
      'UPSEXPRESSSAVER',
      'SAVER',
      'UPSSAVER',
      'WORLDWIDEEXPRESS',
      'WORLDWIDEEXPRESSPLUS',
      'WORLDWIDEEXPEDITED',
      'WORLDWIDESAVER',
      'EXPEDITED',
    ]);
    if (knownFinalCheckCodes.has(code)) {
      return {
        state: 'final_check',
        label: 'Pickup-capable — final check after label purchase',
        detail: 'UPS pickups depend on per-zone cutoff times and lead-time requirements. Rates are available at pickup-create time only when those constraints are satisfied for the chosen pickup window.',
      };
    }

    // Conservative fallback: a UPS-family rate we haven't explicitly
    // modeled. Honest "unknown" rather than a green light.
    return {
      state: 'unknown',
      label: 'Unknown until pickup check',
      detail: `UPS service "${rate.serviceName || rate.serviceCode || 'unknown'}" is outside the set of UPS services this forecast explicitly classifies. Pickup eligibility will be determined when the carrier pickup request is created.`,
    };
  }

  function getPickupForecastForRate(rate: ShippingRate): { state: PickupForecastState; label: string; detail: string } {
    if (!activeProviderId) {
      return { state: 'setup_required', label: 'Account/setup required', detail: 'No active shipping provider is configured. Pickup is not possible until a provider is connected under Settings.' };
    }
    const caps = PROVIDER_CAPABILITIES[activeProviderId.toLowerCase()];
    if (!caps) {
      return { state: 'unknown', label: 'Unknown until pickup check', detail: 'Provider capability is not registered for this active provider — forecast unavailable.' };
    }
    if (!caps.pickupRequests) {
      return { state: 'not_capable', label: 'Not pickup-capable', detail: `${activeProviderId} does not currently support live pickup booking in this app. Use Service Point / drop-off, or switch to a provider that does.` };
    }
    const carrierUpper = (rate.carrier || '').toUpperCase();
    // EasyPost path — by far the dominant case in this app.
    const isEasyPost = activeProviderId.toLowerCase() === 'easypost';
    if (isEasyPost) {
      if (carrierUpper.includes('USPS')) {
        // Phase 2.8 — softened wording: USPS Package Pickup is FREE for
        // Priority Mail / Express / International / Returns when the
        // shipper qualifies, but not universally and not for same-day
        // pickup. We do not promise "no fee" here — the fee class is
        // surfaced separately by getPickupFeeClassForRate.
        return { state: 'likely', label: 'Likely pickup-capable', detail: 'USPS pickups over EasyPost are typically available. Final eligibility (and exact fee, if any) is confirmed when the carrier pickup request is created.' };
      }
      // Phase 2.7.1 — UPS family is no longer a single bucket. Delegate
      // to the service-family classifier so UPS DAP, SurePost / Ground
      // Saver, and Mail Innovations are surfaced as not_capable BEFORE
      // pickup_create, while standard UPS services remain final_check.
      if (carrierUpper.includes('UPS')) {
        const ups = classifyUpsServicePickup(rate);
        return ups;
      }
      if (carrierUpper.includes('FEDEX')) {
        return { state: 'final_check', label: 'Pickup-capable — final check after label purchase', detail: 'FedEx pickups depend on service-specific cutoff/ready/close times. Express vs Ground may have different windows. Pickup_create will return rates only when the chosen window satisfies the carrier constraints.' };
      }
      if (carrierUpper.includes('DHL')) {
        return { state: 'final_check', label: 'Pickup-capable — final check after label purchase', detail: 'DHL pickups depend on account configuration and service-area cutoffs. Final eligibility is confirmed when the pickup is created.' };
      }
      return { state: 'unknown', label: 'Unknown until pickup check', detail: `Carrier "${rate.carrier}" is outside the USPS/UPS/FedEx/DHL set this forecast covers. Pickup eligibility will be determined when the carrier pickup request is created.` };
    }
    // Non-EasyPost providers: capability says pickup is supported, but we
    // don't model carrier-specific cutoffs for them here. Honest "unknown".
    return { state: 'unknown', label: 'Unknown until pickup check', detail: `Pickup eligibility for ${rate.carrier} via ${activeProviderId} is determined at the time of the pickup request.` };
  }

  // Phase 2.8 — Pickup fee class (orthogonal to forecast).
  //
  // Rationale: forecast answers "is this service pickup-bookable?". Fee
  // class answers "if it IS booked, will there typically be a per-pickup
  // fee?". Collapsing the two into a combined state creates a
  // combinatorial mess; keeping them as two narrow fields lets each
  // rate row show both at a glance with honest, conservative wording.
  //
  // INTENTIONALLY: NO DOLLAR AMOUNTS HERE. Phase 2.8 only exposes the
  // fee CLASS — the exact fee comes from pickup.create's pickup_rates
  // and is rendered in the booking flow (Phase 2.9, not yet
  // implemented).
  //
  // States:
  //   'pickup_may_be_free'   — shipper-typical free pickup at the
  //                            chosen service level (USPS Priority /
  //                            Express / International / Returns over
  //                            EasyPost). Word it as "may be" — the
  //                            actual fee is confirmed at pickup_create.
  //   'pickup_fee_likely'    — carrier charges a per-pickup fee for
  //                            this service in the dominant case
  //                            (UPS On-Call, FedEx Ground without a
  //                            scheduled pickup).
  //   'fee_depends_on_account' — varies by account/contract
  //                              configuration (DHL, FedEx Express,
  //                              UPS contract rates).
  //   'not_applicable'       — service is not pickup-capable at all
  //                            (forecast === 'not_capable'); fee is
  //                            moot.
  //   'unknown'              — manual mode, unknown carrier, no active
  //                            provider, or a service the model does
  //                            not classify.
  type PickupFeeClass = 'pickup_may_be_free' | 'pickup_fee_likely' | 'fee_depends_on_account' | 'not_applicable' | 'unknown';
  function getPickupFeeClassForRate(rate: ShippingRate, forecastState: PickupForecastState): { state: PickupFeeClass; label: string; detail: string } {
    // Forecast already says it cannot be picked up — fee is moot.
    if (forecastState === 'not_capable') {
      return { state: 'not_applicable', label: 'Fee N/A', detail: 'This service is not pickup-bookable through the current provider flow, so a pickup fee does not apply.' };
    }
    if (forecastState === 'setup_required' || !activeProviderId) {
      return { state: 'unknown', label: 'Fee unknown', detail: 'Provider setup is incomplete. The pickup fee class will be determinable once a provider is configured.' };
    }
    const isEasyPost = activeProviderId.toLowerCase() === 'easypost';
    if (!isEasyPost) {
      // Non-EasyPost providers — we don't model their fee tables here.
      return { state: 'unknown', label: 'Fee unknown', detail: `Pickup fee class for ${rate.carrier} via ${activeProviderId} is determined at the time of the pickup request.` };
    }
    const carrierUpper = (rate.carrier || '').toUpperCase();
    if (carrierUpper.includes('USPS')) {
      // USPS Package Pickup is free for Priority Mail / Express /
      // International / Returns from the shipper's address. Same-day
      // pickup is fee-bearing. We say "may be free" rather than
      // "free" — the exact fee is confirmed at pickup_create.
      return { state: 'pickup_may_be_free', label: 'Pickup may be free', detail: 'USPS Package Pickup is typically free at the shipper for qualifying services (Priority Mail, Express, International, Returns) when scheduled in advance. Same-day pickup may carry a fee. Exact fee is confirmed when the pickup request is created.' };
    }
    if (carrierUpper.includes('UPS')) {
      // UPS On-Call Pickup is fee-bearing in the dominant US case.
      // Some UPS contract / Worldwide rates include pickup — we mark
      // those as fee_depends_on_account where we can detect them.
      const code = (rate.serviceCode || '').toUpperCase().replace(/[\s_-]+/g, '');
      const isWorldwide = code.startsWith('WORLDWIDE') || code === 'STANDARD' || code === 'UPSSTANDARD';
      if (isWorldwide) {
        return { state: 'fee_depends_on_account', label: 'Fee depends on account', detail: 'UPS Worldwide / international service pickup fees vary by account contract. Some contracts include pickup; others bill per pickup. Exact fee is confirmed when the pickup request is created.' };
      }
      return { state: 'pickup_fee_likely', label: 'Pickup fee likely', detail: 'UPS On-Call Pickup typically carries a per-pickup fee that varies by service tier and residential vs commercial address. Exact fee is confirmed when the pickup request is created.' };
    }
    if (carrierUpper.includes('FEDEX')) {
      const code = (rate.serviceCode || '').toUpperCase().replace(/[\s_-]+/g, '');
      const name = (rate.serviceName || '').toUpperCase();
      // FedEx Express on-demand pickup is included with an Express
      // shipping account; FedEx Ground on-demand pickup is fee-bearing
      // without a scheduled pickup contract.
      const isExpress = code.includes('EXPRESS') || code.includes('OVERNIGHT') || code.includes('FIRST') || code.includes('PRIORITY') || code.includes('STANDARD') || name.includes('EXPRESS') || name.includes('OVERNIGHT') || name.includes('FIRST') || name.includes('PRIORITY OVERNIGHT');
      const isGround = code.includes('GROUND') || code.includes('HOMEDELIVERY') || code.includes('SMARTPOST') || name.includes('GROUND') || name.includes('HOME DELIVERY') || name.includes('SMARTPOST');
      if (isExpress && !isGround) {
        return { state: 'fee_depends_on_account', label: 'Fee depends on account', detail: 'FedEx Express on-demand pickup is typically included with a FedEx Express shipping account. Fee, if any, is confirmed when the pickup request is created.' };
      }
      if (isGround) {
        return { state: 'pickup_fee_likely', label: 'Pickup fee likely', detail: 'FedEx Ground on-demand pickup typically carries a per-pickup fee unless a scheduled pickup contract is in place. Exact fee is confirmed when the pickup request is created.' };
      }
      return { state: 'fee_depends_on_account', label: 'Fee depends on account', detail: 'FedEx pickup fees depend on service tier and account configuration. Exact fee is confirmed when the pickup request is created.' };
    }
    if (carrierUpper.includes('DHL')) {
      return { state: 'fee_depends_on_account', label: 'Fee depends on account', detail: 'DHL Express pickup is typically included with an account in most lanes; some service areas carry surcharges. Exact fee is confirmed when the pickup request is created.' };
    }
    return { state: 'unknown', label: 'Fee unknown', detail: `Pickup fee class for "${rate.carrier}" is not modeled. Exact fee is determined when the pickup request is created.` };
  }

  function getPickupEligibilityState(shipment: Shipment): { status: PickupEligibilityStatus; record?: PickupEligibility } {
    const rec = pickupEligibility[shipment.id];
    if (!rec) return { status: 'unknown' };
    // Phase 2.6.1 — compare the FULL payload fingerprint. If the
    // pickupForm currently in scope reflects a DIFFERENT shipment (the
    // operator hasn't opened this row's pickup form yet), the computed
    // fingerprint won't match and we return 'unknown' — which is the safe
    // default (allows fresh attempt, never blocks). The previous
    // address-only check was sticky across contact/window edits, so a
    // failure caused by a bad phone stayed "ineligible" forever even
    // after the operator fixed the phone.
    const payloadFp = pickupPayloadFingerprint(shipment, pickupForm);
    if (rec.fingerprint !== payloadFp) return { status: 'unknown' };
    return { status: rec.status, record: rec };
  }

  // True pickup-address verification — calls the EasyPost create-and-verify
  // endpoint via the existing shipping API client. Carrier-agnostic. Records
  // the result keyed by shipment id with a fingerprint, so subsequent edits
  // to the origin invalidate the verification.
  async function verifyPickupAddressFor(shipmentId: string) {
    if (isWriteBlocked) return;
    const ship = shipments.find(s => s.id === shipmentId);
    if (!ship) return;
    const { address } = resolvePickupAddress(ship);
    const presence = validatePickupAddress(address);
    if (!presence.ready) {
      setProviderError(friendlyProviderError({ code: 'PICKUP_ADDRESS_INCOMPLETE', message: `Cannot verify pickup address — required fields are missing: ${presence.missing.join(', ')}.` }));
      return;
    }
    const fp = pickupAddrFingerprint(address);
    setPickupVerifying(p => ({ ...p, [shipmentId]: true }));
    try {
      // eslint-disable-next-line no-console
      console.log('[Pickup] verifyPickupAddress →', { shipmentId, fingerprint: fp });
      const resp = await shippingApi.validateAddress(address);
      if (!resp.success || !resp.result) {
        const err = resp.error;
        setPickupAddrVerify(p => ({
          ...p,
          [shipmentId]: {
            fingerprint: fp,
            status: 'failed',
            messages: err?.message ? [err.message] : ['Address verification failed.'],
            verifiedAt: new Date().toISOString(),
            errorCode: err?.code,
            errorMessage: err?.message,
          },
        }));
        return;
      }
      const r = resp.result;
      setPickupAddrVerify(p => ({
        ...p,
        [shipmentId]: {
          fingerprint: fp,
          status: r.status === 'validated' ? 'verified' : r.status === 'corrected' ? 'corrected' : 'failed',
          suggestedAddress: r.suggestedAddress,
          messages: r.messages || [],
          providerRef: r.providerRef,
          verifiedAt: r.validatedAt || new Date().toISOString(),
          accepted: false,
          submittedAddress: address,
          details: r.details,
          warnings: r.warnings,
        },
      }));
    } catch (err) {
      setPickupAddrVerify(p => ({
        ...p,
        [shipmentId]: {
          fingerprint: fp,
          status: 'failed',
          messages: [err instanceof Error ? err.message : 'Unexpected error during verification.'],
          verifiedAt: new Date().toISOString(),
        },
      }));
    } finally {
      setPickupVerifying(p => ({ ...p, [shipmentId]: false }));
    }
  }

  // Operator accepts a corrected pickup address — applies the suggested
  // address to the shipment origin and marks the verification as accepted.
  // The fingerprint is recomputed against the suggestion so the verification
  // remains valid for the now-current origin (no re-verify required).
  function acceptCorrectedPickupAddress(shipmentId: string) {
    if (isWriteBlocked) return;
    const rec = pickupAddrVerify[shipmentId];
    if (!rec || rec.status !== 'corrected' || !rec.suggestedAddress) return;
    const ship = shipments.find(s => s.id === shipmentId);
    if (!ship) return;
    // Merge the carrier-normalized address fields into the origin WITHOUT
    // wiping name/company/phone/email — EasyPost's verification response
    // returns those as empty strings ('') because address verification does
    // not echo them back. A naive spread would overwrite real values with
    // empty strings. Only normalized address fields move; contact info
    // stays from the existing origin.
    const sug = rec.suggestedAddress;
    // Phase 2.6 — when a pickup-override is active OR the label has
    // already been purchased (origin is locked), accept the corrected
    // address into the OVERRIDE slot, never into originAddress. The
    // printed label's from_address must remain exactly what the carrier
    // accepted at purchase time.
    const labelLocked = !!ship.label;
    const writeToOverride = !!ship.pickupOverrideAddress || labelLocked;
    const baseAddr: ShipmentAddress = writeToOverride
      ? (ship.pickupOverrideAddress || ship.originAddress)
      : ship.originAddress;
    const corrected: ShipmentAddress = {
      ...baseAddr,
      line1: sug.line1 || baseAddr.line1,
      line2: sug.line2 ?? baseAddr.line2,
      city: sug.city || baseAddr.city,
      state: sug.state || baseAddr.state,
      postalCode: sug.postalCode || baseAddr.postalCode,
      country: sug.country || baseAddr.country,
    };
    const newFp = pickupAddrFingerprint(corrected);
    if (writeToOverride) {
      updateShipment(shipmentId, { pickupOverrideAddress: corrected, updatedAt: new Date().toISOString() });
    } else {
      updateShipment(shipmentId, { originAddress: corrected, updatedAt: new Date().toISOString() });
    }
    setPickupAddrVerify(p => ({
      ...p,
      [shipmentId]: { ...rec, fingerprint: newFp, accepted: true },
    }));
  }

  // Phase 2.6 — pickup-override editor handlers. The override is a
  // pickup-only address that takes precedence over originAddress when
  // resolvePickupAddress is called. It is the recovery surface for the
  // "label is paid for but the carrier rejected the from-address for
  // pickup booking" scenario, and is also useful pre-label when the
  // ship-from address differs from the dispatch dock.
  function beginPickupOverride(shipmentId: string) {
    if (isWriteBlocked) return;
    const ship = shipments.find(s => s.id === shipmentId);
    if (!ship) return;
    // Seed the draft with whatever override is already saved, otherwise a
    // copy of the origin so the operator only edits the deltas.
    const seed: ShipmentAddress = ship.pickupOverrideAddress ? { ...ship.pickupOverrideAddress } : { ...ship.originAddress };
    setPickupOverrideDraft(p => ({ ...p, [shipmentId]: seed }));
    setPickupOverrideDetailDraft(p => ({ ...p, [shipmentId]: ship.pickupLocationDetail || '' }));
  }
  function cancelPickupOverride(shipmentId: string) {
    setPickupOverrideDraft(p => { const next = { ...p }; delete next[shipmentId]; return next; });
    setPickupOverrideDetailDraft(p => { const next = { ...p }; delete next[shipmentId]; return next; });
  }
  function savePickupOverride(shipmentId: string) {
    if (isWriteBlocked) return;
    const draft = pickupOverrideDraft[shipmentId];
    if (!draft) return;
    const detail = (pickupOverrideDetailDraft[shipmentId] || '').trim();
    updateShipment(shipmentId, {
      pickupOverrideAddress: draft,
      pickupLocationDetail: detail || undefined,
      // The override changed → invalidate any prior pickup-address
      // verification record AND any prior pickup-eligibility memory for
      // this shipment. Both are fingerprint-keyed against the resolved
      // pickup address, so swapping the underlying address must wipe
      // them so the UI does not show "verified" against the old origin.
      updatedAt: new Date().toISOString(),
    });
    setPickupAddrVerify(p => { const next = { ...p }; delete next[shipmentId]; return next; });
    setPickupEligibility(p => { const next = { ...p }; delete next[shipmentId]; return next; });
    cancelPickupOverride(shipmentId);
  }
  function clearPickupOverride(shipmentId: string) {
    if (isWriteBlocked) return;
    updateShipment(shipmentId, {
      pickupOverrideAddress: undefined,
      pickupOverrideAddressValidation: undefined,
      pickupLocationDetail: undefined,
      updatedAt: new Date().toISOString(),
    });
    setPickupAddrVerify(p => { const next = { ...p }; delete next[shipmentId]; return next; });
    setPickupEligibility(p => { const next = { ...p }; delete next[shipmentId]; return next; });
    cancelPickupOverride(shipmentId);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Multi-provider pickup-payload preflight.
  //
  // Runs the provider's required-field model (declared in PROVIDER_CAPABILITIES
  // — pickupRequiresInstructions / pickupRequiresContactName /
  // pickupRequiresContactPhone / pickupRequiresVerifiedAddress /
  // pickupRequiresLabelIds / pickupRequiresPickupWindow /
  // pickupNeedsProviderShipmentId) against the actual values that the live
  // booking call would send. If anything is missing we block BEFORE the
  // provider call so the operator sees exactly which fields to fill in,
  // rather than discovering hidden requirements only via a 422 from the
  // carrier (which is what was happening with EasyPost's `instructions`).
  //
  // The preflight is provider-aware — EasyPost, Shippo, and ShipStation are
  // each driven by their own capability flags. Only providers with
  // `supportsLivePickupBooking === true` are preflighted (others go down
  // the local-only branch where no provider payload is sent).
  // ─────────────────────────────────────────────────────────────────────
  type PickupPayloadPreflight = {
    ready: boolean;
    requiredFields: { key: string; label: string; satisfied: boolean; sourceHint: string }[];
    missing: string[];
    providerLive: boolean;
  };
  function getPickupPayloadPreflight(shipment: Shipment): PickupPayloadPreflight {
    const caps = activeProviderId ? PROVIDER_CAPABILITIES[activeProviderId.toLowerCase()] : null;
    if (!caps || !caps.supportsLivePickupBooking) {
      return { ready: true, requiredFields: [], missing: [], providerLive: false };
    }
    const { address: pickupAddr } = resolvePickupAddress(shipment);
    const verify = getPickupVerificationStatus(shipment);
    const verifiedOk = verify.status === 'verified' || verify.status === 'corrected_accepted';
    const contactName = (pickupForm.contactName.trim() || pickupAddr.name || pickupAddr.company || '').trim();
    const contactPhone = (pickupForm.contactPhone.trim() || pickupAddr.phone || '').trim();
    const instructions = pickupForm.notes.trim();
    const hasWindow = !!(pickupForm.date && pickupForm.windowStart && pickupForm.windowEnd);
    const hasShipmentRef = !!shipment.providerShipmentId;
    const fields: { key: string; label: string; satisfied: boolean; sourceHint: string }[] = [];
    if (caps.pickupRequiresVerifiedAddress) {
      fields.push({ key: 'verified_address', label: 'Carrier-verified pickup address', satisfied: verifiedOk, sourceHint: 'Verify the pickup address in the banner above (Verify Pickup Address button).' });
    }
    if (caps.pickupNeedsProviderShipmentId) {
      fields.push({ key: 'provider_shipment_id', label: 'Provider shipment id (label)', satisfied: hasShipmentRef, sourceHint: 'Purchase a label for this shipment first — pickups attach to a bought label.' });
    }
    if (caps.pickupRequiresPickupWindow) {
      fields.push({ key: 'pickup_window', label: 'Pickup date + window (earliest/latest)', satisfied: hasWindow, sourceHint: 'Set Pickup Date, Earliest, and Latest in the form below.' });
    }
    if (caps.pickupRequiresContactName) {
      fields.push({ key: 'contact_name', label: 'Contact name (person at pickup site)', satisfied: contactName.length > 0, sourceHint: 'Fill in Contact Name (or set a name on the shipment origin address).' });
    }
    if (caps.pickupRequiresContactPhone) {
      fields.push({ key: 'contact_phone', label: 'Contact phone (driver-callable)', satisfied: contactPhone.length > 0, sourceHint: 'Fill in Contact Phone (or set a phone on the shipment origin address).' });
    }
    if (caps.pickupRequiresInstructions) {
      // EasyPost /v2/pickups: `instructions` field is required and must be a
      // non-empty string telling the driver where/how to pick up the parcel.
      // Empty/whitespace-only does NOT count as satisfied.
      fields.push({ key: 'instructions', label: 'Pickup instructions (where the driver should go)', satisfied: instructions.length > 0, sourceHint: 'Fill in Pickup Instructions below — e.g. "Front desk", "Side door, ring bell", "Loading dock 3".' });
    }
    if (caps.pickupRequiresLabelIds) {
      // Shippo requires a transactions[] array of label ids. We currently
      // map this from `providerShipmentId`/transactions on the shipment;
      // honest signal that the data is present.
      fields.push({ key: 'label_ids', label: 'Bought label id(s) for the pickup (transactions[])', satisfied: hasShipmentRef, sourceHint: 'Purchase the label(s) for this shipment first — Shippo attaches pickups to specific labels.' });
    }
    const missing = fields.filter(f => !f.satisfied).map(f => f.label);
    return { ready: missing.length === 0, requiredFields: fields, missing, providerLive: true };
  }

  function getPickupEligibility(shipment: Shipment): Eligibility {
    const caps = getProviderCapabilities(shipment);
    if (!caps.pickupRequests) {
      const isManual = getShipmentMode(shipment) === 'manual';
      const isProviderMissing = !activeProviderId;
      if (isManual || isProviderMissing) return { eligible: false, reason: caps.puReason || caps.reason, category: 'provider' };
      if (!planAllowsPickupRequests) return { eligible: false, reason: 'Carrier pickup is not included in your current plan.', category: 'plan' };
      return { eligible: false, reason: caps.puReason || caps.reason, category: 'provider' };
    }
    if (!canRequestPickup) return { eligible: false, reason: 'You do not have permission to request a carrier pickup.', category: 'permission' };
    if (!PICKUP_REQUESTABLE_STATUSES.includes(shipment.status)) {
      return { eligible: false, reason: `Shipment must be Packed before a carrier pickup can be requested. Current status: ${shipment.status}.`, category: 'lifecycle' };
    }
    if (shipment.servicePoint) {
      return { eligible: false, reason: 'A service-point drop-off is selected. Clear it first to switch to a carrier pickup.', category: 'mutex' };
    }
    // Pickup-address readiness gate — TWO layers:
    //   (a) field-presence: required fields must be non-empty (cheap, local)
    //   (b) true verification: the address must have passed EasyPost
    //       delivery verification (or an accepted-corrected verification)
    //       on its current contents — fingerprint-tracked so any edit
    //       invalidates the prior verification.
    // Both must pass before the Request Carrier Pickup action is allowed,
    // so we never send an avoidably-invalid pickup address to the carrier.
    const { address: pickupAddr, sourceLabel } = resolvePickupAddress(shipment);
    const addrCheck = validatePickupAddress(pickupAddr);
    if (!addrCheck.ready) {
      return {
        eligible: false,
        reason: `Pickup uses the ${sourceLabel}. Complete it first — missing: ${addrCheck.missing.join(', ')}.`,
        category: 'pickup_address',
      };
    }
    const verify = getPickupVerificationStatus(shipment);
    if (verify.status !== 'verified' && verify.status !== 'corrected_accepted') {
      const reason =
        verify.status === 'verifying' ? 'Verifying pickup address with the carrier — please wait.'
        : verify.status === 'unverified' ? 'Pickup address has not been verified yet. Click "Verify Pickup Address" to run carrier address verification before booking.'
        : verify.status === 'stale' ? 'Pickup address has changed since last verification. Re-verify before booking.'
        : verify.status === 'corrected_pending' ? 'Carrier returned a corrected pickup address. Review and accept (or revise the origin) before booking.'
        : verify.status === 'failed' ? `Carrier rejected the pickup address${verify.record?.errorMessage ? ` — ${verify.record.errorMessage}` : verify.record?.messages?.[0] ? `: ${verify.record.messages[0]}` : ''}. Fix the address and re-verify before booking.`
        : 'Pickup address is not verified.';
      return { eligible: false, reason, category: 'pickup_address_unverified' };
    }
    // Provider-payload preflight — checks the actual fields the live booking
    // call would send against the active provider's required-field model
    // (PROVIDER_CAPABILITIES.pickupRequires*). Catches things like EasyPost's
    // mandatory `instructions` field BEFORE the API call.
    const preflight = getPickupPayloadPreflight(shipment);
    if (!preflight.ready) {
      return {
        eligible: false,
        reason: `${activeProviderId} pickup requires the following before booking: ${preflight.missing.join(', ')}.`,
        category: 'pickup_payload',
      };
    }
    // Pickup-eligibility memory (Phase 2.5.8). If the very same address
    // snapshot already failed pickup_create, do not let the operator
    // re-submit it — the carrier already said no for this exact address
    // and delivery verification is not a counter-proof. Editing the
    // address invalidates this memory (fingerprint mismatch in
    // getPickupEligibilityState) so the operator can retry on a fresh
    // address snapshot. A successful create promotes status to
    // 'confirmed' and pickup_create won't be re-offered for that
    // shipment because pickupRequest is set (handled by `pr` above).
    const elig = getPickupEligibilityState(shipment);
    if (elig.status === 'failed') {
      const why = elig.record?.message ? ` Carrier said: ${elig.record.message}` : '';
      return {
        eligible: false,
        reason: `${activeProviderId || 'The carrier'} already rejected this exact pickup address for booking.${why} Edit the address (or contact info) and re-verify before retrying.`,
        category: 'pickup_address_ineligible',
      };
    }
    return { eligible: true };
  }

  function getMockServicePoints(shipment: Shipment): ServicePoint[] {
    // Provider-stub list. In production each provider adapter would query the carrier
    // service-point API (UPS Access Point, FedEx Onsite, USPS PO Boxes, DHL ServicePoint)
    // for points near the shipment origin. The UI clearly labels these as preview data.
    const origin = shipment.originAddress;
    const carrier = shipment.carrier || shipment.selectedRate?.carrier || 'UPS';
    const baseAddr = (suffix: string): ShipmentAddress => ({
      ...origin,
      line1: `${100 + suffix.length} ${suffix} St`,
      name: `${carrier} ${suffix} Service Point`,
      company: undefined,
    });
    return [
      { id: `sp_${carrier.toLowerCase()}_001`, carrier, providerId: activeProviderId || undefined, name: `${carrier} Access Point — 5th Ave Pharmacy`, type: 'access_point', address: baseAddr('5th Ave'), distanceKm: 0.4, contactPhone: '+1 555 0101', hours: [
        { day: 'mon', open: '08:00', close: '20:00' }, { day: 'tue', open: '08:00', close: '20:00' }, { day: 'wed', open: '08:00', close: '20:00' }, { day: 'thu', open: '08:00', close: '20:00' }, { day: 'fri', open: '08:00', close: '20:00' }, { day: 'sat', open: '09:00', close: '18:00' }, { day: 'sun', closed: true },
      ] },
      { id: `sp_${carrier.toLowerCase()}_002`, carrier, providerId: activeProviderId || undefined, name: `${carrier} Locker — Downtown Plaza`, type: 'locker', address: baseAddr('Plaza'), distanceKm: 1.2, contactPhone: undefined, hours: [
        { day: 'mon', open: '00:00', close: '23:59' }, { day: 'tue', open: '00:00', close: '23:59' }, { day: 'wed', open: '00:00', close: '23:59' }, { day: 'thu', open: '00:00', close: '23:59' }, { day: 'fri', open: '00:00', close: '23:59' }, { day: 'sat', open: '00:00', close: '23:59' }, { day: 'sun', open: '00:00', close: '23:59' },
      ] },
      { id: `sp_${carrier.toLowerCase()}_003`, carrier, providerId: activeProviderId || undefined, name: `${carrier} Office — Main Branch`, type: 'office', address: baseAddr('Main'), distanceKm: 2.8, contactPhone: '+1 555 0202', contactEmail: 'hub@example.com', hours: [
        { day: 'mon', open: '09:00', close: '18:00' }, { day: 'tue', open: '09:00', close: '18:00' }, { day: 'wed', open: '09:00', close: '18:00' }, { day: 'thu', open: '09:00', close: '18:00' }, { day: 'fri', open: '09:00', close: '18:00' }, { day: 'sat', closed: true }, { day: 'sun', closed: true },
      ] },
    ];
  }

  function openServicePointModal(shipmentId: string) {
    setShowServicePointModal(shipmentId);
    setServicePointNotes('');
    setServicePointZipSearch('');
    setServicePointSearchResults([]);
    setServicePointLoading(false);
    const ship = shipments.find(s => s.id === shipmentId);
    setManualSpForm({
      id: '', name: '', type: 'parcel_locker',
      line1: '', city: '', state: '',
      postalCode: ship?.originAddress.postalCode || '',
      phone: '',
    });
  }

  // Live carrier service-point lookup is not available until carrier-specific locator
  // adapters (USPS Locations, UPS Locator, FedEx Locations) are wired and credentialed
  // per store. Until then this is a no-op that surfaces a clear unavailable state in
  // the UI rather than fabricating fake "preview" results that look real to operators.
  function searchServicePointsByZip(_shipmentId: string, _zip: string) {
    setServicePointSearchResults([]);
    setServicePointLoading(false);
    setProviderError(friendlyProviderError({ code: 'PROVIDER_UNAVAILABLE', message: 'Live carrier service-point lookup is not available. Configure a carrier-specific locator adapter under Settings → Carrier Locators, or use manual entry below.' }));
  }

  async function handleSelectServicePointManual(shipmentId: string) {
    if (isWriteBlocked) return;
    const ship = shipments.find(s => s.id === shipmentId);
    if (!ship) return;
    const elig = getServicePointManualEntryEligibility(ship);
    if (!elig.eligible) {
      setProviderError(friendlyProviderError({ code: (elig.category || 'NOT_AVAILABLE').toUpperCase(), message: elig.reason || 'Manual service-point entry not available.' }));
      return;
    }
    const id = manualSpForm.id.trim();
    const name = manualSpForm.name.trim();
    const line1 = manualSpForm.line1.trim();
    const city = manualSpForm.city.trim();
    const state = manualSpForm.state.trim();
    const postalCode = manualSpForm.postalCode.trim();
    if (!id || !name || !line1 || !city || !state || !postalCode) {
      setProviderError(friendlyProviderError({ code: 'VALIDATION', message: 'Service-point ID, name, and full address are required.' }));
      return;
    }
    setManualSpSubmitting(true);
    const carrier = ship.carrier || ship.selectedRate?.carrier || 'UPS';
    const sp: ServicePoint = {
      id,
      providerId: activeProviderId || undefined,
      carrier,
      name,
      type: (manualSpForm.type as any) || 'parcel_locker',
      address: {
        line1,
        city,
        state,
        postalCode,
        country: ship.originAddress.country || 'US',
      },
      contactPhone: manualSpForm.phone.trim() || undefined,
      source: 'manual',
    } as ServicePoint;
    await handleSelectServicePoint(shipmentId, sp);
    setManualSpSubmitting(false);
  }

  async function handleSelectServicePoint(shipmentId: string, sp: ServicePoint) {
    if (isWriteBlocked) return;
    const ship0 = shipments.find(s => s.id === shipmentId);
    if (!ship0) return;
    // Accept either live-locator eligibility OR manual-entry eligibility. Manual entry
    // is the only path while no carrier-specific locator adapter is configured.
    const live = getServicePointEligibility(ship0);
    const manual = getServicePointManualEntryEligibility(ship0);
    if (!live.eligible && !manual.eligible) {
      const elig = live.eligible ? live : manual;
      setProviderError(friendlyProviderError({ code: (elig.category || 'NOT_AVAILABLE').toUpperCase(), message: elig.reason || 'Service point not available.' }));
      return;
    }
    const now = new Date().toISOString();
    const selected: ServicePoint = {
      ...sp,
      selectedAt: now,
      selectedBy: 'current_operator',
      selectionNotes: servicePointNotes.trim() || undefined,
    };
    updateShipment(shipmentId, {
      servicePoint: selected,
      pickupInfo: {
        ...(shipments.find(s => s.id === shipmentId)?.pickupInfo || {}),
        servicePointId: sp.id,
      },
      events: [
        ...(shipments.find(s => s.id === shipmentId)?.events || []),
        { id: `evt_sp_${Date.now()}`, status: 'Service Point Selected' as any, description: `Drop-off: ${sp.name} (${sp.id})`, timestamp: now, performedBy: 'current_operator' } as ShipmentEvent,
      ],
      updatedAt: now,
    });
    setShowServicePointModal(null);
    setProviderSuccess(`Service point selected: ${sp.name}.`);
  }

  function handleClearServicePoint(shipmentId: string) {
    if (isWriteBlocked) return;
    if (!canSelectServicePoint) {
      setProviderError(friendlyProviderError({ code: 'PERMISSION_DENIED', message: 'You do not have permission to modify the service point.' }));
      return;
    }
    const ship = shipments.find(s => s.id === shipmentId);
    if (!ship?.servicePoint) return;
    const now = new Date().toISOString();
    updateShipment(shipmentId, {
      servicePoint: undefined,
      pickupInfo: { ...(ship.pickupInfo || {}), servicePointId: undefined },
      events: [
        ...ship.events,
        { id: `evt_sp_clr_${Date.now()}`, status: 'Service Point Cleared' as any, description: `Cleared service point: ${ship.servicePoint.name}`, timestamp: now, performedBy: 'current_operator' } as ShipmentEvent,
      ],
      updatedAt: now,
    });
    setProviderSuccess('Service point cleared.');
  }

  async function handleRequestPickup(shipmentId: string) {
    if (isWriteBlocked) {
      setPickupAttemptResult({ kind: 'error', title: 'Write blocked', detail: 'You are in preview/read-only mode. Pickup booking is disabled.', steps: [], code: 'WRITE_BLOCKED' });
      return;
    }
    const ship = shipments.find(s => s.id === shipmentId);
    if (!ship) {
      setPickupAttemptResult({ kind: 'error', title: 'Shipment not found', detail: `Could not locate shipment ${shipmentId} in local state.`, steps: [], code: 'SHIPMENT_NOT_FOUND' });
      return;
    }
    const elig = getPickupEligibility(ship);
    if (!elig.eligible) {
      const msg = elig.reason || 'Carrier pickup not available.';
      setProviderError(friendlyProviderError({ code: (elig.category || 'NOT_AVAILABLE').toUpperCase(), message: msg }));
      setPickupAttemptResult({ kind: 'error', title: 'Pickup not eligible', detail: msg, steps: [], code: (elig.category || 'NOT_AVAILABLE').toUpperCase() });
      return;
    }
    // Phase 2.7.1 — UPS service-level early gate. If the selected rate
    // is a UPS service the classifier marks not_capable (UPS DAP, SurePost
    // / Ground Saver, Mail Innovations), do NOT round-trip pickup_create
    // — we already know the carrier will refuse. Surface a precise,
    // service-aware operator message so they can switch service or use
    // drop-off. This gate is intentionally additive to getPickupEligibility
    // (which is carrier-agnostic) and only fires for UPS rate objects, so
    // it cannot affect USPS or FedEx flows. Skips when no selectedRate
    // (manual mode / pre-rate) — no service evidence to gate on.
    const sel = ship.selectedRate;
    if (sel && (sel.carrier || '').toUpperCase().includes('UPS')) {
      const ups = classifyUpsServicePickup(sel);
      if (ups.state === 'not_capable') {
        const msg = `This UPS service is not pickup-bookable through the current provider flow. Other UPS services on this rate list may be pickup-capable — choose a different UPS service or use drop-off. (${ups.detail})`;
        setProviderError(friendlyProviderError({ code: 'UPS_SERVICE_NOT_PICKUP_CAPABLE', message: msg }));
        setPickupAttemptResult({ kind: 'error', title: 'UPS service not pickup-capable', detail: msg, steps: [], code: 'UPS_SERVICE_NOT_PICKUP_CAPABLE' });
        return;
      }
    }
    if (!pickupForm.date) {
      const msg = 'Pickup date is required.';
      setProviderError(friendlyProviderError({ code: 'VALIDATION', message: msg }));
      setPickupAttemptResult({ kind: 'error', title: 'Missing pickup date', detail: msg, steps: [], code: 'VALIDATION' });
      return;
    }
    clearProviderFeedback();
    setPickupAttemptResult(null);
    setPickupSubmitting(true);
    // eslint-disable-next-line no-console
    console.log('[Pickup] Begin attempt', { shipmentId, providerId: activeProviderId, providerShipmentId: ship.providerShipmentId, hasLabel: !!ship.label });
    const now = new Date().toISOString();
    const totalWeight = ship.packages.reduce((sum, p) => sum + (p.weight || 0), 0);
    const carrier = ship.carrier || ship.selectedRate?.carrier || 'UPS';
    const caps = activeProviderId ? PROVIDER_CAPABILITIES[activeProviderId.toLowerCase()] : null;
    // Build the local pickup record up front; it will be enriched with live
    // provider data on the EasyPost path or marked source='local_only' otherwise.
    const basePickup: PickupRequest = {
      id: `pr_${Date.now()}`,
      shipmentId,
      providerId: activeProviderId || undefined,
      carrier,
      status: 'requested',
      requestedDate: pickupForm.date,
      windowStart: pickupForm.windowStart || undefined,
      windowEnd: pickupForm.windowEnd || undefined,
      pickupAddress: resolvePickupAddress(ship).address,
      contactName: pickupForm.contactName.trim() || undefined,
      contactPhone: pickupForm.contactPhone.trim() || resolvePickupAddress(ship).address.phone || undefined,
      packageCount: ship.packages.length,
      totalWeight: totalWeight || undefined,
      handlingNotes: pickupForm.notes.trim() || undefined,
      requestedAt: now,
      requestedBy: 'current_operator',
    };

    // -------------------------------------------------------------------
    // Live booking path: only when provider declares supportsLivePickupBooking
    // AND the prerequisite providerShipmentId is present (EasyPost requires it).
    // -------------------------------------------------------------------
    try {
      if (caps?.supportsLivePickupBooking) {
        if (caps.pickupNeedsProviderShipmentId && !ship.providerShipmentId) {
          const msg = `${activeProviderId} pickup requires a provider shipment id. Purchase a label for this shipment first so the pickup can be attached to it.`;
          setProviderError(friendlyProviderError({ code: 'MISSING_SHIPMENT_REF', message: msg }));
          setPickupAttemptResult({ kind: 'error', title: 'Label not purchased', detail: msg, steps: [{ label: 'Pre-flight: provider shipment id', status: 'fail', note: 'No providerShipmentId on this shipment.' }], code: 'MISSING_SHIPMENT_REF' });
          // eslint-disable-next-line no-console
          console.error('[Pickup] MISSING_SHIPMENT_REF — label not purchased yet');
          return;
        }
        const minDt = new Date(`${pickupForm.date}T${pickupForm.windowStart || '09:00'}:00`).toISOString();
        const maxDt = new Date(`${pickupForm.date}T${pickupForm.windowEnd || '17:00'}:00`).toISOString();
        // Resolve the pickup address from the single source of truth (the
        // shipment origin) and run preflight validation against THAT address
        // — not against any other shipment field. If the origin is not
        // pickup-ready (missing street/city/state/zip/contact), block the
        // request in-app rather than letting EasyPost return a generic
        // semantic error. The operator gets a specific list of fields to fix.
        const pickupAddrResolved = resolvePickupAddress(ship);
        const addrCheck = validatePickupAddress(pickupAddrResolved.address);
        const phoneRawForCheck = (pickupForm.contactPhone.trim() || pickupAddrResolved.address.phone || '').trim();
        const phoneAvailable = !!phoneRawForCheck;
        // Phase 2.6.1 — phone-format preflight. Carriers (USPS in
        // particular) require a 10-digit US phone. Accept 10 digits, or
        // 11 digits starting with 1 (which we'll normalize on the server),
        // or an E.164 +1XXXXXXXXXX. Anything else is rejected up front
        // with a specific error so the operator doesn't waste a provider
        // round-trip and doesn't see the contact-phone-mutation bug
        // re-enter the form via a corrected suggestion.
        const phoneDigitsForCheck = phoneRawForCheck.replace(/\D/g, '');
        const phoneFormatOk = phoneDigitsForCheck.length === 10
          || (phoneDigitsForCheck.length === 11 && phoneDigitsForCheck.startsWith('1'));
        if (!addrCheck.ready || !phoneAvailable || !phoneFormatOk) {
          const missing = [...addrCheck.missing];
          if (!phoneAvailable) {
            missing.push('Contact phone (in pickup form or origin address)');
          } else if (!phoneFormatOk) {
            missing.push(`Contact phone must be a 10-digit US number (got "${phoneRawForCheck}", ${phoneDigitsForCheck.length} digit${phoneDigitsForCheck.length === 1 ? '' : 's'})`);
          }
          const msg = `Pickup uses the ${pickupAddrResolved.sourceLabel}. Complete it before requesting pickup. Missing: ${missing.join(', ')}.`;
          // eslint-disable-next-line no-console
          console.error('[Pickup] PICKUP_ADDRESS_INCOMPLETE', { source: pickupAddrResolved.source, missing });
          setProviderError(friendlyProviderError({ code: 'PICKUP_ADDRESS_INCOMPLETE', message: msg }));
          setPickupAttemptResult({
            kind: 'error',
            title: 'Pickup address is incomplete',
            detail: msg,
            steps: [
              { label: 'Pre-flight: pickup address ready', status: 'fail', note: `Source: ${pickupAddrResolved.source}. Missing ${missing.length} field(s).` },
            ],
            code: 'PICKUP_ADDRESS_INCOMPLETE',
            context: [
              { label: 'Pickup address source', value: pickupAddrResolved.sourceLabel },
              { label: 'Where to fix it', value: 'Open the shipment origin address editor (Origin section above) and complete the highlighted fields.' },
              { label: 'Missing fields', value: missing.join(', ') },
            ],
          });
          return;
        }
        // Provider-payload preflight — runs the active provider's
        // required-field model against the values that would be sent. This
        // is what blocks EasyPost's hidden `instructions` requirement (and
        // any future provider-required field) BEFORE the /v2/pickups call.
        const payloadPreflight = getPickupPayloadPreflight(ship);
        if (payloadPreflight.providerLive && !payloadPreflight.ready) {
          const missingLabels = payloadPreflight.requiredFields.filter(f => !f.satisfied).map(f => `• ${f.label} — ${f.sourceHint}`);
          const msg = `${activeProviderId} pickup is missing required field(s) for this booking. Fill them in before requesting pickup.`;
          // eslint-disable-next-line no-console
          console.error('[Pickup] PICKUP_PAYLOAD_INCOMPLETE', { provider: activeProviderId, missing: payloadPreflight.missing });
          setProviderError(friendlyProviderError({ code: 'PICKUP_PAYLOAD_INCOMPLETE', message: `${msg} Missing: ${payloadPreflight.missing.join(', ')}.` }));
          setPickupAttemptResult({
            kind: 'error',
            title: 'Pickup payload is incomplete',
            detail: msg,
            steps: [
              { label: 'Pre-flight: pickup address ready', status: 'ok', note: `Using ${pickupAddrResolved.source}` },
              { label: 'Pre-flight: provider required fields', status: 'fail', note: `${payloadPreflight.missing.length} required field(s) missing for ${activeProviderId}.` },
            ],
            code: 'PICKUP_PAYLOAD_INCOMPLETE',
            context: [
              { label: 'Provider', value: activeProviderId || '(none)' },
              { label: 'Missing required fields', value: missingLabels.join('\n') },
              { label: 'Where to fix', value: 'Fill in the highlighted fields in the pickup form (and verify the address if not yet verified).' },
            ],
          });
          return;
        }
        // Concise prerequisite snapshot — what we actually send to the
        // provider, including the explicit pickup-address source. This is now
        // the operator's primary diagnostic (which address EasyPost is using
        // and where to fix it) — raw provider details are kept as secondary.
        const pickupContext: { label: string; value: string }[] = [
          { label: 'Provider', value: activeProviderId || '(none)' },
          { label: 'Provider shipment ref', value: ship.providerShipmentId ? `present (${ship.providerShipmentId.slice(0, 12)}…)` : 'MISSING — label may not be purchased' },
          { label: 'Carrier', value: carrier || '(unspecified — provider will infer)' },
          { label: 'Pickup window', value: `${pickupForm.date} ${pickupForm.windowStart || '09:00'}–${pickupForm.windowEnd || '17:00'} (local) → ${minDt} → ${maxDt}` },
          { label: 'Pickup address SOURCE', value: pickupAddrResolved.sourceLabel },
          { label: 'Pickup address', value: `${pickupAddrResolved.address.line1 || '?'}${pickupAddrResolved.address.line2 ? `, ${pickupAddrResolved.address.line2}` : ''}, ${pickupAddrResolved.address.city || '?'}, ${pickupAddrResolved.address.state || '?'} ${pickupAddrResolved.address.postalCode || '?'} ${pickupAddrResolved.address.country || '?'}` },
          { label: 'Pickup contact', value: `${pickupForm.contactName.trim() || pickupAddrResolved.address.name || pickupAddrResolved.address.company || '(none)'} · ${pickupForm.contactPhone.trim() || pickupAddrResolved.address.phone || '(no phone)'}` },
          { label: 'is_account_address', value: 'false (sending the shipment origin address — EasyPost will validate it)' },
        ];
        if (addrCheck.warnings.length > 0) {
          pickupContext.push({ label: 'Address warnings', value: addrCheck.warnings.join('; ') });
        }
        const steps: PickupAttemptResult['steps'] = [
          { label: 'Pre-flight: pickup address ready', status: 'ok', note: `Using ${pickupAddrResolved.source}` },
          { label: 'Create pickup with provider', status: 'pending' },
        ];
        setPickupAttemptResult({ kind: 'info', title: 'Booking pickup…', detail: `Calling ${activeProviderId} create-pickup endpoint with the shipment origin address.`, steps, context: pickupContext });
        // eslint-disable-next-line no-console
        console.log('[Pickup] createProviderPickup →', { providerId: activeProviderId, providerShipmentId: ship.providerShipmentId, minDt, maxDt, carrier, pickupAddressSource: pickupAddrResolved.source, isAccountAddress: false });
        const created = await shippingApi.createProviderPickup({
          providerId: activeProviderId || undefined,
          pickupAddress: pickupAddrResolved.address,
          minDatetime: minDt,
          maxDatetime: maxDt,
          // Phase 2.6 — when a pickup-only override is active, prepend the
          // operator-supplied pickupLocationDetail to instructions so the
          // driver sees suite/dock/door context even on providers that
          // ignore line2.
          instructions: [ship.pickupLocationDetail?.trim(), basePickup.handlingNotes].filter(Boolean).join(' — ') || undefined,
          providerShipmentId: ship.providerShipmentId,
          carrier,
          // Honest: we are sending the shipment origin address, NOT the
          // EasyPost account's registered pickup address. Sending true here
          // previously was the root cause of EasyPost rejecting the request
          // when the origin address didn't match the account address.
          isAccountAddress: false,
        });
        // eslint-disable-next-line no-console
        console.log('[Pickup] createProviderPickup ←', created);

        if (!created.success || !created.providerPickupId) {
          steps[0] = { label: 'Create pickup with provider', status: 'fail', note: created.error?.message || 'Create failed' };
          setProviderError(friendlyProviderError(created.error || { code: 'PICKUP_CREATE_FAILED', message: 'Pickup create failed.' }));
          // Phase 2.5.8 — pickup-eligibility memory. The carrier just
          // rejected this exact address snapshot for pickup booking.
          // Persist that fact keyed by the address fingerprint so the
          // operator cannot keep retrying the same payload (which would
          // be guaranteed to fail again). Editing the pickup address
          // invalidates this record.
          {
            // Phase 2.6.1 — record the FULL payload fingerprint so editing
            // the contact phone (the most common cause of a phone-format
            // rejection) clears this memory.
            const failPayloadFp = pickupPayloadFingerprint(ship, pickupForm);
            const failAddrFp = pickupAddrFingerprint(pickupAddrResolved.address);
            setPickupEligibility(p => ({
              ...p,
              [shipmentId]: {
                fingerprint: failPayloadFp,
                addrFingerprint: failAddrFp,
                status: 'failed',
                message: created.error?.providerMessage || created.error?.message,
                providerCode: created.error?.providerCode || created.error?.code,
                httpStatus: created.error?.httpStatus,
                attemptedAt: new Date().toISOString(),
              },
            }));
          }
          setPickupAttemptResult({
            kind: 'error',
            title: `Pickup create failed${created.error?.httpStatus ? ` (HTTP ${created.error.httpStatus})` : ''}`,
            detail: created.error?.message || `${activeProviderId} did not return a pickup id.`,
            steps,
            code: created.error?.providerCode || created.error?.code || 'PICKUP_CREATE_FAILED',
            stage: created.error?.stage || 'pickup_create',
            httpStatus: created.error?.httpStatus,
            providerCode: created.error?.providerCode,
            providerMessage: created.error?.providerMessage,
            fieldErrors: created.error?.fieldErrors,
            context: pickupContext,
            detailsCollapsed: created.error?.details,
            rawError: created.error?.details,
          });
          return;
        }
        steps[0] = { label: 'Create pickup with provider', status: 'ok', note: `Pickup id ${created.providerPickupId}${created.rates ? ` · ${created.rates.length} rate(s)` : ''}` };

        // Phase 2.9 — for providers that require a separate pickup.buy step
        // (EasyPost), pause here and surface the provider-returned pickup_rates
        // to the operator. Step 2 (handleConfirmPickupBuy) calls pickup.buy
        // against the operator's chosen rate. Empty pickup_rates is treated
        // as an honest pre-booking no-rates state — NOT partial_failed — and
        // does not write a PickupRequest to the shipment.
        let buyResult: shippingApi.BuyPickupResponse | null = null;
        if (caps.pickupNeedsRatePurchase) {
          if (!created.rates || created.rates.length === 0) {
            // Phase 2.9 — honest pre-booking no-rates state. The provider
            // created an orphan pickup object but offered no purchasable
            // rates for this date/window, so NO booking was attempted and
            // NO PickupRequest is persisted on the shipment (would be
            // misleading). The orphan provider pickup id is held in the
            // panel so the operator can discard (cancel) it cleanly.
            steps.push({ label: 'Buy pickup rate', status: 'skip', note: 'No pickup_rates returned by provider — booking not attempted.' });
            setPickupRatesPanel({
              shipmentId,
              providerPickupId: created.providerPickupId,
              providerId: activeProviderId || undefined,
              rates: [],
              fetchedAt: now,
              kind: 'no_rates',
              formSnapshot: { date: pickupForm.date, windowStart: pickupForm.windowStart, windowEnd: pickupForm.windowEnd },
            });
            // Phase 2.10 — refined no-rates messaging. The previous text
            // implied a blanket "test mode" rule whenever caps had a test
            // limitation string, which was misleading: QA confirmed FedEx
            // accepts a next-day pickup but refuses a 2-day-out pickup
            // through the same account/provider, which is a date/window/
            // account-specific outcome — NOT a blanket carrier prohibition.
            // We now name the three orthogonal axes (date, window, account)
            // explicitly and only mention the test-mode caveat as an
            // additional possible factor, never as the sole explanation.
            const detail =
              `${activeProviderId} returned no pickup rates for the requested combination of date (${pickupForm.date}), ` +
              `window (${pickupForm.windowStart || '09:00'}–${pickupForm.windowEnd || '17:00'}), carrier service, ` +
              `pickup address, and provider account. This is a per-request outcome — the same carrier may accept a ` +
              `different date or a different window for this same address. Try shifting the date by a day, widening ` +
              `the time window, or switching to drop-off.${caps.pickupTestModeLimitations ? ` Additional possible factor: ${caps.pickupTestModeLimitations}` : ''} ` +
              `No booking was attempted — no carrier confirmation has been issued.`;
            setPickupAttemptResult({ kind: 'partial', title: 'No pickup rates available', detail, steps, code: 'NO_PICKUP_RATES_AVAILABLE', stage: 'pickup_create', providerPickupId: created.providerPickupId, context: pickupContext });
            return;
          }
          // One or more rates returned — open the selection panel and let
          // the operator confirm (Step 2). Auto-select the only rate when
          // there is just one to streamline the common case, but still
          // require an explicit confirm click so the operator sees the
          // exact fee before money/commitment changes hands.
          const initialSelected = created.rates.length === 1 ? created.rates[0].providerRateId : undefined;
          steps.push({ label: 'Buy pickup rate', status: 'pending', note: `Awaiting operator selection — ${created.rates.length} rate(s) returned.` });
          setPickupRatesPanel({
            shipmentId,
            providerPickupId: created.providerPickupId,
            providerId: activeProviderId || undefined,
            rates: created.rates,
            selectedRateId: initialSelected,
            fetchedAt: now,
            kind: 'rates',
            formSnapshot: { date: pickupForm.date, windowStart: pickupForm.windowStart, windowEnd: pickupForm.windowEnd },
          });
          setPickupAttemptResult({
            kind: 'info',
            title: created.rates.length === 1 ? 'Pickup rate ready — confirm to book' : `${created.rates.length} pickup rates returned — choose one to book`,
            detail: `${activeProviderId} created pickup ${created.providerPickupId} and returned ${created.rates.length} rate(s). Pickup is NOT booked yet — review the exact fee and confirm to call pickup.buy.`,
            steps,
            providerPickupId: created.providerPickupId,
            context: pickupContext,
          });
          return;
        } else {
          steps.push({ label: 'Buy pickup rate', status: 'skip', note: 'Provider does not require a separate buy step.' });
        }
        const confirmed: PickupRequest = {
          ...basePickup,
          providerPickupId: created.providerPickupId,
          confirmationNumber: buyResult?.confirmationNumber,
          providerPickupCost: buyResult?.cost,
          providerPickupCurrency: buyResult?.currency,
          status: buyResult?.confirmationNumber ? 'confirmed' : 'requested',
          confirmedAt: buyResult?.confirmationNumber ? new Date().toISOString() : undefined,
          source: 'live_provider',
        };
        updateShipment(shipmentId, {
          pickupRequest: confirmed,
          pickupInfo: {
            ...(ship.pickupInfo || {}),
            pickupRequested: true,
            pickupScheduledAt: pickupForm.date,
            pickupConfirmationNumber: confirmed.confirmationNumber,
          },
          events: [...ship.events, { id: `evt_pu_${Date.now()}`, status: 'Pickup Requested' as any, description: `Pickup booked LIVE with ${activeProviderId} (provider pickup id ${created.providerPickupId})${confirmed.confirmationNumber ? ` — carrier confirmation ${confirmed.confirmationNumber}` : ''}${confirmed.providerPickupCost ? ` — cost ${confirmed.providerPickupCost} ${confirmed.providerPickupCurrency}` : ''}`, timestamp: now, performedBy: 'current_operator' } as ShipmentEvent],
          updatedAt: now,
        });
        steps.push({ label: 'Persist pickup', status: 'ok' });
        // Phase 2.5.8 — pickup-eligibility memory: confirmed for this address.
        {
          // Phase 2.6.1 — store the FULL payload fingerprint on success too
          // so the "confirmed" memory only applies to the exact payload that
          // actually got booked. Any subsequent edit to contact/window/
          // instructions correctly re-opens the eligibility decision.
          const okPayloadFp = pickupPayloadFingerprint(ship, pickupForm);
          const okAddrFp = pickupAddrFingerprint(pickupAddrResolved.address);
          setPickupEligibility(p => ({
            ...p,
            [shipmentId]: {
              fingerprint: okPayloadFp,
              addrFingerprint: okAddrFp,
              status: 'confirmed',
              attemptedAt: new Date().toISOString(),
              providerPickupId: created.providerPickupId,
            },
          }));
        }
        setProviderSuccess(confirmed.confirmationNumber
          ? `Carrier pickup confirmed by ${activeProviderId}. Confirmation: ${confirmed.confirmationNumber}.`
          : `Pickup created with ${activeProviderId}. Awaiting carrier confirmation.`);
        setPickupAttemptResult({
          kind: confirmed.confirmationNumber ? 'success' : 'partial',
          title: confirmed.confirmationNumber ? 'Pickup booked live' : 'Pickup created — awaiting confirmation',
          detail: confirmed.confirmationNumber
            ? `${activeProviderId} confirmed pickup ${created.providerPickupId} for ${pickupForm.date}. Confirmation ${confirmed.confirmationNumber}.`
            : `${activeProviderId} created pickup ${created.providerPickupId} but did not return a carrier confirmation number${caps.pickupTestModeLimitations ? ` — ${caps.pickupTestModeLimitations}` : ''}.`,
          steps,
          providerPickupId: created.providerPickupId,
          confirmationNumber: confirmed.confirmationNumber,
          cost: buyResult?.cost,
          currency: buyResult?.currency,
          context: pickupContext,
        });
        return;
      }

      // -------------------------------------------------------------------
      // Local-only path: provider does not have live pickup booking wired
      // (Shippo, ShipStation, or any provider whose adapter returns
      // NOT_IMPLEMENTED). We persist intent without fabricating a confirmation.
      // -------------------------------------------------------------------
      const localPickup: PickupRequest = { ...basePickup, source: 'local_only' };
      updateShipment(shipmentId, {
        pickupRequest: localPickup,
        pickupInfo: {
          ...(ship.pickupInfo || {}),
          pickupRequested: true,
          pickupScheduledAt: pickupForm.date,
        },
        events: [
          ...ship.events,
          { id: `evt_pu_${Date.now()}`, status: 'Pickup Requested' as any, description: `Pickup recorded LOCALLY (not booked with carrier — ${activeProviderId} adapter does not support live pickup booking) for ${pickupForm.date} ${pickupForm.windowStart || ''}–${pickupForm.windowEnd || ''}. No carrier confirmation number issued.`, timestamp: now, performedBy: 'current_operator' } as ShipmentEvent,
        ],
        updatedAt: now,
      });
      setProviderSuccess(`Pickup recorded locally — not booked with carrier. The ${activeProviderId} adapter does not currently support live pickup booking in this app.`);
      setPickupAttemptResult({
        kind: 'partial',
        title: 'Pickup recorded locally',
        detail: `${activeProviderId || 'The active provider'} does not support live pickup booking. The pickup intent is saved on the shipment but no carrier confirmation has been issued.`,
        steps: [{ label: 'Live booking', status: 'skip', note: 'Provider capability not wired.' }, { label: 'Persist local pickup intent', status: 'ok' }],
        code: 'LOCAL_ONLY',
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Pickup] Unexpected exception', err);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setProviderError(friendlyProviderError({ code: 'NETWORK_ERROR', message: `Live pickup booking failed: ${msg}` }));
      setPickupAttemptResult({
        kind: 'error',
        title: 'Pickup booking threw an exception',
        detail: `An unexpected error was thrown while talking to the server: ${msg}. The pickup was not persisted. Check the browser console and server logs for details.`,
        steps: [{ label: 'Network / server', status: 'fail', note: msg }],
        code: 'NETWORK_ERROR',
        rawError: err instanceof Error ? err.stack : undefined,
      });
    } finally {
      setPickupSubmitting(false);
      // eslint-disable-next-line no-console
      console.log('[Pickup] End attempt');
    }
  }

  // Phase 2.9 — Step 2 of the two-step booking flow. Called when the operator
  // confirms a chosen rate from the pickupRatesPanel. Calls pickup.buy with
  // the EXACT operator-selected providerRateId (no implicit "first/cheapest"
  // selection any more), persists the confirmed PickupRequest with the exact
  // bought rate / currency / service / confirmation number, and clears the
  // panel. Buy failures retain the truthful partial_failed semantics from
  // Phase 2.6.1 — provider pickup id is held on the shipment so the operator
  // can cancel the orphan and retry.
  async function handleConfirmPickupBuy(shipmentId: string) {
    if (isWriteBlocked) return;
    const panel = pickupRatesPanel;
    if (!panel || panel.shipmentId !== shipmentId || panel.kind !== 'rates') return;
    const ship = shipments.find(s => s.id === shipmentId);
    if (!ship) return;
    const rate = panel.rates.find(r => r.providerRateId === panel.selectedRateId);
    if (!rate) {
      setProviderError(friendlyProviderError({ code: 'VALIDATION', message: 'Choose a pickup rate to confirm.' }));
      return;
    }
    const providerId = panel.providerId;
    const totalWeight = ship.packages.reduce((sum, p) => sum + (p.weight || 0), 0);
    const carrier = rate.carrier || ship.carrier || ship.selectedRate?.carrier || 'UPS';
    const now = new Date().toISOString();
    const basePickup: PickupRequest = {
      id: `pr_${Date.now()}`,
      shipmentId,
      providerId,
      carrier,
      status: 'requested',
      requestedDate: panel.formSnapshot.date,
      windowStart: panel.formSnapshot.windowStart || undefined,
      windowEnd: panel.formSnapshot.windowEnd || undefined,
      pickupAddress: resolvePickupAddress(ship).address,
      contactName: pickupForm.contactName.trim() || undefined,
      contactPhone: pickupForm.contactPhone.trim() || resolvePickupAddress(ship).address.phone || undefined,
      packageCount: ship.packages.length,
      totalWeight: totalWeight || undefined,
      handlingNotes: pickupForm.notes.trim() || undefined,
      requestedAt: now,
      requestedBy: 'current_operator',
    };
    setPickupSubmitting(true);
    try {
      const steps: PickupAttemptResult['steps'] = [
        { label: 'Create pickup with provider', status: 'ok', note: `Pickup id ${panel.providerPickupId} · ${panel.rates.length} rate(s)` },
        { label: 'Buy pickup rate', status: 'pending', note: `Selected: ${rate.carrier} ${rate.service} @ ${rate.rate.toFixed(2)} ${rate.currency}` },
      ];
      setPickupAttemptResult({
        kind: 'info',
        title: 'Buying pickup rate…',
        detail: `Calling ${providerId || 'provider'} pickup.buy for the selected rate.`,
        steps,
        providerPickupId: panel.providerPickupId,
      });
      // eslint-disable-next-line no-console
      console.log('[Pickup] buyProviderPickup →', { providerPickupId: panel.providerPickupId, providerRateId: rate.providerRateId, carrier: rate.carrier, service: rate.service });
      const buyResult = await shippingApi.buyProviderPickup(panel.providerPickupId, rate.providerRateId, providerId);
      // eslint-disable-next-line no-console
      console.log('[Pickup] buyProviderPickup ←', buyResult);

      if (!buyResult.success) {
        steps[1] = { label: 'Buy pickup rate', status: 'fail', note: buyResult.error?.message || 'Buy failed' };
        // Phase 2.6.1 partial-failure semantics retained: a provider pickup
        // object exists but no carrier confirmation was issued. Persist the
        // orphan so the operator can cancel + retry.
        const partial: PickupRequest = {
          ...basePickup,
          providerPickupId: panel.providerPickupId,
          providerPickupService: rate.service,
          providerPickupRateId: rate.providerRateId,
          status: 'partial_failed',
          source: 'live_provider',
          failureReason: buyResult.error?.message || 'Pickup buy failed — booking NOT confirmed.',
        };
        updateShipment(shipmentId, {
          pickupRequest: partial,
          events: [...ship.events, { id: `evt_pu_${Date.now()}`, status: 'Pickup Booking Failed' as any, description: `Pickup object created with ${providerId} (id ${panel.providerPickupId}) but rate-purchase failed for ${rate.carrier} ${rate.service} @ ${rate.rate.toFixed(2)} ${rate.currency}: ${buyResult.error?.message}. Booking NOT confirmed — no carrier confirmation issued. The orphaned provider pickup record can be cancelled from this panel.`, timestamp: now, performedBy: 'current_operator' } as ShipmentEvent],
          updatedAt: now,
        });
        setProviderError(friendlyProviderError(buyResult.error || { code: 'PICKUP_BUY_FAILED', message: 'Pickup buy failed.' }));
        setPickupAttemptResult({
          kind: 'partial',
          title: `Pickup created but buy failed${buyResult.error?.httpStatus ? ` (HTTP ${buyResult.error.httpStatus})` : ''}`,
          detail: `Pickup ${panel.providerPickupId} was created with ${providerId}, but the rate-purchase step failed for ${rate.carrier} ${rate.service}: ${buyResult.error?.message || 'unknown error'}. The pickup record is saved so you can cancel and retry.`,
          steps,
          code: buyResult.error?.providerCode || buyResult.error?.code || 'PICKUP_BUY_FAILED',
          stage: buyResult.error?.stage || 'pickup_buy',
          httpStatus: buyResult.error?.httpStatus,
          providerCode: buyResult.error?.providerCode,
          providerMessage: buyResult.error?.providerMessage,
          fieldErrors: buyResult.error?.fieldErrors,
          providerPickupId: panel.providerPickupId,
          detailsCollapsed: buyResult.error?.details,
          rawError: buyResult.error?.details,
        });
        setPickupRatesPanel(null);
        return;
      }
      // Success — persist exact bought rate, currency, service, and
      // confirmation number on the PickupRequest. The cost on the request
      // record is the EXACT figure returned by pickup.buy (or, if the
      // provider didn't echo it back, the figure the operator selected
      // from pickup_rates — they are typically the same value).
      const boughtCost = typeof buyResult.cost === 'number' ? buyResult.cost : rate.rate;
      const boughtCurrency = buyResult.currency || rate.currency;
      steps[1] = { label: 'Buy pickup rate', status: 'ok', note: `Confirmation ${buyResult.confirmationNumber || '(none)'} · ${boughtCost.toFixed(2)} ${boughtCurrency}` };
      const confirmed: PickupRequest = {
        ...basePickup,
        providerPickupId: panel.providerPickupId,
        confirmationNumber: buyResult.confirmationNumber,
        providerPickupCost: boughtCost,
        providerPickupCurrency: boughtCurrency,
        providerPickupService: rate.service,
        providerPickupRateId: rate.providerRateId,
        carrier: rate.carrier || carrier,
        status: buyResult.confirmationNumber ? 'confirmed' : 'requested',
        confirmedAt: buyResult.confirmationNumber ? now : undefined,
        source: 'live_provider',
      };
      updateShipment(shipmentId, {
        pickupRequest: confirmed,
        pickupInfo: {
          ...(ship.pickupInfo || {}),
          pickupRequested: true,
          pickupScheduledAt: panel.formSnapshot.date,
          pickupConfirmationNumber: confirmed.confirmationNumber,
        },
        events: [...ship.events, { id: `evt_pu_${Date.now()}`, status: 'Pickup Requested' as any, description: `Pickup booked LIVE with ${providerId} (provider pickup id ${panel.providerPickupId}, ${rate.carrier} ${rate.service})${confirmed.confirmationNumber ? ` — carrier confirmation ${confirmed.confirmationNumber}` : ''} — exact pickup fee ${boughtCost.toFixed(2)} ${boughtCurrency}`, timestamp: now, performedBy: 'current_operator' } as ShipmentEvent],
        updatedAt: now,
      });
      steps.push({ label: 'Persist pickup', status: 'ok' });
      {
        const okPayloadFp = pickupPayloadFingerprint(ship, pickupForm);
        const okAddrFp = pickupAddrFingerprint(resolvePickupAddress(ship).address);
        setPickupEligibility(p => ({
          ...p,
          [shipmentId]: {
            fingerprint: okPayloadFp,
            addrFingerprint: okAddrFp,
            status: 'confirmed',
            attemptedAt: now,
            providerPickupId: panel.providerPickupId,
          },
        }));
      }
      setProviderSuccess(confirmed.confirmationNumber
        ? `Carrier pickup confirmed by ${providerId}. Confirmation: ${confirmed.confirmationNumber}. Fee: ${boughtCost.toFixed(2)} ${boughtCurrency}.`
        : `Pickup created with ${providerId}. Awaiting carrier confirmation.`);
      setPickupAttemptResult({
        kind: confirmed.confirmationNumber ? 'success' : 'partial',
        title: confirmed.confirmationNumber ? 'Pickup booked live' : 'Pickup created — awaiting confirmation',
        detail: confirmed.confirmationNumber
          ? `${providerId} confirmed pickup ${panel.providerPickupId} (${rate.carrier} ${rate.service}) for ${panel.formSnapshot.date}. Confirmation ${confirmed.confirmationNumber}. Exact fee ${boughtCost.toFixed(2)} ${boughtCurrency}.`
          : `${providerId} created pickup ${panel.providerPickupId} but did not return a carrier confirmation number.`,
        steps,
        providerPickupId: panel.providerPickupId,
        confirmationNumber: confirmed.confirmationNumber,
        cost: boughtCost,
        currency: boughtCurrency,
      });
      setPickupRatesPanel(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[Pickup] Unexpected exception (buy)', err);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setProviderError(friendlyProviderError({ code: 'NETWORK_ERROR', message: `Live pickup buy failed: ${msg}` }));
      setPickupAttemptResult({
        kind: 'error',
        title: 'Pickup buy threw an exception',
        detail: `An unexpected error was thrown while talking to the server: ${msg}. The pickup was not booked.`,
        steps: [{ label: 'Network / server', status: 'fail', note: msg }],
        code: 'NETWORK_ERROR',
        rawError: err instanceof Error ? err.stack : undefined,
      });
    } finally {
      setPickupSubmitting(false);
    }
  }

  // Phase 2.9 — discard the open rate-selection panel. If the provider
  // supports cancellation, also cancel the orphan provider pickup record
  // (created by pickup.create at Step 1 but never bought) so the operator
  // doesn't leave a dangling pickup on the carrier side.
  async function handleDiscardPickupOptions() {
    if (isWriteBlocked) return;
    const panel = pickupRatesPanel;
    if (!panel) return;
    const caps = panel.providerId ? PROVIDER_CAPABILITIES[panel.providerId.toLowerCase()] : null;
    setPickupRatesPanel(null);
    if (caps?.supportsPickupCancellation && panel.providerPickupId) {
      try {
        // eslint-disable-next-line no-console
        console.log('[Pickup] discard → cancelProviderPickup', { providerPickupId: panel.providerPickupId });
        const result = await shippingApi.cancelProviderPickup(panel.providerPickupId, panel.providerId);
        if (!result.success) {
          // Don't block the UI — the panel is gone either way; surface a
          // soft warning so the operator can cancel manually if needed.
          setProviderError(friendlyProviderError(result.error || { code: 'PICKUP_CANCEL_FAILED', message: `Could not cancel orphan provider pickup ${panel.providerPickupId}. You may need to cancel it from the provider dashboard.` }));
          return;
        }
        setProviderSuccess(`Discarded pickup options. Orphan provider pickup ${panel.providerPickupId} cancelled.`);
      } catch (err) {
        setProviderError(friendlyProviderError({ code: 'NETWORK_ERROR', message: `Discard cleanup failed: ${err instanceof Error ? err.message : 'Unknown error'}` }));
      }
    } else {
      setProviderSuccess('Discarded pickup options.');
    }
  }

  // Phase 2.10 — pickup cancellation now goes through a confirmation modal.
  // `handleCancelPickup` is the entry point: it validates permission/state
  // and opens the modal. The actual cancel call runs from
  // `executePickupCancel`, which the modal's Confirm button invokes. This
  // gives the operator an explicit "this will tell <carrier> to cancel
  // pickup <confirmation #>" warning, an in-flight indicator, and a clear
  // success/failure outcome inside the modal — replacing the previous
  // fire-and-forget UX where the operator could not tell whether the
  // cancel actually happened on the carrier side.
  function handleCancelPickup(shipmentId: string) {
    if (isWriteBlocked) return;
    if (!canCancelPickup) {
      setProviderError(friendlyProviderError({ code: 'PERMISSION_DENIED', message: 'You do not have permission to cancel a carrier pickup.' }));
      return;
    }
    const ship = shipments.find(s => s.id === shipmentId);
    if (!ship?.pickupRequest) return;
    if (!PICKUP_CANCELLABLE_STATUSES.includes(ship.pickupRequest.status)) {
      setProviderError(friendlyProviderError({ code: 'INVALID_STATE', message: `Pickup is "${ship.pickupRequest.status}" and cannot be cancelled.` }));
      return;
    }
    const caps = activeProviderId ? PROVIDER_CAPABILITIES[activeProviderId.toLowerCase()] : null;
    const isLive = ship.pickupRequest.source === 'live_provider'
      && !!ship.pickupRequest.providerPickupId
      && !!caps?.supportsPickupCancellation;
    setPickupCancelModal({
      shipmentId,
      carrier: ship.pickupRequest.carrier,
      confirmationNumber: ship.pickupRequest.confirmationNumber,
      isLive,
      inFlight: false,
    });
  }

  async function executePickupCancel() {
    const modal = pickupCancelModal;
    if (!modal || modal.inFlight) return;
    const ship = shipments.find(s => s.id === modal.shipmentId);
    if (!ship?.pickupRequest) {
      setPickupCancelModal({ ...modal, result: { ok: false, message: 'Shipment or pickup record no longer exists.' } });
      return;
    }
    setPickupCancelModal({ ...modal, inFlight: true, result: undefined });
    const now = new Date().toISOString();
    const caps = activeProviderId ? PROVIDER_CAPABILITIES[activeProviderId.toLowerCase()] : null;
    const isLive = ship.pickupRequest.source === 'live_provider' && !!ship.pickupRequest.providerPickupId;
    let liveCancelled = false;
    if (isLive && caps?.supportsPickupCancellation) {
      try {
        const result = await shippingApi.cancelProviderPickup(ship.pickupRequest.providerPickupId!, activeProviderId || undefined);
        if (!result.success) {
          const friendly = friendlyProviderError(result.error || { code: 'PICKUP_CANCEL_FAILED', message: 'Pickup cancel failed.' });
          setProviderError(friendly);
          setPickupCancelModal({ ...modal, inFlight: false, result: { ok: false, message: friendly.message } });
          return;
        }
        liveCancelled = true;
      } catch (err) {
        const message = `Live pickup cancel failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
        setProviderError(friendlyProviderError({ code: 'NETWORK_ERROR', message }));
        setPickupCancelModal({ ...modal, inFlight: false, result: { ok: false, message } });
        return;
      }
    }
    const updated: PickupRequest = {
      ...ship.pickupRequest,
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: 'current_operator',
      cancellationReason: pickupCancelReason.trim() || undefined,
    };
    updateShipment(modal.shipmentId, {
      pickupRequest: updated,
      pickupInfo: { ...(ship.pickupInfo || {}), pickupRequested: false },
      events: [
        ...ship.events,
        { id: `evt_pu_cancel_${Date.now()}`, status: 'Pickup Cancelled' as any, description: `Pickup ${ship.pickupRequest.confirmationNumber || ship.pickupRequest.id} cancelled${liveCancelled ? ` LIVE with ${activeProviderId}` : ' locally'}${pickupCancelReason ? ` — ${pickupCancelReason}` : ''}`, timestamp: now, performedBy: 'current_operator' } as ShipmentEvent,
      ],
      updatedAt: now,
    });
    const successMsg = liveCancelled
      ? `Carrier pickup cancelled live with ${activeProviderId}.`
      : 'Pickup cancelled locally (no live carrier call was needed for this provider/source).';
    setPickupCancelReason('');
    setProviderSuccess(successMsg);
    setPickupCancelModal({ ...modal, inFlight: false, result: { ok: true, message: successMsg } });
  }

  function getProviderPrerequisiteMessage(): string | null {
    if (activeProviderId) return null;
    const hasAnyConfigured = providerStatuses.length > 0;
    return hasAnyConfigured ? 'Set an active shipping provider' : 'Configure a shipping provider';
  }

  function getRatePrerequisites(shipment: Shipment): string[] {
    const missing: string[] = [];
    if (!isOriginAddressAccepted(shipment)) missing.push('Validate origin address');
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
    if (!isOriginAddressAccepted(shipment)) missing.push('Validate origin address');
    if (!isAddressAccepted(shipment)) missing.push('Validate destination address');
    if (!hasShippablePackages(shipment)) missing.push('Add packages with weight or contents');
    if (!shipment.selectedRate && (!shipment.carrier || !shipment.serviceLevel)) missing.push('Select a shipping rate or set carrier and service level');
    if (isCarrierRequiringPhone(shipment)) {
      if (!isValidPhone(shipment.destinationAddress.phone)) {
        missing.push('Recipient phone number required for UPS/FedEx (at least 10 digits)');
      }
      if (!isValidPhone(shipment.originAddress.phone)) {
        missing.push('Shipper phone number required for UPS/FedEx (at least 10 digits)');
      }
    }
    const providerMsg = getProviderPrerequisiteMessage();
    if (providerMsg) missing.push(providerMsg);
    return missing;
  }

  async function validateSingleSide(
    shipment: Shipment,
    side: 'origin' | 'destination'
  ): Promise<{ ok: boolean; status?: AddressValidationResult['status']; message?: string; updates: Partial<Shipment> }> {
    const targetAddress = side === 'origin' ? shipment.originAddress : shipment.destinationAddress;
    const result = await shippingApi.validateAddress(targetAddress);
    const updates: Partial<Shipment> = {};
    if (result.success && result.result) {
      const validationResult: AddressValidationResult = result.result;
      // For `corrected` results, swap the provider's suggested address into the shipment
      // fields so the operator can re-validate against the cleaned address. Do NOT mark
      // the result as accepted — `corrected` is an intermediate state and must not
      // satisfy isAddressAccepted/isOriginAddressAccepted. The operator must explicitly
      // re-run Validate Addresses on the corrected address and receive a `validated`
      // status before Get Rates / Purchase Label become enabled.
      // Phase 2.6.1 — when applying a "corrected" suggestion, ONLY adopt
      // the address-shape fields (line1/line2/city/state/postal/country)
      // and preserve the operator-entered contact fields (name, company,
      // phone, email). The previous spread-the-whole-suggestion behavior
      // was overwriting the operator-typed phone with the server's
      // round-tripped (and previously prepended-"1") value, mutating a
      // valid 10-digit US number into an 11-digit one and showing it back
      // in the form. Contact fields are NOT verified by the address
      // verification call, so they have no business being rewritten by it.
      const mergeCorrected = (existing: ShipmentAddress, suggested: ShipmentAddress): ShipmentAddress => ({
        ...existing,
        line1: suggested.line1 || existing.line1,
        line2: suggested.line2 ?? existing.line2,
        city: suggested.city || existing.city,
        state: suggested.state || existing.state,
        postalCode: suggested.postalCode || existing.postalCode,
        country: suggested.country || existing.country,
      });
      if (side === 'origin') {
        updates.originAddressValidation = validationResult;
        if (validationResult.status === 'corrected' && validationResult.suggestedAddress) {
          updates.originAddress = mergeCorrected(shipment.originAddress, validationResult.suggestedAddress);
        }
      } else {
        updates.addressValidation = validationResult;
        if (validationResult.status === 'corrected' && validationResult.suggestedAddress) {
          updates.destinationAddress = mergeCorrected(shipment.destinationAddress, validationResult.suggestedAddress);
        }
      }
      return { ok: true, status: validationResult.status, updates };
    }
    const failedValidation: AddressValidationResult = {
      status: 'failed',
      validatedAt: new Date().toISOString(),
      originalAddress: targetAddress,
      messages: [result.error?.message || 'Validation failed'],
    };
    if (side === 'origin') updates.originAddressValidation = failedValidation;
    else updates.addressValidation = failedValidation;
    return { ok: false, status: 'failed', message: result.error?.message, updates };
  }

  // Combined origin + destination validation in a single operator action.
  // Validates origin and destination sequentially, merges both result updates into a single
  // updateShipment call, and surfaces one consolidated feedback message.
  async function handleValidateAddresses(shipmentId: string) {
    if (isWriteBlocked) return;
    const shipment = shipments.find(s => s.id === shipmentId);
    if (!shipment) return;
    clearProviderFeedback();
    setProviderLoading('validate');

    const originResult = await validateSingleSide(shipment, 'origin');
    // Re-fetch to pick up any origin suggested-address swap before validating destination.
    const refreshed: Shipment = { ...shipment, ...originResult.updates } as Shipment;
    const destResult = await validateSingleSide(refreshed, 'destination');

    const now = new Date().toISOString();
    updateShipment(shipmentId, {
      ...originResult.updates,
      ...destResult.updates,
      updatedAt: now,
    });

    const summarize = (label: string, r: { ok: boolean; status?: AddressValidationResult['status']; message?: string }) => {
      if (!r.ok) return `${label}: failed${r.message ? ` (${r.message})` : ''}`;
      if (r.status === 'validated') return `${label}: validated`;
      // Phase 2.7 — explicit two-stage language. The next operator action
      // on a 'corrected' side is the Validate Address (step 2) button.
      if (r.status === 'corrected') return `${label}: corrected — click Validate Address (step 2) to confirm the suggested address and unlock Get Rates`;
      return `${label}: ${r.status ?? 'completed'}`;
    };

    const anyFailed = !originResult.ok || !destResult.ok;
    const summary = `${summarize('Origin', originResult)} • ${summarize('Destination', destResult)}`;
    if (anyFailed) {
      setProviderError(friendlyProviderError({ code: 'ADDRESS_VALIDATION_PARTIAL', message: summary }));
    } else {
      setProviderSuccess(`Addresses validated — ${summary}.`);
    }
    setProviderLoading(null);
  }

  // Legacy single-side validator retained for internal/programmatic use. The operator-facing
  // UX uses the combined handleValidateAddresses action above.
  async function handleValidateAddress(shipmentId: string, side: 'origin' | 'destination' = 'destination') {
    if (isWriteBlocked) return;
    const shipment = shipments.find(s => s.id === shipmentId);
    if (!shipment) return;
    clearProviderFeedback();
    setProviderLoading('validate');
    const result = await validateSingleSide(shipment, side);
    updateShipment(shipmentId, { ...result.updates, updatedAt: new Date().toISOString() });
    if (!result.ok) {
      setProviderError(friendlyProviderError({ code: 'UNKNOWN', message: result.message || 'Address validation failed.' }));
    } else if (result.status === 'validated') {
      setProviderSuccess(`${side === 'origin' ? 'Origin' : 'Destination'} address validated successfully.`);
    } else if (result.status === 'corrected') {
      setProviderSuccess(`${side === 'origin' ? 'Origin' : 'Destination'} address corrected from provider suggestion. Re-run Validate Addresses to confirm and enable rate fetching.`);
    } else {
      setProviderSuccess(`${side === 'origin' ? 'Origin' : 'Destination'} address validation completed.`);
    }
    setProviderLoading(null);
  }
  void handleValidateAddress;

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

  const IN_FLIGHT_STATUSES: ShipmentStatus[] = ['Dispatched', 'In Transit', 'Exception'];
  const SYNCABLE_TERMINAL_STATUSES: ShipmentStatus[] = ['Delivered', 'Rejected', 'Returned'];
  const PRE_DISPATCH_STATUSES: ShipmentStatus[] = ['Draft', 'Ready', 'Label Created', 'Packed'];

  type BulkSyncExclusion = { shipment: Shipment; reason: string };

  function classifyBulkSyncShipments(): { eligible: Shipment[]; excluded: BulkSyncExclusion[] } {
    const eligible: Shipment[] = [];
    const excluded: BulkSyncExclusion[] = [];
    for (const s of shipments) {
      if (getShipmentMode(s) === 'manual') { excluded.push({ shipment: s, reason: 'Manual mode (no provider)' }); continue; }
      if (!s.trackingNumber) { excluded.push({ shipment: s, reason: 'No tracking number' }); continue; }
      if (PRE_DISPATCH_STATUSES.includes(s.status)) { excluded.push({ shipment: s, reason: `Pre-dispatch status (${s.status})` }); continue; }
      if (s.status === 'Cancelled') { excluded.push({ shipment: s, reason: 'Cancelled (not syncable)' }); continue; }

      const isInFlight = IN_FLIGHT_STATUSES.includes(s.status);
      const isTerminal = SYNCABLE_TERMINAL_STATUSES.includes(s.status);

      if (bulkSyncFilters.inFlightOnly && !isInFlight && !isTerminal) {
        excluded.push({ shipment: s, reason: `Status "${s.status}" not in-flight or terminal` }); continue;
      }
      if (isTerminal && !bulkSyncFilters.includeTerminal) {
        excluded.push({ shipment: s, reason: `Terminal status (${s.status}) — enable "Include terminal"` }); continue;
      }
      if (!bulkSyncFilters.inFlightOnly && !isInFlight && !isTerminal) {
        excluded.push({ shipment: s, reason: `Status "${s.status}" not eligible` }); continue;
      }

      if (bulkSyncFilters.syncFailuresOnly && (!s.syncFailureCount || s.syncFailureCount === 0)) {
        excluded.push({ shipment: s, reason: 'No sync failures (filter active)' }); continue;
      }
      if (bulkSyncFilters.staleDays > 0) {
        const lastSync = s.lastTrackingSyncAt ? new Date(s.lastTrackingSyncAt).getTime() : 0;
        const cutoff = Date.now() - bulkSyncFilters.staleDays * 24 * 60 * 60 * 1000;
        if (lastSync > cutoff) { excluded.push({ shipment: s, reason: `Synced recently (within ${bulkSyncFilters.staleDays}d)` }); continue; }
      }
      eligible.push(s);
    }
    return { eligible, excluded };
  }

  function getBulkSyncEligibleShipments() {
    return classifyBulkSyncShipments().eligible;
  }

  async function handleBulkSync() {
    if (isWriteBlocked) return;
    const eligible = getBulkSyncEligibleShipments();
    if (eligible.length === 0) return;

    setBulkSyncRunning(true);
    setBulkSyncResults(null);
    setBulkSyncSummary(null);
    setBulkSyncProgress({ current: 0, total: eligible.length });

    const BATCH_SIZE = 3;
    const BATCH_DELAY = 500;
    const allResults: shippingApi.BulkSyncResult[] = [];

    for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
      const batch = eligible.slice(i, i + BATCH_SIZE);
      const batchInput = batch.map(s => ({
        shipmentId: s.id,
        trackingNumber: s.trackingNumber!,
        carrier: s.carrier,
        providerShipmentId: s.providerShipmentId,
      }));

      try {
        const response = await shippingApi.bulkSyncTracking(batchInput, BATCH_SIZE, BATCH_DELAY);
        if (response.success && response.results) {
          for (const r of response.results) {
            const shipment = shipments.find(s => s.id === r.shipmentId);
            if (!shipment) { allResults.push(r); continue; }

            if (r.result === 'updated' && r.events && r.events.length > 0) {
              const existingRefs = new Set(
                (shipment.providerTrackingEvents || []).map(e => e.providerEventRef).filter(Boolean)
              );
              const existingTimestampStatus = new Set(
                (shipment.providerTrackingEvents || []).map(e => `${e.timestamp}|${e.status}`)
              );
              const newEvents = (r.events as any[]).filter(e => {
                if (e.providerEventRef && existingRefs.has(e.providerEventRef)) return false;
                if (existingTimestampStatus.has(`${e.timestamp}|${e.status}`)) return false;
                return true;
              });

              if (newEvents.length === 0) {
                const now = new Date().toISOString();
                updateShipment(r.shipmentId, { lastTrackingSyncAt: now, syncFailureCount: 0, lastSyncError: undefined, updatedAt: now });
                allResults.push({ ...r, result: 'unchanged', newEventCount: 0 });
              } else {
                const mergedEvents = [...(shipment.providerTrackingEvents || []), ...newEvents]
                  .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                const now = new Date().toISOString();
                const updates: Partial<Shipment> = {
                  providerTrackingEvents: mergedEvents,
                  lastTrackingSyncAt: now,
                  syncFailureCount: 0,
                  lastSyncError: undefined,
                  estimatedDelivery: r.estimatedDelivery || shipment.estimatedDelivery,
                  updatedAt: now,
                };
                applyTrackingStatusToShipment(shipment, mergedEvents, updates, 'Bulk Reconciliation');
                updateShipment(r.shipmentId, updates);
                allResults.push({ ...r, newEventCount: newEvents.length });
              }
            } else if (r.result === 'test_limitation') {
              if (shipment.syncFailureCount && shipment.syncFailureCount > 0) {
                updateShipment(r.shipmentId, { syncFailureCount: 0, lastSyncError: undefined, updatedAt: new Date().toISOString() });
              }
              allResults.push(r);
            } else if (r.result === 'failed') {
              updateShipment(r.shipmentId, {
                syncFailureCount: (shipment.syncFailureCount || 0) + 1,
                lastSyncError: r.error?.message,
                updatedAt: new Date().toISOString(),
              });
              allResults.push(r);
            } else {
              const now = new Date().toISOString();
              updateShipment(r.shipmentId, { lastTrackingSyncAt: now, syncFailureCount: 0, lastSyncError: undefined, updatedAt: now });
              allResults.push(r);
            }
          }
        }
      } catch (e: any) {
        for (const s of batch) {
          allResults.push({
            shipmentId: s.id,
            trackingNumber: s.trackingNumber!,
            result: 'failed',
            error: { code: 'BATCH_ERROR', message: e.message || 'Batch request failed.' },
          });
        }
      }

      setBulkSyncProgress({ current: Math.min(i + BATCH_SIZE, eligible.length), total: eligible.length });
    }

    const summary = {
      total: allResults.length,
      updated: allResults.filter(r => r.result === 'updated').length,
      unchanged: allResults.filter(r => r.result === 'unchanged').length,
      failed: allResults.filter(r => r.result === 'failed').length,
      testLimitation: allResults.filter(r => r.result === 'test_limitation').length,
    };

    setBulkSyncResults(allResults);
    setBulkSyncSummary(summary);
    setBulkSyncRunning(false);
    setBulkSyncProgress(null);
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

  // Phase 2.7 — clear stale rates and selected rate when an address change
  // invalidates validation. Driven by the shipment's address-validation
  // fingerprint, NOT raw address fields, so this only fires when the
  // operator's edit actually moves either side out of 'validated'. Skips
  // post-purchase shipments (label is locked anyway) and manual mode (no
  // provider rates apply). Avoids scheduling work when there's nothing to
  // clear.
  const selectedShipOriginReadiness = selectedShip ? getAddressReadinessForSide(selectedShip, 'origin') : 'unchecked';
  const selectedShipDestReadiness = selectedShip ? getAddressReadinessForSide(selectedShip, 'destination') : 'unchecked';
  useEffect(() => {
    if (!selectedShip) return;
    if (selectedShip.label) return;
    if (getShipmentMode(selectedShip) === 'manual') return;
    const bothValidated = selectedShipOriginReadiness === 'validated' && selectedShipDestReadiness === 'validated';
    if (bothValidated) return;
    // Clear in-memory rate panel state so the operator does not see a
    // stale list attached to an address that is no longer validated.
    if (availableRates.length > 0 || showRatesPanel) {
      setAvailableRates([]);
      setShowRatesPanel(false);
    }
    // Clear the persisted selectedRate so downstream code paths cannot
    // treat it as a confirmed choice. Get Rates / Purchase Label gating
    // already requires both sides to be 'validated', so this is
    // defense-in-depth — but the spec requires the rate to be invalidated,
    // and silently keeping it stored would be misleading.
    if (selectedShip.selectedRate) {
      updateShipment(selectedShip.id, { selectedRate: undefined, updatedAt: new Date().toISOString() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShip?.id, selectedShipOriginReadiness, selectedShipDestReadiness]);

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
          <div className="space-y-6">
            <ShippingProvidersPage embedded onProviderChange={refreshProviderState} />
            {/* Carrier Locator Settings — per-store, per-adapter configuration.
                Independent of the active shipping provider (EasyPost / Shippo /
                ShipStation) because aggregators do not expose a unified
                service-point locator. Persisted in sessionStorage. */}
            {(() => {
              const summary = locatorStatusSummary();
              const overallTone = summary.configured > 0
                ? { bg: 'bg-emerald-100', text: 'text-emerald-700', label: `${summary.configured} configured / ${summary.total}` }
                : summary.enabled > 0
                ? { bg: 'bg-sky-100', text: 'text-sky-700', label: `${summary.enabled} enabled — credentials needed` }
                : { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Not configured' };
              return (
                <div className="bg-white rounded-2xl border border-slate-200 p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <p className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1.5"><span className="material-symbols-outlined text-sm">explore</span>Carrier Locators</p>
                      <p className="text-xs text-slate-500 mt-1">Direct carrier credentials for live service-point lookup. Each adapter is independent — configure only the carriers you ship with.</p>
                    </div>
                    <span className={`px-2 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest ${overallTone.bg} ${overallTone.text}`}>{overallTone.label}</span>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2 mb-4">
                    <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">warning</span>
                    <div className="text-xs text-amber-700">
                      <p className="font-black">Adapter scaffolds — live API calls not yet wired</p>
                      <p className="mt-0.5">Configuration entered here is persisted per browser session and will feed the underlying adapters in <span className="font-mono">src/shipping/locators/</span> once the carrier API calls land. The service-point modal continues to use manual entry until then. Provider aggregators (EasyPost / Shippo / ShipStation) do not expose a unified service-point locator.</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {LOCATOR_DEFINITIONS.map(def => {
                      const cfg = locatorConfig[def.id] || { enabled: false, environment: 'sandbox' as const, credentialRef: '', status: 'not_configured' as const };
                      const statusTone = cfg.status === 'verified'
                        ? { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'Verified' }
                        : cfg.status === 'configured'
                        ? { bg: 'bg-sky-100', text: 'text-sky-700', label: 'Configured' }
                        : cfg.status === 'verification_failed'
                        ? { bg: 'bg-rose-100', text: 'text-rose-700', label: 'Verify failed' }
                        : { bg: 'bg-slate-100', text: 'text-slate-500', label: 'Not configured' };
                      const disabled = !canManageProviderSettings || isWriteBlocked;
                      return (
                        <div key={def.id} className="border border-slate-200 rounded-2xl p-4 space-y-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-sm font-black text-slate-800">{def.name}</p>
                              <p className="text-[11px] text-slate-500 mt-0.5">{def.desc}</p>
                            </div>
                            <span className={`shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest ${statusTone.bg} ${statusTone.text}`}>{statusTone.label}</span>
                          </div>
                          <label className="flex items-center gap-2 text-[11px] font-black text-slate-700">
                            <input type="checkbox" checked={cfg.enabled} disabled={disabled} onChange={e => updateLocatorAdapter(def.id, { enabled: e.target.checked })} className="rounded border-slate-300" />
                            Enable adapter
                          </label>
                          <div>
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Environment</label>
                            <select value={cfg.environment} disabled={disabled || !cfg.enabled} onChange={e => updateLocatorAdapter(def.id, { environment: e.target.value as 'sandbox' | 'production' })} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs disabled:bg-slate-50 disabled:text-slate-400">
                              <option value="sandbox">Sandbox</option>
                              <option value="production">Production</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Credential reference</label>
                            <input type="text" value={cfg.credentialRef} disabled={disabled || !cfg.enabled} onChange={e => updateLocatorAdapter(def.id, { credentialRef: e.target.value })} placeholder={def.envHint} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs font-mono disabled:bg-slate-50 disabled:text-slate-400" />
                            <p className="text-[10px] text-slate-400 mt-1">Real secrets must be set as server-side env vars (<span className="font-mono">{def.envHint}</span>). This field is a per-store reference label only.</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => handleVerifyLocator(def.id)} disabled={disabled || !cfg.enabled || !cfg.credentialRef.trim()} className="flex-1 px-3 py-2 bg-primary/10 text-primary text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-primary/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed">Verify</button>
                            <a href={def.docs} target="_blank" rel="noreferrer" className="px-3 py-2 bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-200 transition-all">Docs</a>
                          </div>
                          {cfg.lastVerifiedAt && (
                            <div className={`text-[10px] rounded-lg p-2 ${cfg.status === 'verified' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                              <p className="font-black">Last verify {formatDateTime(cfg.lastVerifiedAt)}</p>
                              {cfg.lastVerifyMessage && <p className="mt-0.5">{cfg.lastVerifyMessage}</p>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-3">Adapters scaffolded in <span className="font-mono">src/shipping/locators/</span>. Until the carrier API calls land, Verify will record a <span className="font-bold">verification_failed</span> with an explanatory note rather than fake a successful connection.</p>
                </div>
              );
            })()}
          </div>
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
          <div className="flex items-center gap-2">
            {canSyncTracking && activeProviderId && !isWriteBlocked && (
              <button
                onClick={() => { setBulkSyncResults(null); setBulkSyncSummary(null); setShowBulkSyncModal(true); }}
                className="px-5 py-3 bg-indigo-50 text-indigo-700 border border-indigo-200 font-black text-[10px] uppercase tracking-widest rounded-2xl hover:bg-indigo-100 transition-all active:scale-95 flex items-center gap-2"
              >
                <span className="material-symbols-outlined text-sm">sync</span>
                Reconcile Shipments
              </button>
            )}
            {canSyncTracking && activeProviderId && isWriteBlocked && (
              <div className="px-5 py-3 bg-slate-50 text-slate-400 border border-slate-200 font-black text-[10px] uppercase tracking-widest rounded-2xl flex items-center gap-2 cursor-not-allowed" title="Bulk sync is disabled in preview mode">
                <span className="material-symbols-outlined text-sm">sync_disabled</span>
                Reconcile (Preview)
              </div>
            )}
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
                      {s.returnInfo?.isReturn && (
                        <span className="px-2 py-0.5 text-[8px] font-black uppercase tracking-widest rounded-md bg-teal-100 text-teal-700 border border-teal-200 flex items-center gap-0.5">
                          <span className="material-symbols-outlined" style={{ fontSize: 10 }}>assignment_return</span>Return
                        </span>
                      )}
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
                      {s.trackingNumber && <TrackingNumber value={s.trackingNumber} size="sm" colorClass="text-slate-400" />}
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
                {(['overview', 'tracking', 'packages', 'logistics'] as const).map(tab => (
                  <button key={tab} onClick={() => { setDetailTab(tab); setShowTestTrackerMenu(false); }} className={`flex-1 py-3.5 text-[10px] font-black uppercase tracking-widest transition-all ${detailTab === tab ? 'text-primary border-b-2 border-primary bg-white/50' : 'text-slate-400 hover:text-slate-600'}`}>
                    {tab === 'overview' ? 'Overview' : tab === 'tracking' ? 'Tracking & Events' : tab === 'packages' ? 'Packages' : 'Logistics'}
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
                          <TrackingNumber value={selectedShip.trackingNumber} size="md" colorClass="text-slate-700" copyable />
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

                    {/* Handoff Method (Service Point / Pickup / Direct) — surfaced in Overview for at-a-glance operator visibility */}
                    {(() => {
                      const oSp = selectedShip.servicePoint;
                      const oPr = selectedShip.pickupRequest;
                      const oPrActive = oPr && PICKUP_CANCELLABLE_STATUSES.includes(oPr.status);
                      const method = oSp ? 'service_point' : oPrActive ? 'pickup' : 'direct';
                      const styleByMethod = {
                        service_point: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', label: 'text-emerald-600', icon: 'location_on', title: 'Service Point Drop-Off' },
                        pickup: { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700', label: 'text-sky-600', icon: 'local_shipping', title: 'Carrier Pickup Request' },
                        direct: { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-600', label: 'text-slate-500', icon: 'handshake', title: 'Direct Handoff (Default)' },
                      } as const;
                      const s = styleByMethod[method];
                      return (
                        <div className={`rounded-xl p-4 border ${s.bg} ${s.border} flex items-start justify-between gap-3`}>
                          <div className="flex items-start gap-3">
                            <span className={`material-symbols-outlined text-lg ${s.label} mt-0.5`}>{s.icon}</span>
                            <div>
                              <p className={`text-[10px] font-black uppercase tracking-widest ${s.label}`}>Handoff Method</p>
                              <p className={`text-sm font-black ${s.text} mt-0.5`}>{s.title}</p>
                              {method === 'service_point' && oSp && (
                                <p className="text-[11px] text-slate-600 mt-1">{oSp.name} · {oSp.address.city}, {oSp.address.state} {oSp.address.postalCode}</p>
                              )}
                              {method === 'pickup' && oPr && (
                                <p className="text-[11px] text-slate-600 mt-1">{oPr.requestedDate}{oPr.windowStart && oPr.windowEnd ? ` · ${oPr.windowStart}–${oPr.windowEnd}` : ''}{oPr.confirmationNumber ? ` · #${oPr.confirmationNumber}` : ''} · status: {oPr.status}</p>
                              )}
                              {method === 'direct' && (
                                <p className="text-[11px] text-slate-500 mt-1">No service point or carrier pickup configured. Use the Logistics tab to switch handoff method.</p>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setDetailTab('logistics')}
                            className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline shrink-0"
                          >Manage →</button>
                        </div>
                      );
                    })()}

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
                          <div className="flex-1 min-w-0">
                            {/* Phase 2.9.2 — render stage + code chips so QA
                                can see end-to-end whether the failure is a
                                pickup_create / pickup_lookup / pickup_buy
                                stage hit, instead of just a generic banner.
                                The "timeout-ui: 2.9.2" marker is a temporary
                                runtime proof flag (per Phase 2.9.2 spec) so
                                QA can confirm they are on the new code path
                                and not stale cached JS. */}
                            <div className="flex flex-wrap items-center gap-1 mb-1">
                              {providerError.code && (
                                <span className="inline-block px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[9px] font-bold uppercase tracking-wider">{providerError.code}</span>
                              )}
                              {providerError.stage && (
                                <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-bold uppercase tracking-wider">stage: {providerError.stage}</span>
                              )}
                              {providerError.httpStatus !== undefined && providerError.httpStatus !== 0 && (
                                <span className="inline-block px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-[9px] font-bold uppercase tracking-wider">HTTP {providerError.httpStatus}</span>
                              )}
                              {(
                                providerError.code === 'PICKUP_CREATE_TIMEOUT' ||
                                providerError.code === 'PICKUP_LOOKUP_TIMEOUT' ||
                                providerError.code === 'PICKUP_BUY_TIMEOUT' ||
                                providerError.code === 'SHIPMENT_CREATE_TIMEOUT' ||
                                providerError.code === 'LABEL_PURCHASE_TIMEOUT' ||
                                (providerError.stage && /pickup_|shipment_/.test(providerError.stage))
                              ) && (
                                <span className="inline-block px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[9px] font-bold uppercase tracking-wider" title="Phase 2.9.3 runtime proof marker — covers pickup_* and shipment_* stage timeouts">timeout-ui: 2.9.3</span>
                              )}
                            </div>
                            <p className="text-xs text-red-600 font-medium break-words">{providerError.message}</p>
                            {providerError.retryable && <p className="text-[10px] text-red-400 mt-0.5">This error may be temporary. You can retry.</p>}
                            {providerError.details && (
                              <details className="mt-1">
                                <summary className="text-[10px] text-red-500 cursor-pointer hover:text-red-700 select-none">Show diagnostic details</summary>
                                <pre className="mt-1 text-[10px] text-red-700 bg-red-100/60 rounded px-1.5 py-1 whitespace-pre-wrap break-words">{providerError.details}</pre>
                              </details>
                            )}
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

                      {selectedShip.originAddressValidation && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-400 font-bold">Origin Addr</span>
                          <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest ${
                            selectedShip.originAddressValidation.status === 'validated' ? 'bg-emerald-100 text-emerald-700' :
                            selectedShip.originAddressValidation.status === 'corrected' ? 'bg-blue-100 text-blue-700' :
                            selectedShip.originAddressValidation.status === 'failed' ? 'bg-red-100 text-red-700' :
                            'bg-slate-100 text-slate-500'
                          }`}>{selectedShip.originAddressValidation.status}</span>
                          {selectedShip.originAddressValidation.validatedAt && <span className="text-[10px] text-slate-400">{formatDateTime(selectedShip.originAddressValidation.validatedAt)}</span>}
                        </div>
                      )}
                      {selectedShip.addressValidation && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-400 font-bold">Dest Addr</span>
                          <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-widest ${
                            selectedShip.addressValidation.status === 'validated' ? 'bg-emerald-100 text-emerald-700' :
                            selectedShip.addressValidation.status === 'corrected' ? 'bg-blue-100 text-blue-700' :
                            selectedShip.addressValidation.status === 'failed' ? 'bg-red-100 text-red-700' :
                            'bg-slate-100 text-slate-500'
                          }`}>{selectedShip.addressValidation.status}</span>
                          {selectedShip.addressValidation.validatedAt && <span className="text-[10px] text-slate-400">{formatDateTime(selectedShip.addressValidation.validatedAt)}</span>}
                        </div>
                      )}

                      {(() => {
                        // Rate visibility gating: in provider mode, the selected shipping rate
                        // (carrier/service/price) is suppressed from view until BOTH origin and
                        // destination addresses are validated/accepted. Manual mode is unaffected.
                        const bothValidated = isOriginAddressAccepted(selectedShip) && isAddressAccepted(selectedShip);
                        if (selectedShip.selectedRate && (isManualMode || bothValidated)) {
                          return (
                            <div className="flex items-center gap-2 text-xs">
                              <span className="text-slate-400 font-bold">Service</span>
                              <span className="font-black text-slate-700">{selectedShip.selectedRate.carrier} {selectedShip.selectedRate.serviceName}</span>
                              <span className="font-black text-primary">${selectedShip.selectedRate.rate.toFixed(2)}</span>
                              {selectedShip.selectedRate.estimatedDays && <span className="text-slate-400">({selectedShip.selectedRate.estimatedDays}d)</span>}
                            </div>
                          );
                        }
                        if (selectedShip.selectedRate && !isManualMode && !bothValidated) {
                          const missing: string[] = [];
                          if (!isOriginAddressAccepted(selectedShip)) missing.push('origin');
                          if (!isAddressAccepted(selectedShip)) missing.push('destination');
                          return (
                            <div className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
                              <span className="material-symbols-outlined text-amber-600" style={{ fontSize: 14 }}>lock</span>
                              <span className="text-amber-700 font-semibold">
                                Rate hidden — validate {missing.join(' and ')} address{missing.length > 1 ? 'es' : ''} to view shipping rate.
                              </span>
                            </div>
                          );
                        }
                        return null;
                      })()}

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
                        {!isManualMode && canValidateAddress && !isWriteBlocked && isEditable(selectedShip.status) && !selectedShip.label && (() => {
                          // Phase 2.7 — explicit two-stage Check Address →
                          // Validate Address flow. Both buttons call the
                          // same underlying handler (`handleValidateAddresses`),
                          // because each call sends the address to the
                          // provider's verifier and accepts whatever status
                          // comes back ('validated' or 'corrected'). The
                          // distinction between Check and Validate is purely
                          // a UX clarity step:
                          //   • Check Address  — first pass on a fresh /
                          //                      stale / failed address.
                          //                      Result lands in 'corrected'
                          //                      or 'validated' or 'failed'.
                          //   • Validate Address — second pass that confirms
                          //                       a 'corrected' suggestion
                          //                       is actually a deliverable
                          //                       address. Only enabled when
                          //                       a side is currently
                          //                       'corrected'. Required to
                          //                       reach the 'validated'
                          //                       state that unlocks Get
                          //                       Rates.
                          // When BOTH sides are already 'validated' (and not
                          // stale), neither button is rendered — the address
                          // section already shows the validated badges.
                          const originState = getAddressReadinessForSide(selectedShip, 'origin');
                          const destState = getAddressReadinessForSide(selectedShip, 'destination');
                          const allValidated = originState === 'validated' && destState === 'validated';
                          if (allValidated) return null;
                          const anyCorrected = originState === 'corrected' || destState === 'corrected';
                          // Validate button is enabled when there's a
                          // 'corrected' side waiting to be confirmed AND
                          // no other side is in 'unchecked' / 'stale_after_edit'
                          // / 'failed' (those need Check first). If a side
                          // needs Check, we show Check; once Check produces
                          // a 'corrected' result, Validate replaces it.
                          const needsCheck = originState !== 'corrected' && originState !== 'validated'
                            ? true
                            : destState !== 'corrected' && destState !== 'validated';
                          const stage: 'check' | 'validate' = needsCheck ? 'check' : (anyCorrected ? 'validate' : 'check');
                          const buttonDisabled = providerLoading !== null || !activeProviderId;
                          const tooltip = !activeProviderId
                            ? 'No active shipping provider configured. Configure a provider in Shipping Center → Settings before checking addresses.'
                            : stage === 'check'
                              ? 'Step 1 of 2: Check Address. Sends both origin and destination to the provider verifier. The result will either be VALIDATED (ready) or CORRECTED (a suggested address is loaded — you must then run Validate Address to confirm).'
                              : 'Step 2 of 2: Validate Address. Re-runs the verifier on the corrected address loaded from the previous Check step. A successful response moves the address to VALIDATED, which unlocks Get Rates.';
                          const labelIdle = stage === 'check' ? 'Check Address' : 'Validate Address';
                          const labelLoading = stage === 'check' ? 'Checking...' : 'Validating...';
                          const icon = providerLoading === 'validate' ? 'hourglass_top' : !activeProviderId ? 'lock' : (stage === 'check' ? 'fact_check' : 'verified');
                          return (
                            <div className="relative group">
                              <button onClick={() => handleValidateAddresses(selectedShip.id)} disabled={buttonDisabled}
                                title={tooltip}
                                className={`px-3 py-2 bg-white border rounded-xl text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 ${stage === 'validate' ? 'text-emerald-700 border-emerald-300 hover:bg-emerald-50' : 'text-indigo-600 border-indigo-200 hover:bg-indigo-50'}`}>
                                <span className="material-symbols-outlined text-sm">{icon}</span>
                                {providerLoading === 'validate' ? labelLoading : labelIdle}
                                <span className="ml-1 px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider bg-slate-100 text-slate-500">{stage === 'check' ? '1/2' : '2/2'}</span>
                              </button>
                              {!activeProviderId && (
                                <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-10">
                                  <div className="bg-slate-800 text-white text-[10px] rounded-lg px-3 py-2 whitespace-nowrap shadow-lg">No active shipping provider configured.</div>
                                </div>
                              )}
                            </div>
                          );
                        })()}

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

                    {showRatesPanel && availableRates.length > 0 && (() => {
                      const ratesPanelManualMode = getShipmentMode(selectedShip) === 'manual';
                      const ratesPanelBothValidated = isOriginAddressAccepted(selectedShip) && isAddressAccepted(selectedShip);
                      if (!ratesPanelManualMode && !ratesPanelBothValidated) {
                        const missing = !isOriginAddressAccepted(selectedShip) && !isAddressAccepted(selectedShip)
                          ? 'origin and destination addresses'
                          : !isOriginAddressAccepted(selectedShip) ? 'origin address' : 'destination address';
                        return (
                          <div className="bg-amber-50/60 rounded-2xl p-4 border border-amber-200 flex items-center gap-2">
                            <span className="material-symbols-outlined text-amber-600 text-base">lock</span>
                            <p className="text-xs text-amber-700 font-semibold">
                              Available rates hidden — validate {missing} to view and select a shipping rate.
                            </p>
                          </div>
                        );
                      }
                      return null;
                    })()}
                    {showRatesPanel && availableRates.length > 0 && (getShipmentMode(selectedShip) === 'manual' || (isOriginAddressAccepted(selectedShip) && isAddressAccepted(selectedShip))) && (
                      <div className="bg-sky-50/50 rounded-2xl p-5 border border-sky-100 space-y-3">
                        <div className="flex justify-between items-center">
                          <p className="text-[10px] font-black text-sky-600 uppercase tracking-widest flex items-center gap-1"><span className="material-symbols-outlined text-xs">local_offer</span>Available Rates</p>
                          <button onClick={() => setShowRatesPanel(false)} className="text-slate-400 hover:text-slate-600"><span className="material-symbols-outlined text-sm">close</span></button>
                        </div>
                        <div className="space-y-2">
                          {availableRates.map(rate => {
                            // Phase 2.7 — pickup forecast badge per rate row.
                            // This is intentionally rendered inline so the
                            // operator can compare cost against pickup
                            // readiness in one glance. Forecast is NEVER
                            // presented as a final pickup eligibility — see
                            // help text below.
                            const forecast = getPickupForecastForRate(rate);
                            const tone = forecast.state === 'likely'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : forecast.state === 'final_check'
                                ? 'bg-sky-50 text-sky-700 border-sky-200'
                                : forecast.state === 'setup_required'
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : forecast.state === 'not_capable'
                                    ? 'bg-rose-50 text-rose-700 border-rose-200'
                                    : 'bg-slate-50 text-slate-600 border-slate-200';
                            const icon = forecast.state === 'likely' ? 'check_circle'
                              : forecast.state === 'final_check' ? 'pending'
                              : forecast.state === 'setup_required' ? 'settings'
                              : forecast.state === 'not_capable' ? 'block'
                              : 'help';
                            // Phase 2.8 — orthogonal pickup fee class chip
                            // rendered next to the forecast badge. NO
                            // dollar amounts here (Phase 2.8 scope) —
                            // exact fees come from pickup.create at
                            // booking time (Phase 2.9, not yet wired).
                            const fee = getPickupFeeClassForRate(rate, forecast.state);
                            const feeTone = fee.state === 'pickup_may_be_free'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : fee.state === 'pickup_fee_likely'
                                ? 'bg-amber-50 text-amber-800 border-amber-200'
                                : fee.state === 'fee_depends_on_account'
                                  ? 'bg-sky-50 text-sky-700 border-sky-200'
                                  : fee.state === 'not_applicable'
                                    ? 'bg-slate-50 text-slate-500 border-slate-200'
                                    : 'bg-slate-50 text-slate-600 border-slate-200';
                            const feeIcon = fee.state === 'pickup_may_be_free' ? 'savings'
                              : fee.state === 'pickup_fee_likely' ? 'payments'
                              : fee.state === 'fee_depends_on_account' ? 'account_balance_wallet'
                              : fee.state === 'not_applicable' ? 'remove'
                              : 'help';
                            return (
                              <div key={rate.id} className="flex items-center justify-between bg-white rounded-xl p-3 border border-sky-100 hover:border-primary/30 transition-all">
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-black text-slate-700">{rate.carrier} — {rate.serviceName}</p>
                                  <p className="text-[10px] text-slate-400">
                                    {rate.estimatedDays ? `${rate.estimatedDays} day${rate.estimatedDays !== 1 ? 's' : ''}` : 'Delivery estimate N/A'}
                                    {rate.isGuaranteed && ' · Guaranteed'}
                                  </p>
                                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                                    <span title={forecast.detail}
                                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider ${tone}`}>
                                      <span className="material-symbols-outlined" style={{ fontSize: 11 }}>{icon}</span>
                                      Pickup: {forecast.label}
                                    </span>
                                    <span title={fee.detail}
                                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider ${feeTone}`}>
                                      <span className="material-symbols-outlined" style={{ fontSize: 11 }}>{feeIcon}</span>
                                      {fee.label}
                                    </span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3 ml-3">
                                  <span className="text-sm font-black text-primary">${rate.rate.toFixed(2)}</span>
                                  {!isWriteBlocked && (
                                    <button onClick={() => handleSelectRate(selectedShip.id, rate)}
                                      className="px-3 py-1.5 bg-primary text-white rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-primary/90 transition-all">
                                      Select
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <p className="text-[10px] text-slate-500 leading-relaxed border-t border-sky-100 pt-2">
                          <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 11 }}>info</span>
                          <span className="font-bold">Pickup forecast</span> and <span className="font-bold">fee class</span> are estimates based on carrier, service, and provider setup. <span className="font-bold">Final pickup eligibility AND the exact pickup fee (if any) are confirmed when the carrier pickup request is created.</span> A "final check" forecast does not imply failure — it means cutoffs/lead-times for that carrier determine whether the chosen pickup window will return a bookable rate. "Pickup may be free", "Pickup fee likely", and "Fee depends on account" are class-level signals only — no dollar amount is implied at this stage.
                        </p>
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
                    {canAccess('returns') && checkSubPermission('create_return') && selectedShip.status === 'Delivered' && !selectedShip.returnInfo?.isReturn && (
                      <button onClick={() => {
                        const customer = customers.find(c =>
                          c.name === selectedShip.destinationAddress.name ||
                          c.email === selectedShip.destinationAddress.email
                        );
                        const prefill: ReturnPrefill = {
                          sourceType: 'shipment',
                          sourceId: selectedShip.id,
                          sourceNumber: selectedShip.shipmentNumber,
                          customerId: customer?.id || '',
                          customerName: customer?.name || selectedShip.destinationAddress.name,
                          customerEmail: customer?.email || selectedShip.destinationAddress.email,
                          customerPhone: customer?.phone || selectedShip.destinationAddress.phone,
                          originalShipmentId: selectedShip.id,
                          items: selectedShip.packages.map(pkg => ({
                            name: pkg.contentsSummary || 'Package contents',
                            quantity: 1,
                          })),
                        };
                        navigate('/returns', { state: { openCreate: true, prefill } });
                      }}
                        className="px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest bg-teal-50 text-teal-600 border border-teal-200 hover:bg-teal-100 transition-all active:scale-95 flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-sm">assignment_return</span>
                        Initiate Return
                      </button>
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

                {detailTab === 'logistics' && (() => {
                  const caps = getProviderCapabilities(selectedShip);
                  const sp = selectedShip.servicePoint;
                  const pr = selectedShip.pickupRequest;
                  const prActive = pr && PICKUP_CANCELLABLE_STATUSES.includes(pr.status);
                  const prTerminated = pr && ['cancelled', 'failed', 'rejected'].includes(pr.status);
                  const spElig = getServicePointEligibility(selectedShip);
                  const spManualElig = getServicePointManualEntryEligibility(selectedShip);
                  const puElig = getPickupEligibility(selectedShip);
                  // ─── Pickup gating split into two distinct concepts ───────
                  // Feature availability: is the carrier-pickup workflow
                  // allowed for this shipment at all (plan, permission,
                  // provider, lifecycle, mutex). When this is false the
                  // workflow is genuinely unavailable and we render the
                  // "not available" banner.
                  // Submit readiness: are all required booking inputs filled
                  // in (verified pickup address + per-provider required
                  // fields). When this fails the form MUST stay visible so
                  // the operator can fill the inputs — only the submit
                  // button is disabled. Mixing the two previously created
                  // a deadlock where required-but-empty inputs hid the
                  // very form needed to fill them in.
                  const PU_FORM_READINESS_CATS = new Set(['pickup_address', 'pickup_address_unverified', 'pickup_payload', 'pickup_address_ineligible']);
                  const pickupFeatureAvailable = puElig.eligible || (puElig.category != null && PU_FORM_READINESS_CATS.has(puElig.category));
                  const pickupSubmitReady = puElig.eligible;
                  // Selection is editable if EITHER the live locator path OR the manual
                  // entry path is eligible. While no carrier-specific locator adapter is
                  // configured, manual entry is the only path available.
                  const spEditable = spElig.eligible || spManualElig.eligible;
                  // `pickupRequestable` now controls form *visibility* (feature
                  // available). Submit is gated separately by `pickupSubmitReady`.
                  const pickupRequestable = pickupFeatureAvailable;
                  const pickupCancellable = pr && PICKUP_CANCELLABLE_STATUSES.includes(pr.status);
                  return (
                  <div className="space-y-6">
                    {/* Handoff method banner */}
                    <div className="bg-gradient-to-r from-slate-50 to-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between">
                      <div>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Handoff Method</p>
                        <p className="text-sm font-black text-slate-800 mt-1">
                          {sp ? 'Service Point Drop-Off' : prActive ? 'Carrier Pickup Request' : 'Direct Handoff (Default)'}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">A shipment uses one handoff method at a time — selecting a service point clears any active pickup, and vice versa.</p>
                      </div>
                      <span className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest ${
                        sp ? 'bg-emerald-100 text-emerald-700' :
                        prActive ? 'bg-sky-100 text-sky-700' :
                        'bg-slate-100 text-slate-500'
                      }`}>
                        {sp ? 'Drop-Off' : prActive ? `Pickup ${pr!.status}` : 'Direct'}
                      </span>
                    </div>

                    {/* Service Point panel */}
                    <div className="bg-white rounded-2xl border border-slate-200 p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div>
                          <p className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1.5"><span className="material-symbols-outlined text-sm">location_on</span>Service Point / Drop-Off</p>
                          <p className="text-xs text-slate-500 mt-1">Carrier-operated drop-off location for parcel handoff.</p>
                        </div>
                        <span className={`px-2 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest ${sp ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{sp ? 'Selected' : 'None'}</span>
                      </div>
                      {!sp && !spManualElig.eligible && (() => {
                        const elig = spManualElig;
                        const tone = elig.category === 'mutex'
                          ? { bg: 'bg-sky-50', border: 'border-sky-200', icon: 'text-sky-500', text: 'text-sky-700', label: 'Service point selection blocked' }
                          : elig.category === 'lifecycle'
                          ? { bg: 'bg-slate-50', border: 'border-slate-200', icon: 'text-slate-500', text: 'text-slate-600', label: 'Service point not yet available' }
                          : elig.category === 'permission'
                          ? { bg: 'bg-rose-50', border: 'border-rose-200', icon: 'text-rose-500', text: 'text-rose-700', label: 'Service point selection denied' }
                          : { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'text-amber-500', text: 'text-amber-700', label: elig.category === 'plan' ? 'Service points disabled by plan' : 'Service points not available for this shipment' };
                        return (
                          <div className={`${tone.bg} border ${tone.border} rounded-xl p-3 flex items-start gap-2`}>
                            <span className={`material-symbols-outlined ${tone.icon} text-sm mt-0.5`}>lock</span>
                            <div className={`text-xs ${tone.text}`}>
                              <p className="font-black">{tone.label}</p>
                              <p className="mt-0.5">{elig.reason}</p>
                            </div>
                          </div>
                        );
                      })()}
                      {!sp && spManualElig.eligible && !spElig.eligible && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
                          <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">info</span>
                          <div className="text-xs text-amber-700">
                            <p className="font-black">Live carrier locator unavailable</p>
                            <p className="mt-0.5">No carrier-specific locator adapter is configured (USPS / UPS / FedEx). Use the <span className="font-bold">Select Service Point</span> button to record a service-point reference manually. Configure live lookup under <span className="font-bold">Settings → Carrier Locators</span>.</p>
                          </div>
                        </div>
                      )}
                      {sp && (
                        <div className="bg-emerald-50/50 border border-emerald-200 rounded-xl p-4 space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-black text-slate-800 flex items-center gap-2">
                                {sp.name}
                                {sp.source === 'manual' && <span className="text-[9px] font-black text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded uppercase tracking-widest">Manual</span>}
                                {sp.source === 'live_locator' && <span className="text-[9px] font-black text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded uppercase tracking-widest">Live</span>}
                              </p>
                              <p className="text-[10px] text-slate-500 mt-0.5 font-mono">{sp.id} · {sp.carrier}{sp.type ? ` · ${sp.type.replace('_', ' ')}` : ''}</p>
                            </div>
                            {sp.distanceKm !== undefined && <span className="text-[10px] font-black text-emerald-700 bg-emerald-100 px-2 py-1 rounded-lg">{sp.distanceKm} km</span>}
                          </div>
                          <p className="text-xs text-slate-600">{sp.address.line1}, {sp.address.city}, {sp.address.state} {sp.address.postalCode}</p>
                          {sp.contactPhone && <p className="text-[11px] text-slate-500">Phone: <span className="font-mono">{sp.contactPhone}</span></p>}
                          {sp.selectionNotes && <p className="text-[11px] text-slate-500 italic">Notes: {sp.selectionNotes}</p>}
                          {sp.selectedAt && <p className="text-[10px] text-slate-400">Selected by {sp.selectedBy || 'operator'} at {formatDateTime(sp.selectedAt)}</p>}
                        </div>
                      )}
                      {(spEditable || sp) && (
                        <div className="flex gap-2 mt-4">
                          {spEditable && !isWriteBlocked && (
                            <button onClick={() => openServicePointModal(selectedShip.id)} className="px-4 py-2.5 bg-primary/10 text-primary font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-primary/20 transition-all">
                              {sp ? 'Change Service Point' : 'Select Service Point'}
                            </button>
                          )}
                          {sp && canSelectServicePoint && !isWriteBlocked && (
                            <button onClick={() => handleClearServicePoint(selectedShip.id)} className="px-4 py-2.5 bg-slate-100 text-slate-600 font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-slate-200 transition-all">Clear</button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Pickup Request panel */}
                    <div className="bg-white rounded-2xl border border-slate-200 p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div>
                          <p className="text-[10px] font-black text-primary uppercase tracking-widest flex items-center gap-1.5"><span className="material-symbols-outlined text-sm">local_shipping</span>Carrier Pickup Request</p>
                          <p className="text-xs text-slate-500 mt-1">Schedule the carrier to pick up the parcel from the origin address.</p>
                          {(() => {
                            const audit = activeProviderId ? PROVIDER_CAPABILITIES[activeProviderId.toLowerCase()] : null;
                            if (!audit) return null;
                            return (
                              <div className="mt-2 space-y-1">
                                <div className="flex flex-wrap gap-1">
                                  <span className={`text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest ${audit.supportsLivePickupBooking ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                                    {audit.supportsLivePickupBooking ? 'Live booking wired' : 'Local-only (capability-gated)'}
                                  </span>
                                  {audit.pickupNeedsRatePurchase && <span className="text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest bg-sky-100 text-sky-700">Rate purchase</span>}
                                  {audit.pickupNeedsProviderShipmentId && <span className="text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest bg-violet-100 text-violet-700">Needs label first</span>}
                                  {audit.pickupNeedsCarrierAccount && <span className="text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-widest bg-orange-100 text-orange-700">Carrier account</span>}
                                </div>
                                {audit.pickupCarrierCoverage.length > 0 && (
                                  <p className="text-[10px] text-slate-500"><span className="font-black uppercase tracking-widest mr-1">Coverage:</span>{audit.pickupCarrierCoverage.join(', ')}</p>
                                )}
                                <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                                  <span className="font-black uppercase tracking-widest mr-1">Provider note ({activeProviderId}):</span>
                                  {audit.pickupAuditNote}
                                </p>
                                {audit.pickupTestModeLimitations && (
                                  <p className="text-[10px] text-slate-500 italic">Test-mode: {audit.pickupTestModeLimitations}</p>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                        <span className={`px-2 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest ${
                          !pr ? 'bg-slate-100 text-slate-500' :
                          pr.status === 'confirmed' || pr.status === 'scheduled' ? 'bg-emerald-100 text-emerald-700' :
                          pr.status === 'requested' ? 'bg-sky-100 text-sky-700' :
                          pr.status === 'completed' ? 'bg-violet-100 text-violet-700' :
                          pr.status === 'partial_failed' ? 'bg-amber-100 text-amber-800' :
                          'bg-rose-100 text-rose-700'
                        }`}>{pr ? (pr.status === 'partial_failed' ? 'Booking Failed' : pr.status) : 'Not Requested'}</span>
                      </div>
                      {/* "Not available" banner is reserved for TRUE feature
                          blockers only (plan, permission, provider, lifecycle,
                          mutex). Form-readiness issues (pickup_address,
                          pickup_address_unverified, pickup_payload) are
                          surfaced inline beside the form so the operator can
                          actually act on them — they no longer hide the
                          form. */}
                      {!pickupFeatureAvailable && !pr && (() => {
                        const tone = puElig.category === 'mutex'
                          ? { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'text-emerald-600', text: 'text-emerald-700', label: 'Carrier pickup blocked' }
                          : puElig.category === 'lifecycle'
                          ? { bg: 'bg-slate-50', border: 'border-slate-200', icon: 'text-slate-500', text: 'text-slate-600', label: 'Carrier pickup not yet available' }
                          : puElig.category === 'permission'
                          ? { bg: 'bg-rose-50', border: 'border-rose-200', icon: 'text-rose-500', text: 'text-rose-700', label: 'Carrier pickup denied' }
                          : { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'text-amber-500', text: 'text-amber-700', label: puElig.category === 'plan' ? 'Carrier pickup disabled by plan' : 'Carrier pickup not available for this shipment' };
                        return (
                          <div className={`${tone.bg} border ${tone.border} rounded-xl p-3 flex items-start gap-2`}>
                            <span className={`material-symbols-outlined ${tone.icon} text-sm mt-0.5`}>lock</span>
                            <div className={`text-xs ${tone.text}`}>
                              <p className="font-black">{tone.label}</p>
                              <p className="mt-0.5">{puElig.reason}</p>
                            </div>
                          </div>
                        );
                      })()}
                      {/* Inline guidance shown ABOVE the form when the
                          feature is available but submit is not yet ready.
                          The form below remains visible and fillable.
                          Phase 2.5.9: messaging is now state-specific so a
                          pickup-ineligible address is NEVER described as a
                          "missing fields" problem (which would contradict
                          the READY required-fields panel). The four
                          form-readiness categories each get their own
                          headline + recovery hint. */}
                      {pickupFeatureAvailable && !pickupSubmitReady && !pr && (() => {
                        const cat = puElig.category;
                        const isIneligible = cat === 'pickup_address_ineligible';
                        const isUnverified = cat === 'pickup_address_unverified';
                        const isMissingFields = cat === 'pickup_address' || cat === 'pickup_payload';
                        const tone = isIneligible
                          ? { bg: 'bg-rose-50', border: 'border-rose-200', icon: 'block', iconColor: 'text-rose-600', title: 'text-rose-800', body: 'text-rose-700' }
                          : isUnverified
                          ? { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'fact_check', iconColor: 'text-amber-600', title: 'text-amber-800', body: 'text-amber-700' }
                          : { bg: 'bg-sky-50', border: 'border-sky-200', icon: 'info', iconColor: 'text-sky-600', title: 'text-sky-800', body: 'text-sky-700' };
                        const headline = isIneligible
                          ? 'This address is deliverable, but the carrier has not accepted it for pickup booking.'
                          : isUnverified
                          ? 'Run delivery verification on the pickup address before booking.'
                          : isMissingFields
                          ? 'Complete the required pickup booking fields below to continue.'
                          : 'Resolve the remaining blocker below to continue.';
                        const subline = isIneligible
                          ? (selectedShip.label
                              ? 'Label is already purchased — the printed from-address is locked. Use a pickup-only dispatch override below (e.g. correct suite/dock or a different unit on the same property), then re-verify before retrying. The same unchanged address will be rejected again.'
                              : 'Edit the pickup street/city/state/ZIP or the contact name and phone, then re-run delivery verification before retrying. The same unchanged address will be rejected again.')
                          : puElig.reason;
                        return (
                          <div className={`${tone.bg} border ${tone.border} rounded-xl p-3 flex items-start gap-2`}>
                            <span className={`material-symbols-outlined ${tone.iconColor} text-sm mt-0.5`}>{tone.icon}</span>
                            <div className={`text-xs ${tone.title} flex-1 min-w-0`}>
                              <p className="font-black">{headline}</p>
                              <p className={`mt-0.5 ${tone.body}`}>{subline}</p>
                              {isIneligible && (
                                <>
                                  <p className={`mt-1 text-[10px] ${tone.body} italic`}>All required booking fields are present. The remaining blocker is carrier rejection of the current pickup address — not missing form data.</p>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {selectedShip.label ? (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          beginPickupOverride(selectedShip.id);
                                          setTimeout(() => {
                                            const el = document.getElementById('pickup-override-editor');
                                            if (el) {
                                              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                              const focusable = el.querySelector('input, textarea') as HTMLElement | null;
                                              focusable?.focus();
                                            }
                                          }, 50);
                                        }}
                                        className="px-2.5 py-1 rounded text-[10px] font-black uppercase tracking-widest bg-white border border-rose-300 text-rose-700 hover:bg-rose-50 inline-flex items-center gap-1"
                                      >
                                        <span className="material-symbols-outlined text-[12px]">edit_location</span>
                                        {selectedShip.pickupOverrideAddress ? 'Edit pickup dispatch override' : 'Use pickup-only dispatch address'}
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => setEditingShipment(selectedShip.id)}
                                        className="px-2.5 py-1 rounded text-[10px] font-black uppercase tracking-widest bg-white border border-rose-300 text-rose-700 hover:bg-rose-50 inline-flex items-center gap-1"
                                      >
                                        <span className="material-symbols-outlined text-[12px]">edit_location</span>
                                        Edit origin address
                                      </button>
                                    )}
                                    <a
                                      href="#pickup-contact-fields"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        const el = document.getElementById('pickup-contact-fields');
                                        if (el) {
                                          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                          const focusable = el.querySelector('input, textarea') as HTMLElement | null;
                                          focusable?.focus();
                                        }
                                      }}
                                      className="px-2.5 py-1 rounded text-[10px] font-black uppercase tracking-widest bg-white border border-rose-300 text-rose-700 hover:bg-rose-50 inline-flex items-center gap-1"
                                    >
                                      <span className="material-symbols-outlined text-[12px]">contact_phone</span>
                                      Edit pickup contact
                                    </a>
                                    <a
                                      href="#delivery-verify-action"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        const el = document.getElementById('delivery-verify-action');
                                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                      }}
                                      className="px-2.5 py-1 rounded text-[10px] font-black uppercase tracking-widest bg-white border border-rose-300 text-rose-700 hover:bg-rose-50 inline-flex items-center gap-1"
                                    >
                                      <span className="material-symbols-outlined text-[12px]">restart_alt</span>
                                      Re-verify after edit
                                    </a>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                      {/* Pickup-address source-of-truth banner + true carrier
                          verification panel. Shown whenever pickup is the
                          active option (no service point selected, no active
                          pickup) and the only remaining blockers (if any) are
                          address-related. This is the operator's primary
                          surface for understanding (a) which address pickup
                          will use, (b) whether all required fields are
                          present, and (c) whether the carrier has actually
                          verified that address. EasyPost address verification
                          is carrier-agnostic and applies to USPS, UPS, FedEx
                          and any other supported pickup carrier. */}
                      {!pr && !sp && pickupFeatureAvailable && (() => {
                        const resolved = resolvePickupAddress(selectedShip);
                        const check = validatePickupAddress(resolved.address);
                        const fields: { label: string; ok: boolean }[] = [
                          { label: 'Street (line 1)', ok: !!(resolved.address.line1 || '').trim() },
                          { label: 'City', ok: !!(resolved.address.city || '').trim() },
                          { label: 'State / region', ok: !!(resolved.address.state || '').trim() },
                          { label: 'Postal / ZIP', ok: !!(resolved.address.postalCode || '').trim() },
                          { label: 'Country', ok: !!(resolved.address.country || '').trim() },
                          { label: 'Contact name or company', ok: !!((resolved.address.name || '').trim() || (resolved.address.company || '').trim()) },
                          { label: 'Phone', ok: !!(resolved.address.phone && resolved.address.phone.replace(/\D/g, '').length >= 10) },
                        ];
                        const allFieldsOk = fields.every(f => f.ok);
                        const verify = getPickupVerificationStatus(selectedShip);
                        const elig = getPickupEligibilityState(selectedShip);
                        // Phase 2.5.8 — Delivery verification badge. Wording is
                        // strictly "Delivery verified" (not "Verified by
                        // carrier") because EasyPost's create_and_verify only
                        // proves the address is deliverable; pickup booking is
                        // a separate, stricter acceptance bar (see eligibility
                        // chip below).
                        const vBadge = verify.status === 'verified' || verify.status === 'corrected_accepted'
                          ? { bg: 'bg-emerald-100', text: 'text-emerald-700', icon: 'mark_email_read', label: verify.status === 'corrected_accepted' ? 'Delivery verified (corrected)' : 'Delivery verified' }
                          : verify.status === 'verifying'
                          ? { bg: 'bg-sky-100', text: 'text-sky-700', icon: 'sync', label: 'Verifying delivery…' }
                          : verify.status === 'corrected_pending'
                          ? { bg: 'bg-amber-100', text: 'text-amber-700', icon: 'rule', label: 'Delivery corrected — review' }
                          : verify.status === 'failed'
                          ? { bg: 'bg-rose-100', text: 'text-rose-700', icon: 'error', label: 'Delivery verification failed' }
                          : verify.status === 'stale'
                          ? { bg: 'bg-amber-100', text: 'text-amber-700', icon: 'autorenew', label: 'Re-verify delivery (address changed)' }
                          : { bg: 'bg-slate-100', text: 'text-slate-600', icon: 'pending', label: 'Delivery not verified' };
                        // Phase 2.5.8 — Pickup-eligibility chip. Distinct from
                        // delivery verification. Status is derived from real
                        // pickup_create outcomes recorded against the address
                        // fingerprint — it does NOT inherit from delivery
                        // verification success.
                        const eBadge = elig.status === 'confirmed'
                          ? { bg: 'bg-emerald-100', text: 'text-emerald-700', icon: 'local_shipping', label: 'Pickup eligibility: confirmed' }
                          : elig.status === 'failed'
                          ? { bg: 'bg-rose-100', text: 'text-rose-700', icon: 'block', label: 'Pickup ineligible for this address' }
                          : { bg: 'bg-slate-100', text: 'text-slate-600', icon: 'help', label: 'Pickup eligibility: not yet attempted' };
                        const overallOk = allFieldsOk && (verify.status === 'verified' || verify.status === 'corrected_accepted') && elig.status !== 'failed';
                        const tone = overallOk
                          ? { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700', titleColor: 'text-sky-800' }
                          : verify.status === 'failed'
                          ? { bg: 'bg-rose-50', border: 'border-rose-200', text: 'text-rose-700', titleColor: 'text-rose-800' }
                          : { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', titleColor: 'text-amber-800' };
                        const canVerify = allFieldsOk && !pickupVerifying[selectedShip.id] && verify.status !== 'verifying';
                        const verifyButtonLabel = verify.status === 'verified' || verify.status === 'corrected_accepted'
                          ? 'Re-verify'
                          : verify.status === 'stale' ? 'Re-verify pickup address'
                          : verify.status === 'verifying' ? 'Verifying…'
                          : 'Verify pickup address';
                        return (
                          <div className={`${tone.bg} border ${tone.border} rounded-xl p-3 space-y-2`}>
                            <div className="flex items-start gap-2">
                              <span className={`material-symbols-outlined text-sm mt-0.5 ${overallOk ? 'text-sky-500' : verify.status === 'failed' ? 'text-rose-500' : 'text-amber-500'}`}>{overallOk ? 'verified_user' : 'fact_check'}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <p className={`text-[11px] font-black ${tone.titleColor}`}>Pickup address source: {resolved.sourceLabel}</p>
                                    {/* Phase 2.5.8-sync runtime build marker. Proves the
                                        running bundle includes the delivery-vs-pickup-eligibility
                                        split. Remove once QA has confirmed the new behavior. */}
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-black bg-violet-100 text-violet-700 border border-violet-200" title="Runtime build marker — Phase 2.5.8-sync: delivery verification and pickup eligibility are independent.">build: 2.5.8-sync</span>
                                  </div>
                                  <div className="flex items-center gap-1 flex-wrap">
                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black ${vBadge.bg} ${vBadge.text}`}>
                                      <span className={`material-symbols-outlined text-[12px] ${verify.status === 'verifying' ? 'animate-spin' : ''}`}>{vBadge.icon}</span>
                                      {vBadge.label}
                                    </span>
                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black ${eBadge.bg} ${eBadge.text}`}>
                                      <span className="material-symbols-outlined text-[12px]">{eBadge.icon}</span>
                                      {eBadge.label}
                                    </span>
                                  </div>
                                </div>
                                <p className={`text-[11px] ${tone.text} mt-0.5`}>
                                  Two separate checks: <span className="font-black">delivery verification</span> proves mail can reach this address; <span className="font-black">pickup eligibility</span> proves the carrier will actually accept it for a scheduled pickup. EasyPost / USPS expose no separate pickup-eligibility endpoint, so the only true proof is the result of <span className="font-mono">pickup_create</span> itself. {overallOk ? 'Delivery is verified and the carrier has not yet rejected this address for pickup — submit to attempt the booking.' : verify.status !== 'verified' && verify.status !== 'corrected_accepted' ? 'Run delivery verification first, then submit to test pickup eligibility.' : elig.status === 'failed' ? 'Delivery is verified but pickup_create has already been rejected for this exact address. Edit the address and re-verify before retrying.' : 'Address fields are missing — complete them, run delivery verification, then submit to test pickup eligibility.'}
                                </p>
                                <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
                                  {fields.map((f, i) => (
                                    <li key={i} className={`text-[10px] flex items-center gap-1.5 ${f.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
                                      <span className={`material-symbols-outlined text-[12px] ${f.ok ? 'text-emerald-500' : 'text-rose-500'}`}>{f.ok ? 'check_circle' : 'cancel'}</span>
                                      <span>{f.label}</span>
                                    </li>
                                  ))}
                                </ul>
                                {check.warnings.length > 0 && (
                                  <p className="text-[10px] text-amber-700 mt-1 italic">Note: {check.warnings.join('; ')}</p>
                                )}
                              </div>
                            </div>
                            {/* Verification controls + state details. Carrier-agnostic; works for any EasyPost-supported pickup carrier. */}
                            <div className="border-t border-slate-200/60 pt-2 space-y-2">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <div className="text-[10px] text-slate-600">
                                  <span className="font-black uppercase tracking-widest text-slate-500">Carrier verification</span>
                                  {verify.record?.verifiedAt && (
                                    <span className="ml-2 text-slate-400">last run: {formatDateTime(verify.record.verifiedAt)}{verify.record.providerRef ? ` · ref ${verify.record.providerRef.slice(0, 10)}…` : ''}</span>
                                  )}
                                </div>
                                {!isWriteBlocked && (
                                  <button
                                    id="delivery-verify-action"
                                    type="button"
                                    onClick={() => verifyPickupAddressFor(selectedShip.id)}
                                    disabled={!canVerify}
                                    className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition ${canVerify ? 'bg-primary text-white hover:opacity-90' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}`}
                                  >{verifyButtonLabel}</button>
                                )}
                              </div>
                              {verify.status === 'corrected_pending' && verify.record?.suggestedAddress && (
                                <div className="bg-white border border-amber-200 rounded-lg p-2 space-y-2">
                                  <p className="text-[10px] font-black text-amber-800 uppercase tracking-wider">Carrier returned a corrected address — review</p>
                                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                                    <div>
                                      <p className="font-black text-slate-500 uppercase tracking-wider mb-0.5">You sent</p>
                                      <p className="text-slate-700">{resolved.address.line1}{resolved.address.line2 ? `, ${resolved.address.line2}` : ''}</p>
                                      <p className="text-slate-700">{resolved.address.city}, {resolved.address.state} {resolved.address.postalCode}</p>
                                    </div>
                                    <div>
                                      <p className="font-black text-emerald-600 uppercase tracking-wider mb-0.5">Carrier suggests</p>
                                      <p className="text-emerald-800">{verify.record.suggestedAddress.line1}{verify.record.suggestedAddress.line2 ? `, ${verify.record.suggestedAddress.line2}` : ''}</p>
                                      <p className="text-emerald-800">{verify.record.suggestedAddress.city}, {verify.record.suggestedAddress.state} {verify.record.suggestedAddress.postalCode}</p>
                                    </div>
                                  </div>
                                  {verify.record.messages.length > 0 && (
                                    <ul className="text-[10px] text-slate-600 list-disc list-inside">
                                      {verify.record.messages.map((m, i) => <li key={i}>{m}</li>)}
                                    </ul>
                                  )}
                                  {!isWriteBlocked && (
                                    <div className="flex gap-2">
                                      <button type="button" onClick={() => acceptCorrectedPickupAddress(selectedShip.id)} className="px-2 py-1 rounded text-[10px] font-black uppercase tracking-widest bg-emerald-600 text-white hover:bg-emerald-700">Accept corrected address</button>
                                      <button type="button" onClick={() => setEditingShipment(selectedShip.id)} className="px-2 py-1 rounded text-[10px] font-black uppercase tracking-widest bg-white border border-slate-300 text-slate-700 hover:bg-slate-50">Edit origin instead</button>
                                    </div>
                                  )}
                                </div>
                              )}
                              {verify.status === 'failed' && verify.record && (
                                <div className="bg-white border border-rose-200 rounded-lg p-2">
                                  <p className="text-[10px] font-black text-rose-800 uppercase tracking-wider mb-1">Carrier rejected the pickup address</p>
                                  {verify.record.errorMessage && <p className="text-[10px] text-rose-700">{verify.record.errorMessage}</p>}
                                  {verify.record.messages.length > 0 && (
                                    <ul className="text-[10px] text-rose-700 list-disc list-inside mt-1">
                                      {verify.record.messages.map((m, i) => <li key={i}>{m}</li>)}
                                    </ul>
                                  )}
                                  <p className="text-[10px] text-slate-500 mt-1 italic">Common causes: street/ZIP mismatch, missing apartment/suite, invalid state for ZIP. Edit the origin and re-verify.</p>
                                </div>
                              )}
                              {verify.status === 'stale' && (
                                <p className="text-[10px] text-amber-700 italic">The pickup address was edited after the last verification. Re-verify before requesting pickup.</p>
                              )}
                              {verify.status === 'unverified' && allFieldsOk && (
                                <p className="text-[10px] text-slate-600 italic">Verification has not run yet. Click <span className="font-black">Verify pickup address</span> to ask the carrier to validate this address before booking pickup.</p>
                              )}
                              {/* Phase 2.5.8 — pickup ineligibility explanation. Shown when
                                  delivery verification passed (or any other state) but
                                  pickup_create has already failed for this exact address.
                                  Makes the delivery-vs-pickup distinction explicit instead
                                  of forcing the operator to infer it from raw diagnostics. */}
                              {elig.status === 'failed' && elig.record && (
                                <div className="bg-white border border-rose-200 rounded-lg p-2">
                                  <p className="text-[10px] font-black text-rose-800 uppercase tracking-wider mb-1">Pickup ineligible for this address</p>
                                  <p className="text-[11px] text-rose-700">
                                    {verify.status === 'verified' || verify.status === 'corrected_accepted'
                                      ? 'This address is deliverable, but the carrier has not accepted it for pickup booking.'
                                      : 'Pickup booking has already been rejected for this exact address.'}
                                    {' '}Edit the address (or contact info) and re-verify before retrying — submitting again with the same payload will fail again.
                                  </p>
                                  {(elig.record.providerCode || elig.record.httpStatus) && (
                                    <p className="text-[10px] text-rose-600 mt-1 font-mono">
                                      {elig.record.providerCode && <span className="mr-2">code: <span className="font-black">{elig.record.providerCode}</span></span>}
                                      {elig.record.httpStatus && <span className="mr-2">HTTP <span className="font-black">{elig.record.httpStatus}</span></span>}
                                      <span className="text-rose-500">last attempt: {formatDateTime(elig.record.attemptedAt)}</span>
                                    </p>
                                  )}
                                  {elig.record.message && (
                                    <p className="text-[10px] text-rose-700 mt-1 italic">Carrier said: {elig.record.message}</p>
                                  )}
                                </div>
                              )}
                              {/* Audit detail — what was sent to the verification call,
                                  what the carrier returned, and what would be sent to
                                  pickup_create. Always visible once a verification has run
                                  so the operator can confirm the displayed "verified" state
                                  matches the address that will actually be booked. */}
                              {verify.record && verify.record.submittedAddress && (
                                <details className="bg-white border border-slate-200 rounded-lg p-2">
                                  <summary className="cursor-pointer text-[10px] font-black text-slate-600 uppercase tracking-wider">Address audit detail</summary>
                                  <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-[10px]">
                                    <div>
                                      <p className="font-black text-slate-500 uppercase tracking-wider mb-0.5">1. Sent to verification</p>
                                      <p className="text-slate-700">{verify.record.submittedAddress.line1}{verify.record.submittedAddress.line2 ? `, ${verify.record.submittedAddress.line2}` : ''}</p>
                                      <p className="text-slate-700">{verify.record.submittedAddress.city}, {verify.record.submittedAddress.state} {verify.record.submittedAddress.postalCode} {verify.record.submittedAddress.country}</p>
                                    </div>
                                    <div>
                                      <p className="font-black text-slate-500 uppercase tracking-wider mb-0.5">2. Carrier returned</p>
                                      {verify.record.suggestedAddress ? (
                                        <>
                                          <p className="text-slate-700">{verify.record.suggestedAddress.line1}{verify.record.suggestedAddress.line2 ? `, ${verify.record.suggestedAddress.line2}` : ''}</p>
                                          <p className="text-slate-700">{verify.record.suggestedAddress.city}, {verify.record.suggestedAddress.state} {verify.record.suggestedAddress.postalCode} {verify.record.suggestedAddress.country}</p>
                                        </>
                                      ) : (
                                        <p className="text-slate-500 italic">no normalization differences</p>
                                      )}
                                    </div>
                                    <div>
                                      <p className="font-black text-slate-500 uppercase tracking-wider mb-0.5">3. Will be sent to pickup_create</p>
                                      <p className="text-slate-700">{resolved.address.line1}{resolved.address.line2 ? `, ${resolved.address.line2}` : ''}</p>
                                      <p className="text-slate-700">{resolved.address.city}, {resolved.address.state} {resolved.address.postalCode} {resolved.address.country}</p>
                                    </div>
                                  </div>
                                  {verify.record.warnings && verify.record.warnings.length > 0 && (
                                    <div className="mt-2">
                                      <p className="font-black text-amber-700 uppercase tracking-wider text-[10px] mb-0.5">Carrier warnings (verbatim)</p>
                                      <ul className="text-[10px] text-amber-800 list-disc list-inside">
                                        {verify.record.warnings.map((w, i) => <li key={i}>{w.code ? <span className="font-mono">[{w.code}]</span> : null} {w.message}{w.field ? ` (field: ${w.field})` : ''}</li>)}
                                      </ul>
                                    </div>
                                  )}
                                  {verify.record.details && Object.keys(verify.record.details).length > 0 && (
                                    <div className="mt-2">
                                      <p className="font-black text-slate-500 uppercase tracking-wider text-[10px] mb-0.5">Provider verification details</p>
                                      <pre className="text-[10px] text-slate-700 bg-slate-50 border border-slate-200 rounded p-1 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(verify.record.details, null, 2)}</pre>
                                    </div>
                                  )}
                                </details>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                      {/* Phase 2.6 — Pickup-only dispatch override editor.
                          Always visible (read-only when collapsed) so the
                          operator can see whether a pickup-only override is
                          in effect, and edit it without touching the locked
                          label from-address. The editor opens via either:
                          (a) the "Use pickup-only dispatch address" button
                          on the ineligibility recovery banner above, or
                          (b) the "Edit override" button on this panel. */}
                      {(() => {
                        const ov = selectedShip.pickupOverrideAddress;
                        const draft = pickupOverrideDraft[selectedShip.id];
                        const isEditing = !!draft;
                        const labelLocked = !!selectedShip.label;
                        if (!ov && !isEditing && !labelLocked) {
                          // Pre-label, no override set, not editing — keep the
                          // UI quiet. The override is an advanced recovery
                          // surface; surface it explicitly only when needed.
                          return null;
                        }
                        const detailDraft = pickupOverrideDetailDraft[selectedShip.id] ?? '';
                        const updateDraft = (patch: Partial<ShipmentAddress>) =>
                          setPickupOverrideDraft(p => ({ ...p, [selectedShip.id]: { ...(p[selectedShip.id] || ov || selectedShip.originAddress), ...patch } }));
                        return (
                          <div id="pickup-override-editor" className={`rounded-xl border p-3 space-y-2 ${ov || isEditing ? 'bg-violet-50/40 border-violet-200' : 'bg-slate-50 border-slate-200'}`}>
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-[10px] font-black uppercase tracking-widest text-violet-700">Pickup-only dispatch override</p>
                                <p className="text-[10px] text-slate-600 mt-0.5">
                                  {ov
                                    ? 'Override is ACTIVE — the carrier pickup driver is dispatched to this address. The printed label from-address is unchanged.'
                                    : labelLocked
                                      ? 'Optional. The label from-address is locked. If the carrier rejects pickup at the from-address, set a pickup-only override here (e.g. correct suite/dock or a different unit on the same property). The printed label is not affected.'
                                      : 'Optional. Use this if the pickup dispatch dock differs from the printed ship-from address.'}
                                </p>
                              </div>
                              {!isEditing && !isWriteBlocked && (
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button type="button" onClick={() => beginPickupOverride(selectedShip.id)} className="px-2 py-1 rounded text-[10px] font-black uppercase tracking-widest bg-white border border-violet-300 text-violet-700 hover:bg-violet-50">
                                    {ov ? 'Edit override' : 'Add override'}
                                  </button>
                                  {ov && (
                                    <button type="button" onClick={() => clearPickupOverride(selectedShip.id)} className="px-2 py-1 rounded text-[10px] font-black uppercase tracking-widest bg-white border border-rose-300 text-rose-700 hover:bg-rose-50">
                                      Clear
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                            {!isEditing && ov && (
                              <div className="bg-white border border-violet-200 rounded-lg p-2 text-[11px] text-slate-700">
                                <p>{ov.name}{ov.company ? ` · ${ov.company}` : ''}</p>
                                <p>{ov.line1}{ov.line2 ? `, ${ov.line2}` : ''}</p>
                                <p>{ov.city}, {ov.state} {ov.postalCode} {ov.country}</p>
                                {ov.phone && <p>{ov.phone}</p>}
                                {selectedShip.pickupLocationDetail && (
                                  <p className="mt-1 text-[10px] text-violet-700"><span className="font-black uppercase tracking-widest">Driver detail:</span> {selectedShip.pickupLocationDetail}</p>
                                )}
                              </div>
                            )}
                            {isEditing && draft && (
                              <div className="bg-white border border-violet-200 rounded-lg p-2 space-y-2">
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="col-span-2">
                                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Contact name</label>
                                    <input type="text" value={draft.name || ''} onChange={e => updateDraft({ name: e.target.value })} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
                                  </div>
                                  <div className="col-span-2">
                                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Company (optional)</label>
                                    <input type="text" value={draft.company || ''} onChange={e => updateDraft({ company: e.target.value })} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
                                  </div>
                                  <div className="col-span-2">
                                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Street (line 1)</label>
                                    <input type="text" value={draft.line1 || ''} onChange={e => updateDraft({ line1: e.target.value })} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
                                  </div>
                                  <div className="col-span-2">
                                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Suite / unit / line 2</label>
                                    <input type="text" value={draft.line2 || ''} onChange={e => updateDraft({ line2: e.target.value })} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
                                  </div>
                                  <div>
                                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">City</label>
                                    <input type="text" value={draft.city || ''} onChange={e => updateDraft({ city: e.target.value })} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
                                  </div>
                                  <div>
                                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">State</label>
                                    <input type="text" value={draft.state || ''} onChange={e => updateDraft({ state: e.target.value })} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
                                  </div>
                                  <div>
                                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Postal / ZIP</label>
                                    <input type="text" value={draft.postalCode || ''} onChange={e => updateDraft({ postalCode: e.target.value })} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
                                  </div>
                                  <div>
                                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Country</label>
                                    <input type="text" value={draft.country || ''} onChange={e => updateDraft({ country: e.target.value })} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
                                  </div>
                                  <div className="col-span-2">
                                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Phone</label>
                                    <input type="text" value={draft.phone || ''} onChange={e => updateDraft({ phone: e.target.value })} className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
                                  </div>
                                  <div className="col-span-2">
                                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Driver detail (suite, dock, door code, building, hours)</label>
                                    <input type="text" value={detailDraft} onChange={e => setPickupOverrideDetailDraft(p => ({ ...p, [selectedShip.id]: e.target.value }))} placeholder='e.g. "Suite 210, dock C, ring bell"' className="w-full mt-1 px-2 py-1.5 border border-slate-200 rounded-lg text-xs" />
                                    <p className="text-[10px] text-slate-500 mt-1">Mirrored into address line 2 (if line 2 is empty) and prepended to the carrier pickup instructions so the driver sees it.</p>
                                  </div>
                                </div>
                                <p className="text-[10px] text-amber-700 italic">Saving the override invalidates any prior pickup verification and pickup-eligibility memory for this shipment. You will need to re-verify the new address before booking.</p>
                                <div className="flex gap-2">
                                  <button type="button" onClick={() => savePickupOverride(selectedShip.id)} className="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest bg-violet-600 text-white hover:bg-violet-700">Save override</button>
                                  <button type="button" onClick={() => cancelPickupOverride(selectedShip.id)} className="px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest bg-white border border-slate-300 text-slate-700 hover:bg-slate-50">Cancel</button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {pr && (
                        <div className={`rounded-xl p-4 space-y-2 border ${
                          pr.status === 'cancelled' || pr.status === 'failed' || pr.status === 'rejected'
                            ? 'bg-rose-50/50 border-rose-200'
                            : pr.status === 'partial_failed' ? 'bg-amber-50/60 border-amber-200'
                            : pr.status === 'completed' ? 'bg-violet-50/50 border-violet-200'
                            : 'bg-sky-50/50 border-sky-200'
                        }`}>
                          {!pr.confirmationNumber && pr.source !== 'live_provider' && pr.status !== 'cancelled' && pr.status !== 'failed' && pr.status !== 'rejected' && pr.status !== 'partial_failed' && (
                            <div className="bg-amber-100 border border-amber-300 rounded-lg p-2 flex items-start gap-2">
                              <span className="material-symbols-outlined text-amber-600 text-sm mt-0.5">warning</span>
                              <p className="text-[11px] text-amber-800"><span className="font-black">Local-only request — not booked with carrier.</span> No confirmation number has been issued. The active provider does not have live pickup booking wired in this app.</p>
                            </div>
                          )}
                          {/* Phase 2.6.1 — partial-failed honesty banner.
                              Distinct from the success banner below: the
                              provider pickup record exists (id present) but
                              the carrier did NOT confirm the booking. The
                              previous code rendered the green "Booked live"
                              banner here — that was the source of the
                              "Booked live + Booking failed" contradiction
                              QA reported. */}
                          {pr.status === 'partial_failed' && (
                            <div className="bg-amber-100 border border-amber-300 rounded-lg p-2 flex items-start gap-2">
                              <span className="material-symbols-outlined text-amber-600 text-sm mt-0.5">error</span>
                              <div className="text-[11px] text-amber-900">
                                <p><span className="font-black">Pickup object created with {pr.providerId} but booking NOT confirmed.</span>{pr.providerPickupId ? <> Provider pickup id: <span className="font-mono">{pr.providerPickupId}</span>.</> : null} No carrier confirmation number has been issued.</p>
                                {pr.failureReason && <p className="mt-1">Reason: {pr.failureReason}</p>}
                                <p className="mt-1 italic">The orphaned provider record is preserved so you can cancel it from this panel. Fix the underlying issue and re-attempt — booking has not occurred.</p>
                              </div>
                            </div>
                          )}
                          {pr.source === 'live_provider' && pr.status !== 'partial_failed' && (
                            <div className="bg-emerald-100 border border-emerald-300 rounded-lg p-2 flex items-start gap-2">
                              <span className="material-symbols-outlined text-emerald-600 text-sm mt-0.5">verified</span>
                              <div className="text-[11px] text-emerald-800">
                                <p><span className="font-black">Booked live with {pr.providerId}.</span>{pr.providerPickupId ? <> Provider pickup id: <span className="font-mono">{pr.providerPickupId}</span>.</> : null}{typeof pr.providerPickupCost === 'number' ? <> Cost: <span className="font-mono">{pr.providerPickupCost.toFixed(2)} {pr.providerPickupCurrency || 'USD'}</span>.</> : null}</p>
                              </div>
                            </div>
                          )}
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-black text-slate-800">{pr.carrier} pickup · <span className="capitalize">{pr.status === 'partial_failed' ? 'Booking Failed' : pr.status}</span></p>
                            {pr.confirmationNumber && <span className="text-[10px] font-mono font-black text-slate-700 bg-white px-2 py-1 rounded-lg border border-slate-200 select-all">{pr.confirmationNumber}</span>}
                          </div>
                          <p className="text-xs text-slate-600">Date: <span className="font-bold">{pr.requestedDate}</span>{pr.windowStart && pr.windowEnd && <span> · Window <span className="font-bold">{pr.windowStart}–{pr.windowEnd}</span></span>}</p>
                          <p className="text-xs text-slate-500">From: {pr.pickupAddress.line1}, {pr.pickupAddress.city}, {pr.pickupAddress.state} {pr.pickupAddress.postalCode}</p>
                          {pr.contactName && <p className="text-[11px] text-slate-500">Contact: {pr.contactName}{pr.contactPhone ? ` · ${pr.contactPhone}` : ''}</p>}
                          {pr.packageCount !== undefined && <p className="text-[11px] text-slate-500">{pr.packageCount} package(s){pr.totalWeight ? ` · ${pr.totalWeight} lb total` : ''}</p>}
                          {pr.handlingNotes && <p className="text-[11px] text-slate-500 italic">Notes: {pr.handlingNotes}</p>}
                          {/* Pickup status history mini-timeline */}
                          <div className="mt-2 pt-2 border-t border-slate-200/60 space-y-1">
                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Status History</p>
                            <div className="flex items-center gap-2 text-[10px] text-slate-500">
                              <span className="material-symbols-outlined text-[12px] text-sky-500">schedule</span>
                              <span>Requested by {pr.requestedBy} at {formatDateTime(pr.requestedAt)}</span>
                            </div>
                            {pr.confirmedAt && (
                              <div className="flex items-center gap-2 text-[10px] text-slate-500">
                                <span className="material-symbols-outlined text-[12px] text-emerald-500">check_circle</span>
                                <span>Confirmed at {formatDateTime(pr.confirmedAt)}</span>
                              </div>
                            )}
                            {pr.completedAt && (
                              <div className="flex items-center gap-2 text-[10px] text-slate-500">
                                <span className="material-symbols-outlined text-[12px] text-violet-500">task_alt</span>
                                <span>Completed at {formatDateTime(pr.completedAt)}</span>
                              </div>
                            )}
                            {pr.cancelledAt && (
                              <div className="flex items-center gap-2 text-[10px] text-rose-600">
                                <span className="material-symbols-outlined text-[12px] text-rose-500">cancel</span>
                                <span>Cancelled by {pr.cancelledBy || 'operator'} at {formatDateTime(pr.cancelledAt)}{pr.cancellationReason ? ` — ${pr.cancellationReason}` : ''}</span>
                              </div>
                            )}
                            {pr.failureReason && (
                              <div className="flex items-center gap-2 text-[10px] text-rose-600">
                                <span className="material-symbols-outlined text-[12px] text-rose-500">error</span>
                                <span>Failed: {pr.failureReason}</span>
                              </div>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-400 italic mt-2">Live carrier pickup events (en-route / arrived / picked up) will surface here once the active provider streams pickup webhooks. For now, status reflects the request lifecycle only.</p>
                        </div>
                      )}
                      {prTerminated && pickupRequestable && !isWriteBlocked && (
                        <div className="bg-sky-50 border border-sky-200 rounded-xl p-3 mt-3 flex items-start gap-2">
                          <span className="material-symbols-outlined text-sky-500 text-sm mt-0.5">restart_alt</span>
                          <p className="text-xs text-sky-700">Previous pickup is {pr!.status}. You can re-schedule a new carrier pickup below — the cancelled record stays in the timeline for audit.</p>
                        </div>
                      )}
                      {(!pr || prTerminated) && pickupRequestable && !isWriteBlocked && (() => {
                        const puCaps = activeProviderId ? PROVIDER_CAPABILITIES[activeProviderId.toLowerCase()] : null;
                        const reqInstructions = !!puCaps?.pickupRequiresInstructions;
                        const reqContactName = !!puCaps?.pickupRequiresContactName;
                        const reqContactPhone = !!puCaps?.pickupRequiresContactPhone;
                        const reqWindow = !!puCaps?.pickupRequiresPickupWindow;
                        const payloadPreflightUI = getPickupPayloadPreflight(selectedShip);
                        const reqMark = (req: boolean) => req ? <span className="text-rose-600 ml-0.5">*</span> : null;
                        return (
                        <div className="grid grid-cols-2 gap-3 mt-4">
                          {puCaps?.supportsLivePickupBooking && payloadPreflightUI.requiredFields.length > 0 && (
                            <div className={`col-span-2 rounded-xl border p-3 ${payloadPreflightUI.ready ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                              <div className="flex items-center justify-between mb-2">
                                <p className={`text-[10px] font-black uppercase tracking-widest ${payloadPreflightUI.ready ? 'text-emerald-800' : 'text-amber-800'}`}>
                                  {activeProviderId} required pickup fields
                                </p>
                                <span className={`text-[9px] font-mono font-black px-1.5 py-0.5 rounded ${payloadPreflightUI.ready ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                                  {payloadPreflightUI.ready ? 'READY' : `${payloadPreflightUI.missing.length} MISSING`}
                                </span>
                              </div>
                              <ul className="space-y-1">
                                {payloadPreflightUI.requiredFields.map(f => (
                                  <li key={f.key} className="flex items-start gap-1.5 text-[10px]">
                                    <span className={`material-symbols-outlined text-[12px] mt-0.5 ${f.satisfied ? 'text-emerald-600' : 'text-amber-600'}`}>
                                      {f.satisfied ? 'check_circle' : 'radio_button_unchecked'}
                                    </span>
                                    <span className={`${f.satisfied ? 'text-emerald-800' : 'text-amber-900'}`}>
                                      <strong>{f.label}</strong>
                                      {!f.satisfied && <span className="text-amber-700"> — {f.sourceHint}</span>}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <div>
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Pickup Date{reqMark(reqWindow)}</label>
                            <input type="date" value={pickupForm.date} onChange={e => setPickupForm({ ...pickupForm, date: e.target.value })} className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs" />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Earliest{reqMark(reqWindow)}</label>
                              <input type="time" value={pickupForm.windowStart} onChange={e => setPickupForm({ ...pickupForm, windowStart: e.target.value })} className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs" />
                            </div>
                            <div>
                              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Latest{reqMark(reqWindow)}</label>
                              <input type="time" value={pickupForm.windowEnd} onChange={e => setPickupForm({ ...pickupForm, windowEnd: e.target.value })} className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs" />
                            </div>
                          </div>
                          <div id="pickup-contact-fields">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Contact Name{reqMark(reqContactName)}</label>
                            <input type="text" value={pickupForm.contactName} onChange={e => setPickupForm({ ...pickupForm, contactName: e.target.value })} placeholder={selectedShip.originAddress.name} className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs" />
                          </div>
                          <div>
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Contact Phone{reqMark(reqContactPhone)}</label>
                            <input type="text" value={pickupForm.contactPhone} onChange={e => setPickupForm({ ...pickupForm, contactPhone: e.target.value })} placeholder={selectedShip.originAddress.phone || ''} className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs" />
                          </div>
                          <div className="col-span-2">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                              {reqInstructions ? 'Pickup Instructions' : 'Handling Notes'}{reqMark(reqInstructions)}
                            </label>
                            <input
                              type="text"
                              value={pickupForm.notes}
                              onChange={e => setPickupForm({ ...pickupForm, notes: e.target.value })}
                              placeholder={reqInstructions ? 'Required by ' + activeProviderId + ' — e.g. "Front desk", "Side door, ring bell", "Loading dock 3"' : 'e.g. Ring bell at side door'}
                              className={`w-full mt-1 px-3 py-2 border rounded-xl text-xs ${reqInstructions && pickupForm.notes.trim().length === 0 ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}
                            />
                            {reqInstructions && (
                              <p className="text-[10px] text-slate-500 mt-1">
                                Sent to the carrier as <code className="bg-slate-100 px-1 rounded">pickup.instructions</code>. Tell the driver where to go (front desk, side door, dock, etc.). Required by {activeProviderId}.
                              </p>
                            )}
                          </div>
                          {pickupAttemptResult && (() => {
                            const tone = pickupAttemptResult.kind === 'success'
                              ? { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'check_circle', iconColor: 'text-emerald-600', titleColor: 'text-emerald-800', textColor: 'text-emerald-700' }
                              : pickupAttemptResult.kind === 'partial'
                              ? { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'warning', iconColor: 'text-amber-600', titleColor: 'text-amber-800', textColor: 'text-amber-700' }
                              : pickupAttemptResult.kind === 'info'
                              ? { bg: 'bg-sky-50', border: 'border-sky-200', icon: 'sync', iconColor: 'text-sky-600', titleColor: 'text-sky-800', textColor: 'text-sky-700' }
                              : { bg: 'bg-rose-50', border: 'border-rose-200', icon: 'error', iconColor: 'text-rose-600', titleColor: 'text-rose-800', textColor: 'text-rose-700' };
                            return (
                              <div className={`col-span-2 ${tone.bg} border ${tone.border} rounded-xl p-3`}>
                                <div className="flex items-start gap-2">
                                  <span className={`material-symbols-outlined ${tone.iconColor} text-base mt-0.5`}>{tone.icon}</span>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between gap-2">
                                      <p className={`text-xs font-black ${tone.titleColor}`}>{pickupAttemptResult.title}</p>
                                      <div className="flex items-center gap-1">
                                        {pickupAttemptResult.code && <span className="text-[9px] font-mono font-black text-slate-500 bg-white/70 px-1.5 py-0.5 rounded">{pickupAttemptResult.code}</span>}
                                        <button type="button" onClick={() => setPickupAttemptResult(null)} className="text-slate-400 hover:text-slate-600" aria-label="Dismiss">
                                          <span className="material-symbols-outlined text-sm">close</span>
                                        </button>
                                      </div>
                                    </div>
                                    <p className={`text-[11px] ${tone.textColor} mt-1`}>{pickupAttemptResult.detail}</p>
                                    {pickupAttemptResult.steps.length > 0 && (
                                      <ul className="mt-2 space-y-0.5">
                                        {pickupAttemptResult.steps.map((s, i) => (
                                          <li key={i} className="flex items-start gap-1.5 text-[10px]">
                                            <span className={`material-symbols-outlined text-[12px] mt-0.5 ${
                                              s.status === 'ok' ? 'text-emerald-500'
                                              : s.status === 'fail' ? 'text-rose-500'
                                              : s.status === 'pending' ? 'text-sky-500 animate-pulse'
                                              : 'text-slate-400'
                                            }`}>{s.status === 'ok' ? 'check_circle' : s.status === 'fail' ? 'cancel' : s.status === 'pending' ? 'sync' : 'remove_circle'}</span>
                                            <span className={tone.textColor}><span className="font-black">{s.label}</span>{s.note ? ` — ${s.note}` : ''}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                    {pickupAttemptResult.fieldErrors && pickupAttemptResult.fieldErrors.length > 0 && (
                                      <div className="mt-2 bg-white/80 border border-rose-200 rounded p-2">
                                        <p className="text-[10px] font-black text-rose-700 uppercase tracking-wider mb-1">Provider validation errors ({pickupAttemptResult.fieldErrors.length})</p>
                                        <ul className="space-y-0.5">
                                          {pickupAttemptResult.fieldErrors.map((fe, i) => (
                                            <li key={i} className="text-[10px] text-rose-800 flex items-start gap-1.5">
                                              <span className="text-rose-400">›</span>
                                              <span>
                                                {fe.field && <span className="font-mono font-black">{fe.field}: </span>}
                                                <span>{fe.message}</span>
                                                {fe.suggestion && <span className="text-rose-600 italic"> — {fe.suggestion}</span>}
                                              </span>
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                    {(pickupAttemptResult.stage || pickupAttemptResult.providerCode || pickupAttemptResult.httpStatus) && (
                                      <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] font-mono text-slate-600">
                                        {pickupAttemptResult.stage && <span className="bg-white/70 px-1.5 py-0.5 rounded border border-slate-200">stage: <span className="font-black">{pickupAttemptResult.stage}</span></span>}
                                        {pickupAttemptResult.providerCode && <span className="bg-white/70 px-1.5 py-0.5 rounded border border-slate-200">provider: <span className="font-black">{pickupAttemptResult.providerCode}</span></span>}
                                        {pickupAttemptResult.httpStatus && <span className="bg-white/70 px-1.5 py-0.5 rounded border border-slate-200">HTTP <span className="font-black">{pickupAttemptResult.httpStatus}</span></span>}
                                      </div>
                                    )}
                                    {(pickupAttemptResult.providerPickupId || pickupAttemptResult.confirmationNumber || typeof pickupAttemptResult.cost === 'number') && (
                                      <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-mono text-slate-700">
                                        {pickupAttemptResult.providerPickupId && <span className="bg-white/80 px-2 py-0.5 rounded border border-slate-200">pickup: {pickupAttemptResult.providerPickupId}</span>}
                                        {pickupAttemptResult.confirmationNumber && <span className="bg-white/80 px-2 py-0.5 rounded border border-slate-200">confirm: {pickupAttemptResult.confirmationNumber}</span>}
                                        {typeof pickupAttemptResult.cost === 'number' && <span className="bg-white/80 px-2 py-0.5 rounded border border-slate-200">cost: {pickupAttemptResult.cost.toFixed(2)} {pickupAttemptResult.currency || 'USD'}</span>}
                                      </div>
                                    )}
                                    {pickupAttemptResult.context && pickupAttemptResult.context.length > 0 && (pickupAttemptResult.kind === 'error' || pickupAttemptResult.kind === 'partial') && (
                                      <details className="mt-2">
                                        <summary className="text-[10px] font-black text-slate-600 uppercase tracking-wider cursor-pointer hover:text-slate-800">Request context (what we sent)</summary>
                                        <ul className="mt-1 space-y-0.5 bg-white/60 border border-slate-200 rounded p-2">
                                          {pickupAttemptResult.context.map((c, i) => (
                                            <li key={i} className="text-[10px] text-slate-700 flex gap-2">
                                              <span className="font-black w-32 shrink-0 text-slate-500">{c.label}:</span>
                                              <span className="font-mono break-all">{c.value}</span>
                                            </li>
                                          ))}
                                        </ul>
                                      </details>
                                    )}
                                    {pickupAttemptResult.detailsCollapsed && (
                                      <details className="mt-2">
                                        <summary className="text-[10px] font-black text-slate-600 uppercase tracking-wider cursor-pointer hover:text-slate-800">Raw provider details</summary>
                                        <pre className="mt-1 text-[10px] font-mono text-slate-700 bg-white/80 border border-slate-200 rounded p-2 whitespace-pre-wrap break-all">{pickupAttemptResult.detailsCollapsed}</pre>
                                      </details>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })()}
                          {/* Phase 2.9 — pickup-rates selection panel. Rendered
                              after pickup.create returns rates (or empty rates).
                              The operator picks the exact rate; pickup.buy is
                              called against THAT rate. Empty rates render as an
                              honest pre-booking no-rates state — NOT partial_failed. */}
                          {pickupRatesPanel && pickupRatesPanel.shipmentId === selectedShip.id && (() => {
                            const panel = pickupRatesPanel;
                            const stale = panel.formSnapshot.date !== pickupForm.date
                              || (panel.formSnapshot.windowStart || '') !== (pickupForm.windowStart || '')
                              || (panel.formSnapshot.windowEnd || '') !== (pickupForm.windowEnd || '');
                            const selected = panel.kind === 'rates'
                              ? panel.rates.find(r => r.providerRateId === panel.selectedRateId)
                              : undefined;
                            return (
                              <div className="col-span-2 rounded-2xl border-2 border-primary/30 bg-primary/5 p-4 space-y-3">
                                <div className="flex items-start justify-between gap-2">
                                  <div>
                                    <p className="text-[10px] font-black text-primary uppercase tracking-widest">Pickup options from {panel.providerId || 'provider'}</p>
                                    <p className="text-[11px] text-slate-700 mt-0.5">
                                      {panel.kind === 'no_rates'
                                        ? `No pickup rates available for ${panel.formSnapshot.date} ${panel.formSnapshot.windowStart || '09:00'}–${panel.formSnapshot.windowEnd || '17:00'} through this provider/account. Adjust the window or use drop-off — no booking was attempted.`
                                        : `Provider returned ${panel.rates.length} rate${panel.rates.length === 1 ? '' : 's'}. Pickup is NOT booked yet — review the exact fee and confirm.`}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleDiscardPickupOptions()}
                                    disabled={pickupSubmitting}
                                    className="text-[10px] font-black text-slate-500 hover:text-rose-600 uppercase tracking-widest disabled:opacity-50"
                                  >
                                    Discard
                                  </button>
                                </div>
                                {stale && (
                                  <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-[10px] text-amber-800">
                                    Pickup form date/window has changed since these rates were fetched ({panel.formSnapshot.date} {panel.formSnapshot.windowStart || '09:00'}–{panel.formSnapshot.windowEnd || '17:00'}). Discard and re-fetch to get rates for the current window.
                                  </div>
                                )}
                                {panel.kind === 'rates' && (
                                  <ul className="space-y-2">
                                    {panel.rates.map(r => {
                                      const isSel = panel.selectedRateId === r.providerRateId;
                                      const isFree = r.rate === 0;
                                      return (
                                        <li key={r.providerRateId}>
                                          <label className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-all ${isSel ? 'border-primary bg-white shadow-sm' : 'border-slate-200 bg-white/70 hover:border-slate-300'}`}>
                                            <input
                                              type="radio"
                                              name={`pickup-rate-${selectedShip.id}`}
                                              checked={isSel}
                                              onChange={() => setPickupRatesPanel(p => p ? { ...p, selectedRateId: r.providerRateId } : p)}
                                              disabled={pickupSubmitting}
                                              className="accent-primary"
                                            />
                                            <div className="flex-1 min-w-0">
                                              <p className="text-xs font-black text-slate-800 truncate">{r.carrier} · {r.service}</p>
                                              <p className="text-[10px] text-slate-500 font-mono truncate">{r.providerRateId}</p>
                                            </div>
                                            <div className="text-right shrink-0">
                                              {isFree
                                                ? <span className="text-[11px] font-black text-emerald-700 uppercase tracking-wider">Free pickup</span>
                                                : <span className="text-sm font-black text-slate-800">{r.rate.toFixed(2)} <span className="text-[10px] text-slate-500">{r.currency}</span></span>}
                                            </div>
                                          </label>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                )}
                                {panel.kind === 'rates' ? (
                                  <button
                                    type="button"
                                    onClick={() => handleConfirmPickupBuy(selectedShip.id)}
                                    disabled={pickupSubmitting || !selected || stale}
                                    className="w-full py-3 bg-primary text-white font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    {pickupSubmitting
                                      ? 'Confirming pickup…'
                                      : stale
                                      ? 'Discard and re-fetch — window changed'
                                      : !selected
                                      ? 'Choose a pickup rate to confirm'
                                      : selected.rate === 0
                                      ? `Confirm free pickup — ${selected.carrier} ${selected.service}`
                                      : `Confirm pickup — ${selected.rate.toFixed(2)} ${selected.currency}`}
                                  </button>
                                ) : (
                                  <p className="text-[10px] text-slate-500 italic">No purchasable rates were returned, so no booking is possible right now. Discard the orphan pickup record and try a different date/window — or use carrier drop-off.</p>
                                )}
                                <p className="text-[10px] text-slate-400 italic">Exact fee comes from the provider's <code className="font-mono">pickup_rates</code> response. Confirming calls <code className="font-mono">pickup.buy</code> for the chosen rate only.</p>
                              </div>
                            );
                          })()}
                          <div className="col-span-2">
                            {(() => {
                              const panelOpen = !!pickupRatesPanel && pickupRatesPanel.shipmentId === selectedShip.id;
                              const caps = activeProviderId ? PROVIDER_CAPABILITIES[activeProviderId.toLowerCase()] : null;
                              // Phase 2.9 — when the panel is open, the
                              // primary action lives inside the panel; this
                              // button drops back to "Refresh options" only,
                              // and the form-stale case keeps it functional.
                              const ratePurchase = !!caps?.pickupNeedsRatePurchase;
                              const buttonLabel = pickupSubmitting
                                ? (panelOpen ? 'Working…' : 'Requesting…')
                                : !pickupForm.date
                                ? 'Choose a pickup date to continue'
                                : !pickupSubmitReady && puElig.category === 'pickup_address_ineligible'
                                ? 'Edit address and re-verify to continue'
                                : !pickupSubmitReady && puElig.category === 'pickup_address_unverified'
                                ? 'Verify delivery to continue'
                                : !pickupSubmitReady
                                ? 'Complete required fields to continue'
                                : panelOpen
                                ? 'Refresh pickup options'
                                : ratePurchase
                                ? 'Get pickup options'
                                : 'Request Carrier Pickup';
                              return (
                                <button
                                  onClick={() => handleRequestPickup(selectedShip.id)}
                                  disabled={pickupSubmitting || !pickupForm.date || !pickupSubmitReady}
                                  title={!pickupSubmitReady && puElig.reason ? puElig.reason : undefined}
                                  className={`w-full py-3 font-black text-[10px] uppercase tracking-widest rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed ${panelOpen ? 'bg-white border-2 border-slate-300 text-slate-700 hover:border-slate-400' : 'bg-primary text-white hover:bg-primary/90 shadow-lg shadow-primary/20'}`}
                                >
                                  {buttonLabel}
                                </button>
                              );
                            })()}
                          </div>
                        </div>
                        );
                      })()}
                      {pickupCancellable && canCancelPickup && !isWriteBlocked && (
                        <div className="mt-4 pt-4 border-t border-slate-100 space-y-2">
                          <input type="text" value={pickupCancelReason} onChange={e => setPickupCancelReason(e.target.value)} placeholder="Cancellation reason (optional)" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs" />
                          <button onClick={() => handleCancelPickup(selectedShip.id)} className="px-4 py-2.5 bg-rose-50 text-rose-600 font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-rose-100 transition-all">Cancel Pickup</button>
                        </div>
                      )}
                    </div>

                    <p className="text-[10px] text-slate-400 italic">Service-point and pickup-request actions are recorded in the shipment timeline for auditability. Customs docs, insurance rules, and carrier analytics will attach via the same logistics record metadata in subsequent Phase 2 passes.</p>
                  </div>
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

        {showServicePointModal && (() => {
          const ship = shipments.find(s => s.id === showServicePointModal);
          if (!ship) return null;
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
              <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
                <div className="p-6 border-b border-slate-100 flex items-center justify-between shrink-0">
                  <div>
                    <h3 className="text-lg font-black text-primary">Select Service Point</h3>
                    <p className="text-xs text-slate-500 mt-1">Carrier drop-off locations near origin · {ship.carrier || ship.selectedRate?.carrier || 'UPS'}</p>
                  </div>
                  <button onClick={() => setShowServicePointModal(null)} className="text-slate-400 hover:text-slate-600"><span className="material-symbols-outlined">close</span></button>
                </div>
                <div className="p-6 overflow-y-auto space-y-4">
                  {(() => {
                    const liveElig = getServicePointEligibility(ship);
                    const manualElig = getServicePointManualEntryEligibility(ship);
                    const liveEnabled = liveElig.eligible && !isWriteBlocked;
                    const manualEnabled = manualElig.eligible && !isWriteBlocked;
                    return (
                  <>
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
                    <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">policy</span>
                    <div className="text-xs text-amber-700">
                      <p className="font-black">Live carrier service-point lookup is not available</p>
                      <p className="mt-0.5">No carrier-specific locator adapter is configured. Live lookup requires direct USPS Locations, UPS Locator, or FedEx Locations credentials per store. Configure under <span className="font-bold">Settings → Carrier Locators</span>.</p>
                      <p className="mt-1 text-[10px] text-amber-600">Manual entry below records a carrier-issued service-point reference operator obtained from the carrier directly (carrier website, customer email, etc.).</p>
                    </div>
                  </div>
                  {!manualEnabled && (
                    <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-start gap-2">
                      <span className="material-symbols-outlined text-rose-500 text-sm mt-0.5">lock</span>
                      <div className="text-xs text-rose-700">
                        <p className="font-black">Manual entry is also locked</p>
                        <p className="mt-0.5">{manualElig.reason || 'Manual entry is unavailable for this shipment.'}</p>
                      </div>
                    </div>
                  )}
                  {/* Disabled live ZIP search retained for visual context — clearly labeled */}
                  <fieldset disabled className="opacity-60">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2">
                      Live ZIP search
                      <span className="text-[9px] font-black text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">Unavailable</span>
                    </label>
                    <div className="flex gap-2 mt-1">
                      <input type="text" placeholder={ship.originAddress.postalCode || 'e.g. 94105'} disabled className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-xs bg-slate-50 cursor-not-allowed" />
                      <button type="button" disabled className="px-3 py-2 bg-slate-300 text-white text-[10px] font-black uppercase tracking-widest rounded-xl cursor-not-allowed">Search</button>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1">Activates once a carrier-specific locator adapter is configured.</p>
                  </fieldset>
                  <div className="border-t border-slate-100 pt-4">
                    <p className="text-[11px] font-black text-slate-700 uppercase tracking-widest mb-2">Manual service-point entry</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Service-point ID *</label>
                        <input type="text" value={manualSpForm.id} onChange={e => setManualSpForm(f => ({ ...f, id: e.target.value }))} disabled={!manualEnabled} placeholder="e.g. UPS_AP_12345" className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs disabled:opacity-50 disabled:bg-slate-50" />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Type</label>
                        <select value={manualSpForm.type} onChange={e => setManualSpForm(f => ({ ...f, type: e.target.value }))} disabled={!manualEnabled} className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs disabled:opacity-50 disabled:bg-slate-50">
                          <option value="access_point">Access Point</option>
                          <option value="parcel_locker">Parcel Locker</option>
                          <option value="locker">Locker</option>
                          <option value="office">Carrier Office</option>
                          <option value="retail_partner">Retail Partner</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Name *</label>
                        <input type="text" value={manualSpForm.name} onChange={e => setManualSpForm(f => ({ ...f, name: e.target.value }))} disabled={!manualEnabled} placeholder="e.g. UPS Access Point — 5th Ave Pharmacy" className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs disabled:opacity-50 disabled:bg-slate-50" />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Street address *</label>
                        <input type="text" value={manualSpForm.line1} onChange={e => setManualSpForm(f => ({ ...f, line1: e.target.value }))} disabled={!manualEnabled} placeholder="123 Main St" className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs disabled:opacity-50 disabled:bg-slate-50" />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">City *</label>
                        <input type="text" value={manualSpForm.city} onChange={e => setManualSpForm(f => ({ ...f, city: e.target.value }))} disabled={!manualEnabled} className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs disabled:opacity-50 disabled:bg-slate-50" />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">State *</label>
                        <input type="text" inputMode="text" maxLength={2} value={manualSpForm.state} onChange={e => setManualSpForm(f => ({ ...f, state: normalizeStateCode(e.target.value) }))} disabled={!manualEnabled} placeholder="ST" className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs uppercase disabled:opacity-50 disabled:bg-slate-50" />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Postal code *</label>
                        <input type="text" inputMode="numeric" maxLength={5} value={manualSpForm.postalCode} onChange={e => setManualSpForm(f => ({ ...f, postalCode: normalizeZip(e.target.value) }))} disabled={!manualEnabled} placeholder="ZIP" className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs disabled:opacity-50 disabled:bg-slate-50" />
                      </div>
                      <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Phone (optional)</label>
                        <input type="tel" inputMode="tel" maxLength={15} value={manualSpForm.phone} onChange={e => setManualSpForm(f => ({ ...f, phone: normalizePhone(e.target.value) }))} disabled={!manualEnabled} placeholder="Digits only" className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs disabled:opacity-50 disabled:bg-slate-50" />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Selection notes (optional)</label>
                        <input type="text" value={servicePointNotes} onChange={e => setServicePointNotes(e.target.value)} disabled={!manualEnabled} placeholder="e.g. Customer preferred location" className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-xs disabled:opacity-50 disabled:bg-slate-50" />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 mt-4">
                      <button type="button" onClick={() => setShowServicePointModal(null)} className="px-4 py-2 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Cancel</button>
                      <button
                        type="button"
                        onClick={() => handleSelectServicePointManual(ship.id)}
                        disabled={!manualEnabled || manualSpSubmitting}
                        className="px-4 py-2 bg-primary text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      >{manualSpSubmitting ? 'Saving…' : 'Save manual entry'}</button>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-2">Selection is recorded in the shipment timeline and marked <span className="font-black">source=manual</span> for audit.</p>
                  </div>
                  {/* Future: when liveEnabled becomes true (adapter configured), surface results from shippingApi.findServicePoints here. */}
                  {liveEnabled && false && (
                    <p className="text-xs text-slate-500">Live results placeholder.</p>
                  )}
                  </>
                  );
                  })()}
                </div>
              </motion.div>
            </div>
          );
        })()}

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

        {/* Phase 2.10 — Pickup cancellation confirmation modal */}
        {pickupCancelModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8">
              <div className="text-center">
                <span className={`material-symbols-outlined text-4xl mb-3 ${pickupCancelModal.result?.ok ? 'text-emerald-500' : pickupCancelModal.result && !pickupCancelModal.result.ok ? 'text-rose-500' : 'text-rose-400'}`}>
                  {pickupCancelModal.result?.ok ? 'check_circle' : pickupCancelModal.result && !pickupCancelModal.result.ok ? 'error' : 'cancel'}
                </span>
                <p className="text-sm font-black text-slate-800 mb-1">Cancel carrier pickup</p>
                <p className="text-xs text-slate-500 mb-4">
                  {pickupCancelModal.carrier}
                  {pickupCancelModal.confirmationNumber ? <> · confirmation <span className="font-mono font-bold">{pickupCancelModal.confirmationNumber}</span></> : null}
                </p>
              </div>
              {!pickupCancelModal.result && (
                <div className={`rounded-xl p-3 mb-4 text-[11px] leading-relaxed ${pickupCancelModal.isLive ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-slate-50 text-slate-600 border border-slate-200'}`}>
                  {pickupCancelModal.isLive ? (
                    <>This will call <span className="font-black">{activeProviderId}</span> to cancel the pickup with the carrier. The carrier will not arrive. This action cannot be undone — a new pickup must be requested if you change your mind.</>
                  ) : (
                    <>This pickup will be cancelled locally only — no live carrier-cancel call will be made (the pickup was not booked live, or this provider does not expose a cancel endpoint). The shipment timeline will record the local cancellation.</>
                  )}
                </div>
              )}
              {pickupCancelModal.result && (
                <div className={`rounded-xl p-3 mb-4 text-[11px] leading-relaxed border ${pickupCancelModal.result.ok ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-rose-50 text-rose-800 border-rose-200'}`}>
                  {pickupCancelModal.result.message}
                </div>
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => setPickupCancelModal(null)}
                  disabled={pickupCancelModal.inFlight}
                  className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200 disabled:opacity-50"
                >
                  {pickupCancelModal.result ? 'Close' : 'Keep pickup'}
                </button>
                {!pickupCancelModal.result && (
                  <button
                    onClick={executePickupCancel}
                    disabled={pickupCancelModal.inFlight}
                    className="flex-1 py-3 bg-rose-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-rose-600/20 disabled:opacity-60 disabled:cursor-wait"
                  >
                    {pickupCancelModal.inFlight ? 'Cancelling…' : 'Cancel pickup'}
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        )}

        {/* Phase 2.10 — Shipment-cancel blocked by active pickup */}
        {shipmentCancelBlocked && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-teal-950/40 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8 text-center">
              <span className="material-symbols-outlined text-4xl text-amber-500 mb-3">block</span>
              <p className="text-sm font-black text-slate-800 mb-2">Cancel pickup first</p>
              <p className="text-xs text-slate-600 mb-4 leading-relaxed">
                This shipment has an active <span className="font-black">{shipmentCancelBlocked.carrier}</span> pickup
                {shipmentCancelBlocked.confirmationNumber ? <> (confirmation <span className="font-mono font-bold">{shipmentCancelBlocked.confirmationNumber}</span>)</> : null}
                {' '}with status <span className="font-black">{shipmentCancelBlocked.pickupStatus}</span>. The shipment cannot be cancelled while the carrier is still scheduled to arrive — that would leave the truck dispatched against a void shipment.
              </p>
              <p className="text-[11px] text-slate-500 mb-5">Cancel the pickup with the carrier first, then return here to cancel the shipment.</p>
              <div className="flex gap-3">
                <button onClick={() => setShipmentCancelBlocked(null)} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200">Close</button>
                <button
                  onClick={() => {
                    const id = shipmentCancelBlocked.shipmentId;
                    setShipmentCancelBlocked(null);
                    handleCancelPickup(id);
                  }}
                  disabled={!canCancelPickup}
                  className="flex-1 py-3 bg-rose-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-rose-600/20 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={!canCancelPickup ? 'You do not have permission to cancel a carrier pickup.' : undefined}
                >
                  Cancel pickup now
                </button>
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
                      <input value={newOrigin.state} maxLength={2} inputMode="text" onChange={e => setNewOrigin(p => ({ ...p, state: normalizeStateCode(e.target.value) }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs uppercase focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="ST" />
                      <input value={newOrigin.postalCode} maxLength={5} inputMode="numeric" onChange={e => setNewOrigin(p => ({ ...p, postalCode: normalizeZip(e.target.value) }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="ZIP" />
                    </div>
                    <input value={newOrigin.phone || ''} type="tel" inputMode="tel" maxLength={15} onChange={e => { const v = normalizePhone(e.target.value); setNewOrigin(p => ({ ...p, phone: v || undefined })); }} disabled={addressLocked} className="col-span-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Phone (digits only)" />
                  </div>
                </div>
                <div className="space-y-3">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1"><span className="material-symbols-outlined text-xs">local_shipping</span>Destination Address {addressLocked && <span className="text-amber-500 ml-1">(locked)</span>}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={newDest.name} onChange={e => setNewDest(p => ({ ...p, name: e.target.value }))} disabled={addressLocked} className="col-span-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Name" />
                    <input value={newDest.line1} onChange={e => setNewDest(p => ({ ...p, line1: e.target.value }))} disabled={addressLocked} className="col-span-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Address line 1" />
                    <input value={newDest.city} onChange={e => setNewDest(p => ({ ...p, city: e.target.value }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="City" />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={newDest.state} maxLength={2} inputMode="text" onChange={e => setNewDest(p => ({ ...p, state: normalizeStateCode(e.target.value) }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs uppercase focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="ST" />
                      <input value={newDest.postalCode} maxLength={5} inputMode="numeric" onChange={e => setNewDest(p => ({ ...p, postalCode: normalizeZip(e.target.value) }))} disabled={addressLocked} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="ZIP" />
                    </div>
                    <input value={newDest.phone || ''} type="tel" inputMode="tel" maxLength={15} onChange={e => { const v = normalizePhone(e.target.value); setNewDest(p => ({ ...p, phone: v || undefined })); }} disabled={addressLocked} className="col-span-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 disabled:cursor-not-allowed" placeholder="Phone (digits only — required for UPS/FedEx)" />
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
                      <input value={newOrigin.state} maxLength={2} inputMode="text" onChange={e => setNewOrigin({ ...newOrigin, state: normalizeStateCode(e.target.value) })} placeholder="ST *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm uppercase focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>
                    <input value={newOrigin.postalCode} maxLength={5} inputMode="numeric" onChange={e => setNewOrigin({ ...newOrigin, postalCode: normalizeZip(e.target.value) })} placeholder="ZIP *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <input value={newOrigin.phone || ''} type="tel" inputMode="tel" maxLength={15} onChange={e => { const v = normalizePhone(e.target.value); setNewOrigin({ ...newOrigin, phone: v || undefined }); }} placeholder="Phone (digits only)" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                  </div>
                  <div className="space-y-3">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Destination Address</p>
                    <input value={newDest.name} onChange={e => setNewDest({ ...newDest, name: e.target.value })} placeholder="Recipient Name *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <input value={newDest.line1} onChange={e => setNewDest({ ...newDest, line1: e.target.value })} placeholder="Address Line 1 *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={newDest.city} onChange={e => setNewDest({ ...newDest, city: e.target.value })} placeholder="City *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                      <input value={newDest.state} maxLength={2} inputMode="text" onChange={e => setNewDest({ ...newDest, state: normalizeStateCode(e.target.value) })} placeholder="ST *" className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm uppercase focus:outline-none focus:ring-2 focus:ring-primary/20" />
                    </div>
                    <div className="relative">
                      <input value={newDest.postalCode} maxLength={5} inputMode="numeric" onChange={e => {
                        const val = normalizeZip(e.target.value);
                        setNewDest(prev => {
                          const updated = { ...prev, postalCode: val };
                          if (val.length === 5) {
                            const lookup = lookupZipCode(val);
                            if (lookup) {
                              updated.city = lookup.city;
                              updated.state = normalizeStateCode(lookup.state);
                            }
                          }
                          return updated;
                        });
                      }} placeholder="ZIP *" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
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
                    <input value={newDest.phone || ''} type="tel" inputMode="tel" maxLength={15} onChange={e => { const v = normalizePhone(e.target.value); setNewDest({ ...newDest, phone: v || undefined }); }} placeholder="Phone (digits only — required for UPS/FedEx)" className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
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

      <AnimatePresence>
        {showBulkSyncModal && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between shrink-0">
                <div>
                  <h2 className="text-lg font-black text-slate-800 flex items-center gap-2">
                    <span className="material-symbols-outlined text-indigo-500">sync</span>
                    Reconcile Shipments
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">Bulk sync tracking data for eligible provider-mode shipments. This is a recovery/reconciliation tool — webhook automation remains the primary update mechanism.</p>
                </div>
                <button onClick={() => { if (!bulkSyncRunning) { setShowBulkSyncModal(false); } }} className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-all">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>

              <div className="p-6 overflow-y-auto flex-1 space-y-5">
                {providerEnvironment === 'test' && (
                  <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                    <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">warning</span>
                    <p className="text-xs text-amber-700">Provider is in <strong>test mode</strong>. Some shipments may return test-mode limitations instead of real tracking data. This is expected.</p>
                  </div>
                )}

                {!bulkSyncResults && (
                  <>
                    <div className="space-y-3">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Eligibility Filters</p>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="flex items-center gap-2 p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-all">
                          <input type="checkbox" checked={bulkSyncFilters.inFlightOnly} onChange={e => setBulkSyncFilters(f => ({ ...f, inFlightOnly: e.target.checked }))} className="rounded" />
                          <div>
                            <p className="text-xs font-bold text-slate-700">In-flight only</p>
                            <p className="text-[10px] text-slate-400">Dispatched, In Transit, Exception</p>
                          </div>
                        </label>
                        <label className="flex items-center gap-2 p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-all">
                          <input type="checkbox" checked={bulkSyncFilters.includeTerminal} onChange={e => setBulkSyncFilters(f => ({ ...f, includeTerminal: e.target.checked }))} className="rounded" />
                          <div>
                            <p className="text-xs font-bold text-slate-700">Include terminal</p>
                            <p className="text-[10px] text-slate-400">Delivered, Rejected, Returned</p>
                          </div>
                        </label>
                        <label className="flex items-center gap-2 p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-all">
                          <input type="checkbox" checked={bulkSyncFilters.syncFailuresOnly} onChange={e => setBulkSyncFilters(f => ({ ...f, syncFailuresOnly: e.target.checked }))} className="rounded" />
                          <div>
                            <p className="text-xs font-bold text-slate-700">Sync failures only</p>
                            <p className="text-[10px] text-slate-400">Only shipments with past sync errors</p>
                          </div>
                        </label>
                        <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-xl">
                          <div className="flex-1">
                            <p className="text-xs font-bold text-slate-700">Stale threshold</p>
                            <p className="text-[10px] text-slate-400">Only if last sync older than N days</p>
                          </div>
                          <select value={bulkSyncFilters.staleDays} onChange={e => setBulkSyncFilters(f => ({ ...f, staleDays: parseInt(e.target.value) }))} className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs">
                            <option value={0}>Any</option>
                            <option value={1}>1 day</option>
                            <option value={3}>3 days</option>
                            <option value={7}>7 days</option>
                            <option value={14}>14 days</option>
                            <option value={30}>30 days</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {(() => {
                      const { eligible, excluded } = classifyBulkSyncShipments();
                      const reasonCounts: Record<string, number> = {};
                      excluded.forEach(e => { const key = e.reason.replace(/\s*\(.*?\)\s*/g, '').split(' — ')[0]; reasonCounts[key] = (reasonCounts[key] || 0) + 1; });
                      return (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between p-4 bg-indigo-50 border border-indigo-200 rounded-xl">
                            <div>
                              <p className="text-sm font-black text-indigo-700">{eligible.length} eligible shipment{eligible.length !== 1 ? 's' : ''}</p>
                              <p className="text-[10px] text-indigo-400 mt-0.5">
                                {shipments.length} total · {excluded.length} excluded · Provider mode with tracking number
                              </p>
                            </div>
                            {eligible.length > 0 && (
                              <span className="material-symbols-outlined text-indigo-400">checklist</span>
                            )}
                          </div>

                          {excluded.length > 0 && (
                            <details className="group">
                              <summary className="text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:text-slate-600 flex items-center gap-1">
                                <span className="material-symbols-outlined text-xs group-open:rotate-90 transition-transform">chevron_right</span>
                                {excluded.length} excluded — why?
                              </summary>
                              <div className="mt-2 space-y-1.5">
                                {Object.entries(reasonCounts).map(([reason, count]) => (
                                  <div key={reason} className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 rounded-lg">
                                    <span className="material-symbols-outlined text-slate-300 text-xs">block</span>
                                    <span className="text-[10px] text-slate-500 flex-1">{reason}</span>
                                    <span className="text-[10px] font-bold text-slate-400">{count}</span>
                                  </div>
                                ))}
                                {excluded.length <= 20 && (
                                  <div className="max-h-32 overflow-y-auto border border-slate-100 rounded-lg mt-1">
                                    <table className="w-full text-[10px]">
                                      <tbody className="divide-y divide-slate-50">
                                        {excluded.map((e, i) => (
                                          <tr key={i} className="text-slate-400">
                                            <td className="px-2 py-1 font-mono">{e.shipment.destinationAddress.name || e.shipment.id.slice(0, 8)}</td>
                                            <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded-full text-[8px] font-black uppercase ${STATUS_COLORS[e.shipment.status]}`}>{e.shipment.status}</span></td>
                                            <td className="px-2 py-1 text-slate-400 italic">{e.reason}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            </details>
                          )}

                          {eligible.length > 20 && (
                            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                              <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">info</span>
                              <p className="text-xs text-amber-700">Large batch ({eligible.length} shipments). Processing will take approximately {Math.ceil(eligible.length / 3 * 1.5)} seconds with provider rate-limiting.</p>
                            </div>
                          )}

                          {eligible.length > 0 && (
                            <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-xl">
                              <table className="w-full text-xs">
                                <thead className="bg-slate-50 sticky top-0">
                                  <tr>
                                    <th className="text-left px-3 py-2 font-black text-[10px] text-slate-400 uppercase tracking-widest">Shipment</th>
                                    <th className="text-left px-3 py-2 font-black text-[10px] text-slate-400 uppercase tracking-widest">Tracking</th>
                                    <th className="text-left px-3 py-2 font-black text-[10px] text-slate-400 uppercase tracking-widest">Status</th>
                                    <th className="text-left px-3 py-2 font-black text-[10px] text-slate-400 uppercase tracking-widest">Last Sync</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {eligible.map(s => (
                                    <tr key={s.id} className="hover:bg-slate-50">
                                      <td className="px-3 py-2 font-mono text-slate-600">{s.destinationAddress.name || s.id.slice(0, 8)}</td>
                                      <td className="px-3 py-2 font-mono text-slate-500 break-all">{s.trackingNumber}</td>
                                      <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${STATUS_COLORS[s.status]}`}>{s.status}</span></td>
                                      <td className="px-3 py-2 text-slate-400">{s.lastTrackingSyncAt ? new Date(s.lastTrackingSyncAt).toLocaleDateString() : 'Never'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </>
                )}

                {bulkSyncRunning && bulkSyncProgress && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="animate-spin">
                        <span className="material-symbols-outlined text-indigo-500">sync</span>
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-bold text-slate-700">Syncing tracking data...</p>
                        <p className="text-xs text-slate-400">{bulkSyncProgress.current} of {bulkSyncProgress.total} shipments processed</p>
                      </div>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2.5">
                      <div
                        className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300"
                        style={{ width: `${bulkSyncProgress.total > 0 ? (bulkSyncProgress.current / bulkSyncProgress.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                )}

                {bulkSyncSummary && bulkSyncResults && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-5 gap-2">
                      <div className="text-center p-3 bg-slate-50 rounded-xl">
                        <p className="text-lg font-black text-slate-700">{bulkSyncSummary.total}</p>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Total</p>
                      </div>
                      <div className="text-center p-3 bg-emerald-50 rounded-xl">
                        <p className="text-lg font-black text-emerald-600">{bulkSyncSummary.updated}</p>
                        <p className="text-[9px] font-black text-emerald-400 uppercase tracking-widest">Updated</p>
                      </div>
                      <div className="text-center p-3 bg-slate-50 rounded-xl">
                        <p className="text-lg font-black text-slate-500">{bulkSyncSummary.unchanged}</p>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Unchanged</p>
                      </div>
                      <div className="text-center p-3 bg-red-50 rounded-xl">
                        <p className="text-lg font-black text-red-600">{bulkSyncSummary.failed}</p>
                        <p className="text-[9px] font-black text-red-400 uppercase tracking-widest">Failed</p>
                      </div>
                      <div className="text-center p-3 bg-amber-50 rounded-xl">
                        <p className="text-lg font-black text-amber-600">{bulkSyncSummary.testLimitation}</p>
                        <p className="text-[9px] font-black text-amber-400 uppercase tracking-widest">Test Limit</p>
                      </div>
                    </div>

                    <div className="max-h-60 overflow-y-auto border border-slate-200 rounded-xl">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50 sticky top-0">
                          <tr>
                            <th className="text-left px-3 py-2 font-black text-[10px] text-slate-400 uppercase tracking-widest">Shipment</th>
                            <th className="text-left px-3 py-2 font-black text-[10px] text-slate-400 uppercase tracking-widest">Tracking</th>
                            <th className="text-left px-3 py-2 font-black text-[10px] text-slate-400 uppercase tracking-widest">Result</th>
                            <th className="text-left px-3 py-2 font-black text-[10px] text-slate-400 uppercase tracking-widest">Details</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {bulkSyncResults.map((r, i) => {
                            const resultColors: Record<string, string> = {
                              updated: 'bg-emerald-100 text-emerald-700',
                              unchanged: 'bg-slate-100 text-slate-500',
                              failed: 'bg-red-100 text-red-700',
                              test_limitation: 'bg-amber-100 text-amber-700',
                            };
                            const resultLabels: Record<string, string> = {
                              updated: 'Updated',
                              unchanged: 'No Changes',
                              failed: 'Failed',
                              test_limitation: 'Test Limit',
                            };
                            const ship = shipments.find(s => s.id === r.shipmentId);
                            return (
                              <tr key={i} className="hover:bg-slate-50 cursor-pointer" onClick={() => { setShowBulkSyncModal(false); setSelectedShipment(r.shipmentId); setDetailTab('tracking'); }}>
                                <td className="px-3 py-2 font-mono text-slate-600">{ship?.destinationAddress.name || r.shipmentId.slice(0, 8)}</td>
                                <td className="px-3 py-2 font-mono text-slate-500 break-all">{r.trackingNumber}</td>
                                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${resultColors[r.result] || 'bg-slate-100 text-slate-500'}`}>{resultLabels[r.result] || r.result}</span></td>
                                <td className="px-3 py-2 text-slate-400">
                                  {r.result === 'updated' && r.newEventCount ? `${r.newEventCount} new event${r.newEventCount > 1 ? 's' : ''}` : ''}
                                  {r.result === 'failed' && r.error ? r.error.message : ''}
                                  {r.result === 'test_limitation' ? 'Expected in test mode' : ''}
                                  {r.result === 'unchanged' ? 'Already up to date' : ''}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              <div className="p-6 border-t border-slate-100 flex gap-3 shrink-0">
                {!bulkSyncResults ? (
                  <>
                    <button onClick={() => setShowBulkSyncModal(false)} disabled={bulkSyncRunning} className="flex-1 py-3 bg-white text-slate-500 rounded-xl font-black text-[10px] uppercase tracking-widest border border-slate-200 disabled:opacity-50">Cancel</button>
                    <button
                      onClick={handleBulkSync}
                      disabled={bulkSyncRunning || getBulkSyncEligibleShipments().length === 0}
                      className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {bulkSyncRunning ? (
                        <><span className="material-symbols-outlined text-sm animate-spin">sync</span>Syncing...</>
                      ) : (
                        <><span className="material-symbols-outlined text-sm">sync</span>Start Reconciliation ({getBulkSyncEligibleShipments().length})</>
                      )}
                    </button>
                  </>
                ) : (
                  <button onClick={() => { setShowBulkSyncModal(false); setBulkSyncResults(null); setBulkSyncSummary(null); }} className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-indigo-500/20">
                    Done
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </PageShell>
  );
}
