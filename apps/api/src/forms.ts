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
export function formValues(f: FormInput): Record<string, string | [value: string, display: string]> {
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
  const obs = f.summary.observationMinutes ?? 0, total = ind + sup;
  return { ...common, // whole hours + minutes
    Independent_Hours: String(Math.floor(ind / 60)), Independent_Minutes: String(ind % 60),
    Supervised_Hours: String(Math.floor(sup / 60)), Supervised_Minutes: String(sup % 60),
    Observation_Hours: String(Math.floor(obs / 60)), 'Independent_Minutes 3': String(obs % 60),
    Total_Fieldwork_Hours: String(Math.floor(total / 60)), Total_Fieldwork_Minutes: String(total % 60),
    PERCENT_HOURS_SUPERVISED: pct(ind === 0 ? null : sup / total) };
}

/** 2022 only: the fieldwork-type box is two widgets of one checkbox field, each with its own "on" name. */
function checkFieldworkType(form: PDFForm, type: FieldworkType) {
  const on = type === 'concentrated' ? 'Concentrated Supervised Fieldwork' : 'Supervised Fieldwork';
  const field = form.getCheckBox('CHECK_SUPERVISED_FIELDWORK').acroField;
  field.dict.set(PDFName.of('V'), PDFName.of(on));
  for (const w of field.getWidgets()) w.setAppearanceState(PDFName.of(w.getOnValue()?.decodeText() === on ? on : 'Off'));
}

export async function fillMonthlyForm(f: FormInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await readFile(`${FORMS_DIR}/mfvf-${f.edition}.pdf`));
  const form = doc.getForm(), font = await doc.embedFont(StandardFonts.Helvetica);
  const raw: [PDFTextField, string][] = [];
  for (const [name, v] of Object.entries(formValues(f))) {
    const field = form.getTextField(name), [value, display] = typeof v === 'string' ? [v, v] : v;
    field.setText(display);
    if (value !== display) raw.push([field, value]);
  }
  if (f.edition === '2022') checkFieldworkType(form, f.fieldworkType);
  form.updateFieldAppearances(font);
  // Show "7.50%" but store 0.075, the value the form's own percent formatter expects.
  for (const [field, value] of raw) field.acroField.dict.set(PDFName.of('V'), PDFHexString.fromText(value));

  // Electronic signatures (BACB Acceptable Signatures Policy allows any e-signature made with intent to sign).
  const page = doc.getPage(0);
  for (const [field, sig] of [['TRAINEE_SIGNATURE', f.traineeSigned], ['SUPERVISOR_SIGNATURE', f.supervisorSigned]] as const) {
    if (!sig) continue;
    const r = form.getSignature(field).acroField.getWidgets()[0]!.getRectangle();
    page.drawText(`/s/ ${sig.name}`, { x: r.x + 3, y: r.y + 3.5, size: 10, font });
    const stamp = `Signed electronically in Fieldtrack ${sig.at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    page.drawText(stamp, { x: r.x + r.width - font.widthOfTextAtSize(stamp, 6) - 3, y: r.y + 4, size: 6, font });
  }
  const ref = `Fieldtrack ref ${f.reference}`;
  page.drawText(ref, { x: 576 - font.widthOfTextAtSize(ref, 6), y: 44, size: 6, font });
  if (f.traineeSigned && f.supervisorSigned) { // signed copies can't be edited afterward
    form.flatten();
    form.acroForm.dict.delete(PDFName.of('CO')); // calculation order pointed at the removed fields
    const annots = page.node.Annots(); // pdf-lib misses widgets of this form's nested checkbox; drop the dangling ones
    for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) if (!doc.context.lookup(annots!.get(i))) annots!.remove(i);
  }
  doc.setProducer('Fieldtrack');
  return doc.save({ updateFieldAppearances: false });
}
