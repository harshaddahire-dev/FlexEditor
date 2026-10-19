#!/usr/bin/env node
// Stands in for whisper.cpp in e2e runs: same CLI contract (-of <base> → <base>.json, one word per segment).
import fs from 'node:fs';
const a = process.argv;
const base = a[a.indexOf('-of') + 1];
const input = a[a.indexOf('-f') + 1];
if (!fs.existsSync(input)) process.exit(2);
const w = (text, from, to) => ({ text, offsets: { from, to } });
fs.writeFileSync(
  `${base}.json`,
  JSON.stringify({
    result: { language: 'en' },
    transcription: [w(' Hello', 1000, 1300), w(' there', 1300, 1700), w('.', 1700, 1720), w(' Second', 2000, 2400), w(' beep', 2400, 2800), w(' arrives', 2800, 3200), w('.', 3200, 3220)],
  }),
);
