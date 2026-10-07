import { validateEntry, type ContactType, type Entry } from './index.js';

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f.trim())) rows.push(row);
  return rows;
}

// Header names we recognize (lowercased, punctuation stripped), including our own export's.
const COLUMNS = {
  date: ['date', 'work date', 'date of service', 'session date'],
  start: ['start', 'start time', 'time in', 'from'],
  end: ['end', 'end time', 'time out', 'to'],
  type: ['type', 'fieldwork type', 'activity type', 'supervision', 'supervised', 'kind'],
  supervisor: ['supervisor', 'supervisor name', 'bcba'],
  restricted: ['restricted hours', 'restricted', 'restricted hrs'],
  group: ['group', 'group supervision'],
  contact: ['contact', 'contact type', 'observation'],
  format: ['format', 'modality'],
  description: ['description', 'notes', 'activity', 'activities', 'comments'],
} as const;
type Column = keyof typeof COLUMNS;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

function toDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/); // US M/D/YYYY
  if (!m) return null;
  const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  return `${y}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

function toTime(s: string): string | null {
  const m = s.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3] === 'pm' ? 12 : 0) }
  return h < 24 && Number(m[2]) < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
}

const yes = (s: string) => /^(y|yes|true|1|x)$/i.test(s.trim());

export interface ImportRow {
  line: number; // 1-based line in the file, header = 1
  entry: Entry & { format: 'in_person' | 'online' | null; description: string };
  supervisorName: string;
  errors: string[];
}

/** Turns a spreadsheet export into entries, validated with the same rules the app enforces. */
export function importCsv(text: string): { rows: ImportRow[]; missing: Column[] } {
  const [header = [], ...body] = parseCsv(text.replace(/^﻿/, ''));
  const names = header.map(norm);
  const col = Object.fromEntries((Object.keys(COLUMNS) as Column[]).map(k => [k, names.findIndex(n => (COLUMNS[k] as readonly string[]).includes(n))])) as Record<Column, number>;
  const missing = (['date', 'start', 'end'] as const).filter(k => col[k] < 0);
  if (missing.length) return { rows: [], missing };
  const get = (r: string[], k: Column) => (col[k] >= 0 ? r[col[k]]?.trim() ?? '' : '');

  const rows = body.map((r, i): ImportRow => {
    const errors: string[] = [];
    const workDate = toDate(get(r, 'date')), startTime = toTime(get(r, 'start')), endTime = toTime(get(r, 'end'));
    if (!workDate) errors.push(`Unrecognized date "${get(r, 'date')}"`);
    if (!startTime || !endTime) errors.push('Start and end must be times like 9:00 or 9:00 AM');
    const kind = /supervis|present/i.test(get(r, 'type')) && !/independ|not present|unsupervised/i.test(get(r, 'type')) ? 'supervised' : 'independent';
    const restrictedHours = Number(get(r, 'restricted') || 0);
    if (!Number.isFinite(restrictedHours) || restrictedHours < 0) errors.push(`Restricted hours "${get(r, 'restricted')}" isn't a number`);
    const c = get(r, 'contact').toLowerCase();
    const contact: ContactType | null = kind === 'supervised' ? (c.includes('observ') ? 'observation' : c.includes('contact') ? 'contact' : null) : null;
    const entry = {
      workDate: workDate ?? '', startTime: startTime ?? '', endTime: endTime ?? '', kind, contact,
      restrictedMinutes: Math.round((Number.isFinite(restrictedHours) ? restrictedHours : 0) * 60),
      isGroup: kind === 'supervised' && yes(get(r, 'group')),
      format: kind === 'supervised' ? (/online|remote|virtual|tele/i.test(get(r, 'format')) ? 'online' : 'in_person') : null,
      description: get(r, 'description').slice(0, 5000),
    } as ImportRow['entry'];
    if (!errors.length) errors.push(...validateEntry(entry));
    return { line: i + 2, entry, supervisorName: get(r, 'supervisor'), errors };
  });
  return { rows, missing };
}
