// Downloads the BACB's official Monthly Fieldwork Verification Forms (the templates we fill).
// Pinned by hash: when the BACB publishes a new version this fails loudly, so we re-check field names before updating.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const dir = new URL('../forms/', import.meta.url);
const FORMS = {
  'mfvf-2022.pdf': ['https://www.bacb.com/wp-content/uploads/2022/01/BACB-Monthly-Fieldwork-Verification-Form-Individual_240201-a.pdf', '65df073b9b30a62f0ca968d13a9ff6f4ec43b3d0c385547be64830500bd9690f'],
  'mfvf-2027.pdf': ['https://www.bacb.com/wp-content/uploads/2025/03/2027-Monthly-Fieldwork-Verification-Form-Individual_260603-2-a.pdf', '757237e5c7c5ed323605853e796cf36fb918fbfc107c3ece98a470b885363869'],
};
const sha = buf => createHash('sha256').update(buf).digest('hex');

await mkdir(dir, { recursive: true });
for (const [name, [url, hash]] of Object.entries(FORMS)) {
  const file = new URL(name, dir);
  if (sha(await readFile(file).catch(() => Buffer.alloc(0))) === hash) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== hash) throw new Error(`${name}: the BACB changed this form (sha256 ${sha(buf)}). Review its fields, then update the pin.`);
  await writeFile(file, buf);
  console.log(`fetched ${name}`);
}
