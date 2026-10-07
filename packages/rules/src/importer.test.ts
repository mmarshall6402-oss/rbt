import { describe, expect, it } from 'vitest';
import { importCsv, parseCsv } from './index.js';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded commas and newlines, CRLF and blank lines', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n\n1,2')).toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere'], ['1', '2']]);
  });
});

describe('importCsv', () => {
  it('reads our own export back exactly', () => {
    const csv = '﻿"Date","Start","End","Hours","Type","Supervisor","Restricted hours","Unrestricted hours","Group","Contact","Format","Description"\r\n' +
      '"2026-09-02","09:00","10:30","1.500","supervised","Lorinda Otto","0.500","1.000","yes","observation","online","Observed ""DTT"""\r\n';
    const [r] = importCsv(csv).rows;
    expect(r).toEqual({ line: 2, supervisorName: 'Lorinda Otto', errors: [], entry: {
      workDate: '2026-09-02', startTime: '09:00', endTime: '10:30', kind: 'supervised', contact: 'observation',
      restrictedMinutes: 30, isGroup: true, format: 'online', description: 'Observed "DTT"', observedAsync: false } });
  });

  it('maps other spreadsheets: US dates, 12-hour times, synonyms; independent rows drop supervision fields', () => {
    const { rows } = importCsv('Session Date,Time In,Time Out,Activity Type,BCBA,Notes,Contact\n9/3/26,1:15 PM,3:00 pm,Independent,Sam,Prep,observation\n');
    expect(rows[0]!.entry).toMatchObject({ workDate: '2026-09-03', startTime: '13:15', endTime: '15:00', kind: 'independent', contact: null, format: null, description: 'Prep' });
    expect(rows[0]!.supervisorName).toBe('Sam');
  });

  it('round-trips a recorded observation on an independent entry', () => {
    const { rows } = importCsv('Date,Start,End,Type,Contact\n2026-09-04,09:00,10:00,independent,recorded observation\n');
    expect(rows[0]!.entry).toMatchObject({ kind: 'independent', contact: null, observedAsync: true });
    expect(rows[0]!.errors).toEqual([]);
  });

  it('reports bad rows with their line number instead of guessing', () => {
    const { rows } = importCsv('Date,Start,End,Restricted\n2026-09-01,10:00,09:00,0\nyesterday,9:00,10:00,0\n2026-09-02,9:00,10:00,3\n');
    expect(rows.map(r => [r.line, r.errors.length > 0])).toEqual([[2, true], [3, true], [4, true]]);
    expect(rows[1]!.errors[0]).toMatch(/Unrecognized date "yesterday"/);
  });

  it('names the required columns it could not find', () => {
    expect(importCsv('Day,Hours\n2026-09-01,2\n').missing).toEqual(['date', 'start', 'end']);
  });
});
