'use strict';
// Only a separately verified public JFK fixture is accepted by the smoke driver.
// No client construction/login or recordings; helper output remains bounded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { recognize, command, FFMPEG } = require('../../src/features/local-transcription/recognizer');
async function main() {
  assert.equal(process.env.DISCORD_TOKEN, undefined);
  process.umask(0o077);
  const dir = fs.mkdtempSync(path.join('/data/transcription', 'public-helper-'));
  try {
    const pcm = path.join(dir, 'public.pcm');
    await command(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', '/fixtures/jfk.wav', '-t', '8', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-f', 's16le', pcm], AbortSignal.timeout(15000));
    const bytes = fs.statSync(pcm).size;
    assert.ok(bytes > 0 && bytes <= 8 * 192000 && bytes % 4 === 0);
    const start = Date.now();
    const text = await recognize({ id: randomUUID(), path: pcm, bytes }, { signal: AbortSignal.timeout(65000) });
    assert.match(text, /fellow|americans/i);
    assert.deepEqual(fs.readdirSync(dir), ['public.pcm']);
    assert.equal(fs.statSync(pcm).size, bytes); // Store, not recognizer, owns deletion.
    console.log(JSON.stringify({ kind: 'public_fixture_only', pcmBytes: bytes, helperWallMs: Date.now() - start, text,
      limitation: 'Not private-call accuracy, DAVE receive, sustained multi-speaker capacity, or RK3588 timing evidence.' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(() => { console.error('PUBLIC_HELPER_SMOKE_FAILED_DETAILS_SUPPRESSED'); process.exitCode = 1; });
