import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { durationMinutes, formatHours, groupByForm, type Entry, type MonthResult } from '@fieldtrack/rules';

export interface LogEntry extends Entry { supervisorId: string }
export interface HoursLogInput {
  trainee: { name: string; bacbId: string | null }; standard: string;
  entries: LogEntry[]; forms: MonthResult[]; supervisors: Map<string, string>;
  signedAt: Map<string, Date>; // `${month}|${supervisorId}` -> supervisor signature time
  countableMinutes: number; requiredMinutes: number;
}

const COLS = [['Date', 70], ['Time', 95], ['Hours', 45], ['Type', 70], ['Supervisor', 150], ['Restricted', 52], ['Unrestricted', 50]] as const;
const W = 612, H = 792, M = 40;
const monthName = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Printable record of every hour, grouped by verification form (month × supervisor). No descriptions: they can hold client details. */
export async function hoursLogPdf(d: HoursLogInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [font, bold] = await Promise.all([doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold)]);
  let page!: PDFPage, y = 0;
  const text = (s: string, x: number, size = 8, f: PDFFont = font, color = rgb(0, 0, 0)) => page.drawText(s, { x, y, size, font: f, color });
  const newPage = () => {
    page = doc.addPage([W, H]); y = H - M;
    text(`Fieldwork hours log · ${d.trainee.name}${d.trainee.bacbId ? ` · BACB ID ${d.trainee.bacbId}` : ''}`, M, 8, font, rgb(0.4, 0.4, 0.4));
    y -= 18;
  };
  const need = (h: number) => { if (y - h < M) newPage() };

  newPage();
  text('Fieldwork hours log', M, 18, bold); y -= 20;
  text(`${d.standard} · Countable ${formatHours(d.countableMinutes)} of ${formatHours(d.requiredMinutes, 0)} h · Generated ${new Date().toISOString().slice(0, 10)}`, M, 9); y -= 24;

  const results = new Map(d.forms.map(f => [`${f.month}|${f.supervisorId ?? ''}`, f]));
  for (const form of groupByForm(d.entries)) {
    const key = `${form.month}|${form.supervisorId ?? ''}`, r = results.get(key), signed = d.signedAt.get(key);
    need(60);
    text(`${monthName(form.month)} · ${d.supervisors.get(form.supervisorId ?? '') ?? 'Supervisor'}`, M, 11, bold); y -= 13;
    const status = !r ? '' : r.lost ? 'Lost: not signed by the deadline' : r.outsideWindow ? 'Outside the 5-year window'
      : r.passed ? 'Meets requirements' : r.countableMinutes > 0 ? `${formatHours(r.countableMinutes)} h count after the BACB adjustment` : 'Does not count';
    text([`${formatHours(r?.summary.totalMinutes ?? 0)} h logged`, status,
      signed ? `Signed by supervisor ${signed.toISOString().slice(0, 10)}` : 'Not signed'].join(' · '), M, 8); y -= 14;
    let x = M;
    for (const [h, w] of COLS) { text(h, x, 7, bold); x += w }
    y -= 3; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) }); y -= 10;
    for (const e of [...form.entries].sort((a, b) => (a.workDate + a.startTime).localeCompare(b.workDate + b.startTime))) {
      need(12);
      const min = durationMinutes(e);
      const cells = [e.workDate, `${e.startTime.slice(0, 5)}–${e.endTime.slice(0, 5)}`, formatHours(min), e.kind === 'supervised' ? `Supervised${e.isGroup ? ' (group)' : ''}` : 'Independent',
        d.supervisors.get(e.supervisorId) ?? '', formatHours(e.restrictedMinutes), formatHours(min - e.restrictedMinutes)];
      x = M;
      cells.forEach((c, i) => { text(c, x); x += COLS[i]![1] });
      y -= 11;
    }
    y -= 12;
  }
  if (!d.entries.length) text('No hours logged yet.', M, 9);
  doc.setTitle(`Fieldwork hours log · ${d.trainee.name}`); doc.setProducer('Fieldtrack');
  return doc.save();
}
