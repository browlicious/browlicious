// Read a Google Calendar export: either the .zip Google gives you or a single .ics.

/** Returns [{ name, text }] for every .ics file in the upload. */
export async function readCalendarFile(file) {
  const buf = await file.arrayBuffer();
  const sig = new Uint8Array(buf, 0, 4);
  if (sig[0] === 0x50 && sig[1] === 0x4b) return readZipIcs(buf); // "PK"
  return [{ name: file.name, text: new TextDecoder().decode(buf) }];
}

// Minimal ZIP reader (stored + deflate) using the central directory.
async function readZipIcs(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.ics$/i.test(name)) continue;

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const data = new Uint8Array(buf, localOff + 30 + lNameLen + lExtraLen, compSize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else continue;
    out.push({ name, text: new TextDecoder().decode(bytes) });
  }
  if (!out.length) throw new Error('No .ics calendar files found in the zip.');
  return out;
}

const unescapeText = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function splitProp(line) {
  // Split "NAME;PARAM=..:value" at the first colon that is not inside quotes.
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') q = !q;
    else if (ch === ':' && !q) {
      const [name, ...params] = line.slice(0, i).split(';');
      const pm = {};
      for (const p of params) { const [k, v = ''] = p.split('='); pm[k.toUpperCase()] = v.replace(/"/g, ''); }
      return { name: name.toUpperCase(), params: pm, value: line.slice(i + 1) };
    }
  }
  return null;
}

function parseDate(value, params) {
  const v = value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (params.VALUE === 'DATE' || m) {
    m = m || v.match(/^(\d{4})(\d{2})(\d{2})/);
    return { date: new Date(+m[1], +m[2] - 1, +m[3]), allDay: true };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '0', z] = m;
  // Z = UTC. TZID/floating times are treated as the phone's local time (NZ).
  const date = z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return { date, allDay: false };
}

/** Parse VEVENTs. Recurring events are imported once (their first date). */
export function parseICS(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  let depth = 0; // skip nested VALARM etc.
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; depth = 0; continue; }
    if (!cur) continue;
    if (line === 'END:VEVENT') { events.push(cur); cur = null; continue; }
    if (line.startsWith('BEGIN:')) { depth++; continue; }
    if (line.startsWith('END:')) { depth--; continue; }
    if (depth > 0) continue;
    const p = splitProp(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(p.value); break;
      case 'STATUS': cur.status = p.value.trim().toUpperCase(); break;
      case 'RRULE': cur.recurring = true; break;
      case 'RECURRENCE-ID': cur.recurrenceId = p.value; break;
      case 'DTSTART': cur.dtstart = parseDate(p.value, p.params); break;
      case 'DTEND': cur.dtend = parseDate(p.value, p.params); break;
      default: break;
    }
  }
  return events
    .filter((e) => e.dtstart && e.status !== 'CANCELLED')
    .map((e) => ({
      source: 'ics',
      gcalId: null,
      icalUid: e.uid || `${e.summary}|${e.dtstart.date.toISOString()}`,
      blId: null,
      summary: e.summary || '',
      description: e.description || '',
      start: e.dtstart.date,
      end: e.dtend?.date || e.dtstart.date,
      allDay: e.dtstart.allDay,
      recurring: !!e.recurring,
      cancelled: false,
    }));
}
