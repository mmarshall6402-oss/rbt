import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFHexString, PDFName, PDFTextField, StandardFonts, type PDFForm } from 'pdf-lib';
import type { Edition, FieldworkType, MonthSummary } from '@fieldtrack/rules';

/** Official BACB templates, fetched and hash-checked by scripts/fetch-forms.mjs. */
const FORMS_DIR = process.env.FORMS_DIR ?? new URL('../forms/', import.meta.url).pathname;

export interface Signature { name: string; at: Date }
export interface FormInput {
  edition: Edition; fieldworkType: FieldworkType; month: string; // YYYY-MM
  trainee: { name: string; bacbId: string | null }; supervisor: { name: string; bacbId: string | null };
  state: string | null; country: string | null;
  summary: Pick<MonthSummary, 'independentMinutes' | 'supervisedMinutes'> & { observationMinutes?: number };
  traineeSigned: Signature | null; supervisorSigned: Signature | null;
  reference: string; // verification id, ties the paper back to our audit log
}

const usDate = (d: Date) => d.toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' });
const pct = (frac: number | null): [string, string] => (frac === null ? ['', ''] : [String(frac), `${(frac * 100).toFixed(2)}%`]); // [value, display]

/**
 * The numbers each form shows, computed exactly the way the form's own Acrobat scripts do,
 * so opening it in Acrobat (which recalculates) never changes what was signed.
 */
export function formValues(f: FormInput): Values {
  const { independentMinutes: ind, supervisedMinutes: sup } = f.summary;
  const [y, m] = f.month.split('-');
  const common = {
    TRAINEE_NAME: f.trainee.name, TRAINEE_BACB_ID: f.trainee.bacbId ?? '', 'TRAINEE_CERTIFICATE_MONTH/YEAR': `${m}/${y}`,
    TRAINEE_FIELDWORK_STATE: f.state ?? '', TRAINEE_FIELDWORK_COUNTRY: f.country ?? '',
    RESPONSIBLE_SUPERVISOR_NAME: f.supervisor.name, RESPONSIBLE_SUPERVISOR_BACB_ID: f.supervisor.bacbId ?? '',
    TRAINEE_SIGNATURE_DATE: f.traineeSigned ? usDate(f.traineeSigned.at) : '',
    SUPERVISOR_SIGNATURE_DATE: f.supervisorSigned ? usDate(f.supervisorSigned.at) : '',
  };
  if (f.edition === '2022') { // decimal hours, 2 places
    const i = (ind / 60).toFixed(2), s = (sup / 60).toFixed(2);
    return { ...common, INDEPENDENT_HOURS: i, SUPERVISED_HOURS: s, TOTAL_FIELDWORK: (Number(i) + Number(s)).toFixed(2),
      PERCENT_HOURS_SUPERVISED: pct(Number(i) === 0 ? null : Number(s) / (Number(s) + Number(i))) };
  }
  const total = ind + sup, obs = Math.min(f.summary.observationMinutes ?? 0, total); // never more observation than the hours that count
  return { ...common, // whole hours + minutes
    Independent_Hours: String(Math.floor(ind / 60)), Independent_Minutes: String(ind % 60),
    Supervised_Hours: String(Math.floor(sup / 60)), Supervised_Minutes: String(sup % 60),
    Observation_Hours: String(Math.floor(obs / 60)), 'Independent_Minutes 3': String(obs % 60),
    Total_Fieldwork_Hours: String(Math.floor(total / 60)), Total_Fieldwork_Minutes: String(total % 60),
    PERCENT_HOURS_SUPERVISED: pct(ind === 0 ? null : sup / total) };
}

/** Checkbox groups whose widgets each have their own "on" name (e.g. the 2022 fieldwork-type boxes). */
function setCheck(form: PDFForm, name: string, on: string) {
  const field = form.getCheckBox(name).acroField;
  field.dict.set(PDFName.of('V'), PDFName.of(on));
  for (const w of field.getWidgets()) w.setAppearanceState(PDFName.of(w.getOnValue()?.decodeText() === on ? on : 'Off'));
}

type Values = Record<string, string | [value: string, display: string]>;
interface FillOptions { checks?: Record<string, string>; choices?: Record<string, string>; signatures: [field: string, sig: Signature | null][]; reference: string; lock: boolean }

/** Fills an official BACB template; locked (flattened) copies can't be edited after signing. */
async function fillPdf(template: string, values: Values, o: FillOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await readFile(`${FORMS_DIR}/${template}`));
  const form = doc.getForm(), font = await doc.embedFont(StandardFonts.Helvetica);
  const raw: [PDFTextField, string][] = [];
  for (const [name, v] of Object.entries(values)) {
    const field = form.getTextField(name), [value, display] = typeof v === 'string' ? [v, v] : v;
    field.setText(display);
    if (value !== display) raw.push([field, value]);
  }
  for (const [name, on] of Object.entries(o.checks ?? {})) setCheck(form, name, on);
  for (const [name, option] of Object.entries(o.choices ?? {})) form.getDropdown(name).select(option);
  form.updateFieldAppearances(font);
  // Show "7.50%" but store 0.075, the value the form's own percent formatter expects.
  for (const [field, value] of raw) field.acroField.dict.set(PDFName.of('V'), PDFHexString.fromText(value));

  // Electronic signatures (BACB Acceptable Signatures Policy allows any e-signature made with intent to sign).
  const page = doc.getPage(0);
  for (const [field, sig] of o.signatures) {
    if (!sig) continue;
    const r = form.getSignature(field).acroField.getWidgets()[0]!.getRectangle();
    page.drawText(`/s/ ${sig.name}`, { x: r.x + 3, y: r.y + 3.5, size: 10, font });
    const stamp = `Signed electronically in Fieldtrack ${sig.at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    page.drawText(stamp, { x: r.x + r.width - font.widthOfTextAtSize(stamp, 6) - 3, y: r.y + 4, size: 6, font });
  }
  const ref = `Fieldtrack ref ${o.reference}`;
  page.drawText(ref, { x: 576 - font.widthOfTextAtSize(ref, 6), y: 44, size: 6, font });
  if (o.lock) {
    form.flatten();
    form.acroForm.dict.delete(PDFName.of('CO')); // calculation order pointed at the removed fields
    const annots = page.node.Annots(); // pdf-lib misses widgets of nested checkboxes; drop the dangling ones
    for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) if (!doc.context.lookup(annots!.get(i))) annots!.remove(i);
  }
  doc.setProducer('Fieldtrack');
  return doc.save({ updateFieldAppearances: false });
}

export const fillMonthlyForm = (f: FormInput) => fillPdf(`mfvf-${f.edition}.pdf`, formValues(f), {
  checks: f.edition === '2022' ? { CHECK_SUPERVISED_FIELDWORK: f.fieldworkType === 'concentrated' ? 'Concentrated Supervised Fieldwork' : 'Supervised Fieldwork' } : {},
  signatures: [['TRAINEE_SIGNATURE', f.traineeSigned], ['SUPERVISOR_SIGNATURE', f.supervisorSigned]],
  reference: f.reference, lock: !!(f.traineeSigned && f.supervisorSigned),
});

// ---- Final Fieldwork Verification Form (one per supervisor, supervisor signs) ----
export interface TypeTotals { independentMinutes: number; supervisedMinutes: number; months: number }
export interface FinalInput {
  edition: Edition; trainee: { name: string; bacbId: string | null }; supervisor: { name: string; bacbId: string | null };
  state: string | null; country: string | null; startMonth: string; endMonth: string; // YYYY-MM
  totals: Record<FieldworkType, TypeTotals | null>; supervisorSigned: Signature | null; reference: string;
}

const mmyyyy = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;

/** Values per the form's own scripts; a fieldwork type with no hours is left blank, as the form instructs. */
export function finalFormValues(f: FinalInput): Values {
  const v: Values = {
    TRAINEE_NAME: f.trainee.name, TRAINEE_ACCOUNT_ID: f.trainee.bacbId ?? '', START_DATE: mmyyyy(f.startMonth), END_DATE: mmyyyy(f.endMonth),
    TRAINEE_FIELDWORK_STATE: f.state ?? '', TRAINEE_FIELDWORK_COUNTRY: f.country ?? '',
    RESPONSIBLE_SUPERVISOR_NAME: f.supervisor.name, RESPONSIBLE_SUPERVISOR_BACB_ID: f.supervisor.bacbId ?? '',
    SUPERVISOR_SIGNATURE_DATE: f.supervisorSigned ? usDate(f.supervisorSigned.at) : '',
  };
  for (const type of ['supervised', 'concentrated'] as const) {
    const t = f.totals[type];
    if (!t) continue;
    const { independentMinutes: ind, supervisedMinutes: sup } = t;
    if (f.edition === '2022') {
      const sfx = type === 'concentrated' ? ' 2' : '', i = (ind / 60).toFixed(2), s = (sup / 60).toFixed(2);
      Object.assign(v, { [`INDEPENDENT_HOURS${sfx}`]: i, [`SUPERVISED_HOURS${sfx}`]: s, [`TOTAL_FIELDWORK${sfx}`]: (Number(i) + Number(s)).toFixed(2),
        [`PERCENT_HOURS_SUPERVISED${sfx}`]: pct(Number(i) === 0 ? null : Number(s) / (Number(s) + Number(i))),
        [`TOTAL_MONTHS_OF_FIELDWORK_OBTAINED${sfx}`]: String(t.months) });
    } else {
      const p = type === 'concentrated' ? 'C_' : '', total = ind + sup;
      Object.assign(v, { [`${p}Independent_Hours`]: String(Math.floor(ind / 60)), [`${p}Independent_Minutes`]: String(ind % 60),
        [`${p}Supervised_Hours`]: String(Math.floor(sup / 60)), [`${p}Supervised_Minutes`]: String(sup % 60),
        [`${p}Total_Fieldwork_Hours`]: String(Math.floor(total / 60)), [`${p}Total_Fieldwork_Minutes`]: String(total % 60),
        [`${p}PERCENT_HOURS_SUPERVISED`]: pct(ind === 0 ? null : sup / total) });
    }
  }
  return v;
}

export function fillFinalForm(f: FinalInput) {
  const types = (['supervised', 'concentrated'] as const).filter(t => f.totals[t]);
  const fieldworkType = types.length === 2 ? 'Mixed' : types[0] === 'concentrated' ? 'Concentrated Supervised Fieldwork' : 'Supervised Fieldwork';
  return fillPdf(`ffvf-${f.edition}.pdf`, finalFormValues(f), {
    ...(f.edition === '2022' ? { checks: { 'Fieldwork-Type': fieldworkType }, choices: { RESPONSIBLE_SUPERVISOR_QUALIFICATION: 'BCBA/BCBA-D' } } : {}),
    signatures: [['SUPERVISOR_SIGNATURE', f.supervisorSigned]], reference: f.reference, lock: !!f.supervisorSigned,
  });
}
