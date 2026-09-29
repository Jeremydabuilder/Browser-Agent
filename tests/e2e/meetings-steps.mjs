// End-to-end checks for the Meetings feature, run inside the real extension (see run-e2e.mjs).
// Real: the extension, IndexedDB storage, the recorder window, getDisplayMedia tab-audio capture of a
// local page playing a 440 Hz tone, MediaRecorder chunking, the PowerShell companion's multipart
// upload, recovery after a closed recorder window and after a browser restart.
// Simulated: Groq speech-to-text and notes (tests/support/fake-groq.mjs), the browser's tab picker
// (auto-selected with a Chromium test flag), and the microphone (Chromium's fake device).
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { toneWav } from '../support/fixture-server.mjs';

export async function runMeetingSteps(env) {
  const { step, extId, site, groq, launch, work, artifacts, headless, clickModalButton, userData } = env;
  let { context, sw, panel } = env;
  const storage = (area, key) => sw.evaluate(async ([a, k]) => (await chrome.storage[a].get(k))[k], [area, key]);
  const setSettings = (patch) => sw.evaluate(async (p) => { const s = (await chrome.storage.local.get('settings')).settings || {}; await chrome.storage.local.set({ settings: { ...s, ...p } }); }, patch);
  const showMeetings = async () => { await panel.click('.tabs button[data-view="ask"]'); await panel.click('.tabs button[data-view="meetings"]'); };
  // Reads meetings/chunks straight from IndexedDB inside the extension (no eval: the extension CSP forbids it).
  const meetingsList = () => panel.evaluate(async () => {
    const s = await import(chrome.runtime.getURL('lib/meeting-store.js'));
    return (await s.listMeetings()).map((m) => ({ id: m.id, title: m.title, status: m.status, stopReason: m.stopReason, durationSec: m.durationSec, notes: !!m.notes }));
  });
  const chunksOf = (id) => panel.evaluate(async (mid) => {
    const s = await import(chrome.runtime.getURL('lib/meeting-store.js'));
    return (await s.listChunks(mid)).map((c) => ({ index: c.index, startSec: c.startSec, durationSec: c.durationSec, status: c.status, hasAudio: c.hasAudio, size: c.size, partial: !!c.partial, error: c.error || '', text: c.transcript?.text || '' }));
  }, id);
  const notesOwner = (id) => panel.evaluate(async (mid) => {
    const s = await import(chrome.runtime.getURL('lib/meeting-store.js'));
    return (await s.getMeeting(mid)).notes.actionItems[0].owner;
  }, id);
  // Decodes each saved chunk and measures loudness + dominant frequency.
  const analyzeChunks = (id) => panel.evaluate(async (mid) => {
    const s = await import(chrome.runtime.getURL('lib/meeting-store.js'));
    const out = [];
    for (const c of await s.listChunks(mid)) {
      try {
        const buf = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await c.data.arrayBuffer());
        const d = buf.getChannelData(0);
        let sum = 0; let zc = 0;
        for (let i = 1; i < d.length; i++) { sum += d[i] * d[i]; if ((d[i - 1] < 0) !== (d[i] < 0)) zc++; }
        out.push({ index: c.index, decodedSec: +buf.duration.toFixed(1), rms: +Math.sqrt(sum / d.length).toFixed(3), hz: Math.round(zc / 2 / buf.duration) });
      } catch (e) { out.push({ index: c.index, error: e.message }); }
    }
    return out;
  }, id);
  const memoriesBefore = (await storage('local', 'memories'))?.length || 0;
  let importedId;

  // ------------------------------------------------------------------ import
  await step('Meetings: import a local audio fixture; parts are stored locally and nothing is sent yet', async () => {
    await setSettings({ importChunkSec: 12, meetingSegmentSec: 10, model: 'auto' });
    await sw.evaluate(() => chrome.storage.local.remove('modelCache'));
    const file = path.join(work, 'robotics-club.wav');
    writeFileSync(file, toneWav(36, [300, 500, 700])); // three 12-second "speakers"
    const before = groq.log.transcriptions?.length || 0;
    await showMeetings();
    await panel.locator('#view-meetings summary', { hasText: 'Import a recording' }).click();
    assert.match(await panel.textContent('#view-meetings'), /M4A \(Zoom “audio only” recording\)/);
    assert.match(await panel.textContent('#view-meetings'), /Limits: up to 300\.0 MB and 2 hours/);
    await panel.setInputFiles('#view-meetings input[type=file]', file);
    await panel.fill('#view-meetings input[placeholder^="Title (defaults"]', 'Robotics club');
    await panel.locator('#view-meetings').getByRole('button', { name: 'Import', exact: true }).click();
    await panel.locator('#view-meetings .title-input').waitFor({ timeout: 30000 });
    const list = await meetingsList();
    importedId = list.find((m) => m.title === 'Robotics club').id;
    const chunks = await chunksOf(importedId);
    assert.deepEqual(chunks.map((c) => [c.index, c.startSec, c.durationSec, c.status]), [[0, 0, 12, 'pending'], [1, 12, 12, 'pending'], [2, 24, 12, 'pending']]);
    assert.equal(groq.log.transcriptions?.length || 0, before, 'no audio sent before approval');
    assert.equal((await panel.locator('#view-meetings .parts li').count()), 3);
  });

  await step('Meetings: transcription asks first, a failed part is retried alone, order and timestamps kept', async () => {
    groq.control.failNextTranscriptions = 1;
    const before = groq.log.transcriptions?.length || 0;
    await panel.click('#view-meetings button:has-text("Transcribe with Groq")');
    await panel.locator('.overlay .modal-title', { hasText: 'Send audio to Groq?' }).waitFor();
    assert.match(await panel.textContent('.overlay'), /3 audio part\(s\)/);
    await clickModalButton(panel, 'Send audio to Groq');
    await panel.locator('#mtg-status', { hasText: '2 part(s) transcribed, 1 failed' }).waitFor({ timeout: 60000 });
    let chunks = await chunksOf(importedId);
    assert.deepEqual(chunks.map((c) => c.status), ['failed', 'done', 'done']);
    await panel.click('#view-meetings button:has-text("Retry failed parts")');
    await clickModalButton(panel, 'Send audio to Groq');
    await panel.locator('#mtg-status', { hasText: 'Transcribed 1 part(s)' }).waitFor({ timeout: 60000 });
    const sent = groq.log.transcriptions.slice(before);
    assert.deepEqual(sent.map((t) => t.filename), ['part-1.wav', 'part-2.wav', 'part-3.wav', 'part-1.wav'], 'only the failed part was re-sent');
    assert.ok(sent.every((t) => t.response_format === 'verbose_json' && t.type === 'audio/wav' && /^whisper-large-v3-turbo$/.test(t.model)));
    chunks = await chunksOf(importedId);
    assert.match(chunks[0].text, /robotics club/);
    assert.match(chunks[1].text, /demo day/);
    assert.match(chunks[2].text, /slides/);
    const stamps = await panel.locator('#view-meetings .seg .ts').allTextContents();
    assert.deepEqual(stamps.slice(0, 3), ['00:00', '00:06', '00:12'], 'timestamps shifted to the meeting timeline');
  });

  await step('Meetings: transcript is corrected before notes; notes are grounded and editable', async () => {
    const line = panel.locator('#view-meetings .seg textarea').nth(2);
    assert.match(await line.inputValue(), /move demo day/);
    await line.fill('Bob: I think we should move demo day to the spring.');
    await line.blur();
    await panel.waitForTimeout(300);
    const before = groq.log.length;
    await panel.click('#view-meetings button:has-text("I reviewed the transcript: generate notes")');
    await panel.locator('.overlay .modal-title', { hasText: 'Send the transcript to Groq?' }).waitFor();
    assert.match(await panel.textContent('.overlay'), /Nothing is added to Satchel's memory/);
    await clickModalButton(panel, 'Send transcript to Groq');
    await panel.locator('#notes-card h4', { hasText: 'Decisions' }).waitFor({ timeout: 60000 });
    const req = JSON.parse(groq.log.slice(before).find((l) => l.url === '/chat/completions').body);
    assert.match(req.messages[1].content, /move demo day to the spring/, 'notes use the corrected transcript');
    const notesText = await panel.locator('#notes-card').evaluate((el) => [...el.querySelectorAll('input, textarea')].map((i) => i.value).join(' | ') + el.textContent);
    assert.match(notesText, /we agreed to move demo day to October 12/);
    assert.match(notesText, /send the slides/);
    assert.match(notesText, /Priya/);
    assert.match(notesText, /Do we still need the gym\?/);
    assert.match(notesText, /Due date “Friday” read as/);
    assert.match(notesText, /1 AI suggestion\(s\) left out/);
    assert.doesNotMatch(await panel.locator('#notes-card .note-item').allTextContents().then((t) => t.join(' ')), /cancel the field trip/i);
    await panel.locator('#notes-card .ts-link').first().click();
    await panel.locator('#view-meetings .seg.hl').waitFor();
    const owner = panel.locator('#notes-card input[placeholder^="Owner"]').first();
    await owner.fill('Priya S.');
    await owner.blur();
    await panel.waitForTimeout(300);
    const stored = await notesOwner(importedId);
    assert.equal(stored, 'Priya S.');
    await panel.screenshot({ path: path.join(artifacts, '09-meeting-notes.png'), fullPage: true });
  });

  await step('Meetings: export Markdown and plain text, search, rename', async () => {
    const [md] = await Promise.all([panel.waitForEvent('download'), panel.click('#view-meetings button:has-text("Export everything .md")')]);
    const mdText = readFileSync(await md.path(), 'utf8');
    writeFileSync(path.join(artifacts, 'meeting-export.md'), mdText);
    assert.match(mdText, /^# Robotics club/);
    assert.match(mdText, /## Decisions\n\n- .*October 12\. \(\[00:18\]\(#t-c1s1\)\)/);
    assert.match(mdText, /<a id="t-c1s1"><\/a>/);
    assert.match(mdText, /Owner:\*\* Priya S\./);
    const [txt] = await Promise.all([panel.waitForEvent('download'), panel.click('#view-meetings button:has-text("Export notes .txt")')]);
    const txtText = readFileSync(await txt.path(), 'utf8');
    assert.match(txtText, /ACTION ITEMS\n {2}- send the slides \| Owner: Priya S\. \| Due: Friday/);
    assert.match(txt.suggestedFilename(), /\.txt$/);
    await panel.fill('#view-meetings .title-input', 'Robotics club – week 5');
    await panel.press('#view-meetings .title-input', 'Enter');
    await panel.locator('#view-meetings .title-input').blur();
    await panel.waitForTimeout(300);
    await panel.click('#view-meetings button:has-text("All meetings")');
    await panel.locator('#view-meetings h3', { hasText: 'Your meetings' }).waitFor();
    await panel.fill('#view-meetings input[aria-label="Search meetings"]', 'gym');
    await panel.locator('#view-meetings .mtg-row', { hasText: /notes: .*gym/ }).waitFor();
    assert.match(await panel.locator('#view-meetings .mtg-row').first().textContent(), /Robotics club – week 5/);
    await panel.fill('#view-meetings input[aria-label="Search meetings"]', 'fundraiser');
    await panel.locator('#view-meetings .mtg-row', { hasText: /(notes|transcript): .*fundraiser/ }).waitFor();
    await panel.fill('#view-meetings input[aria-label="Search meetings"]', 'zebra');
    await panel.locator('#view-meetings', { hasText: 'No meetings match.' }).waitFor();
    await panel.fill('#view-meetings input[aria-label="Search meetings"]', '');
  });

  await step('Meetings: raw audio, transcript and notes are deleted separately; memory untouched', async () => {
    await panel.locator('#view-meetings .mtg-row', { hasText: 'Robotics club' }).click();
    await panel.click('#view-meetings button:has-text("Delete raw audio")');
    await clickModalButton(panel, 'Delete audio');
    await panel.locator('#view-meetings h3', { hasText: '1. Audio · deleted' }).waitFor();
    let chunks = await chunksOf(importedId);
    assert.ok(chunks.every((c) => !c.hasAudio && c.text), 'audio gone, transcript kept');
    await panel.click('#view-meetings button:has-text("Delete notes")');
    await clickModalButton(panel, 'Delete notes');
    await panel.locator('#notes-card', { hasText: 'Notes appear here' }).waitFor();
    assert.ok((await panel.locator('#view-meetings .seg textarea').count()) > 0, 'transcript still there');
    await panel.click('#view-meetings button:has-text("Delete transcript")');
    await clickModalButton(panel, 'Delete transcript');
    await panel.locator('#transcript-card', { hasText: 'No transcript yet' }).waitFor();
    chunks = await chunksOf(importedId);
    assert.ok(chunks.every((c) => !c.text));
    assert.equal((await storage('local', 'memories'))?.length || 0, memoriesBefore, 'no meeting content was added to memory');
    await panel.click('#view-meetings button:has-text("Delete meeting")');
    await clickModalButton(panel, 'Delete meeting');
    await panel.locator('#view-meetings h3', { hasText: 'Your meetings' }).waitFor();
    assert.equal((await meetingsList()).some((m) => m.id === importedId), false);
  });

  // ------------------------------------------------------------------ recording
  const fixture = await context.newPage();
  await fixture.goto(`${site.url}/meeting`);
  await fixture.waitForTimeout(500);

  async function startPickerRecording({ mic = false, title = 'Recorded meeting' } = {}) {
    await fixture.bringToFront();
    await showMeetings();
    await panel.locator('#view-meetings summary', { hasText: 'Record a meeting' }).waitFor();
    await panel.locator('#view-meetings .card', { hasText: 'Meeting Fixture' }).first().waitFor({ timeout: 10000 });
    await panel.fill('#view-meetings input[aria-label="New recording title"]', title);
    if (mic) await panel.check('#mtg-mic');
    await panel.click('#view-meetings button:has-text("Start recording")');
    const consentToast = await panel.locator('#toast.show', { hasText: 'confirm you have told participants' }).isVisible().catch(() => false);
    assert.equal(consentToast, true, 'Start refuses without the consent reminder being confirmed');
    await panel.check('#mtg-consent');
    await panel.click('#view-meetings button:has-text("Start recording")');
    // Without a toolbar click on the tab, Chrome refuses tabCapture -> Satchel explains and offers the picker.
    await panel.locator('#view-meetings', { hasText: 'Chrome needs one more step' }).waitFor({ timeout: 10000 });
    const recPromise = context.waitForEvent('page', (p) => p.url().includes('recorder.html'));
    await panel.click('#view-meetings button:has-text("Use the tab picker instead")');
    const rec = await recPromise;
    await rec.waitForLoadState('domcontentloaded');
    await rec.click('#choose-btn');
    await rec.locator('#state-label', { hasText: 'Recording' }).waitFor({ timeout: 15000 });
    return rec;
  }

  await step('Meetings: record a meeting tab with microphone; timer, REC indicators, meeting stays audible, chunks rotate', async () => {
    assert.equal((await meetingsList()).length, 0, 'nothing recorded before Start');
    const rec = await startPickerRecording({ mic: true, title: 'Tab recording test' });
    const sources = await rec.textContent('#sources');
    assert.match(sources, /Audio of the meeting tab/);
    assert.match(sources, /Your microphone/);
    assert.match(sources, /Not captured: other tabs, other apps/);
    assert.equal(await rec.locator('#close').isHidden(), true, 'no "Close window" button while recording');
    assert.equal(await rec.locator('#stop').isVisible(), true);
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), 'REC');
    await panel.locator('#view-meetings .rec-banner', { hasText: 'Recording' }).waitFor({ timeout: 5000 });
    assert.equal(await fixture.evaluate(() => !document.getElementById('a').paused && !document.getElementById('a').muted), true, 'meeting audio keeps playing');
    await rec.waitForTimeout(23000);
    assert.match(await rec.textContent('#timer'), /^00:2\d$/);
    assert.match(await rec.title(), /● REC/);
    await rec.screenshot({ path: path.join(artifacts, '10-recorder.png') });
    await panel.click('#view-meetings .rec-banner button:has-text("Stop")');
    await rec.locator('#state-label', { hasText: 'Saved' }).waitFor({ timeout: 15000 });
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '');
    const all = await meetingsList();
    const m = all.find((x) => x.title === 'Tab recording test');
    assert.ok(m, `meeting 'Tab recording test' not found; meetings: ${JSON.stringify(all.map((x) => [x.title, x.status]))}`);
    assert.equal(m.status, 'recorded');
    const chunks = await chunksOf(m.id);
    assert.ok(chunks.length >= 2, `rotated into ${chunks.length} standalone chunks`);
    assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
    for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].startSec >= chunks[i - 1].startSec + 9, 'chunk start times increase');
    const analysis = await analyzeChunks(m.id);
    assert.ok(analysis.every((a) => !a.error && a.decodedSec > 1), `every chunk decodes on its own: ${JSON.stringify(analysis)}`);
    if (!headless) {
      assert.ok(analysis.every((a) => a.rms > 0.02), `captured real tab audio: ${JSON.stringify(analysis)}`);
      assert.ok(analysis.some((a) => Math.abs(a.hz - 440) < 60), `dominant frequency is the meeting's 440 Hz tone: ${JSON.stringify(analysis)}`);
    }
    await rec.close();
    // The recording can be transcribed like an import (simulated Groq).
    await panel.locator('#view-meetings .mtg-row', { hasText: 'Tab recording test' }).click();
    await panel.click('#view-meetings button:has-text("Transcribe with Groq")');
    await clickModalButton(panel, 'Send audio to Groq');
    await panel.locator('#mtg-status', { hasText: `Transcribed ${chunks.length} part(s)` }).waitFor({ timeout: 60000 });
    const up = groq.log.transcriptions.slice(-chunks.length);
    assert.ok(up.every((t) => t.type === 'audio/webm' && /^part-\d\.webm$/.test(t.filename) && t.bytes > 1000));
    await panel.click('#view-meetings button:has-text("All meetings")');
  });

  await step('Meetings: closing the meeting tab stops recording and keeps the audio', async () => {
    const rec = await startPickerRecording({ title: 'Tab closed test' });
    await rec.waitForTimeout(5000);
    await fixture.close();
    await rec.locator('#state-label', { hasText: 'Saved' }).waitFor({ timeout: 15000 });
    assert.match(await rec.textContent('#saved'), /meeting tab was closed/);
    const all = await meetingsList();
    const m = all.find((x) => x.title === 'Tab closed test');
    assert.ok(m, `meeting 'Tab closed test' not found; meetings: ${JSON.stringify(all.map((x) => [x.title, x.status]))}`);
    assert.deepEqual([m.status, m.stopReason], ['recorded', 'tab_closed']);
    assert.ok((await chunksOf(m.id)).length >= 1);
    await rec.close();
  });

  const fixture2 = await context.newPage();
  await fixture2.goto(`${site.url}/meeting`);

  await step('Meetings: closing the recorder window mid-recording keeps the saved audio as "interrupted"', async () => {
    await fixture2.bringToFront();
    const rec = await startPickerRecordingOn(fixture2, 'Window closed test');
    await rec.waitForTimeout(7000);
    await rec.close({ runBeforeUnload: false });
    const deadline = Date.now() + 15000;
    let m;
    while (Date.now() < deadline) {
      m = (await meetingsList()).find((x) => x.title === 'Window closed test');
      if (m.status !== 'recording') break;
      await panel.waitForTimeout(500);
    }
    assert.deepEqual([m.status, m.stopReason], ['interrupted', 'interrupted']);
    const chunks = await chunksOf(m.id);
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].partial && chunks[0].durationSec >= 4, JSON.stringify(chunks));
    const [a] = await analyzeChunks(m.id);
    assert.ok(!a.error && a.decodedSec >= 3, `partial chunk is playable: ${JSON.stringify(a)}`);
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '');
    await showMeetings();
    assert.match(await panel.locator('#view-meetings .mtg-row', { hasText: 'Window closed test' }).textContent(), /interrupted – audio kept/);
  });

  async function startPickerRecordingOn(page, title) {
    await page.bringToFront();
    await showMeetings();
    await panel.locator('#view-meetings .card', { hasText: 'Meeting Fixture' }).first().waitFor({ timeout: 10000 });
    await panel.fill('#view-meetings input[aria-label="New recording title"]', title);
    await panel.check('#mtg-consent');
    await panel.evaluate(() => document.getElementById('toast')?.classList.remove('show')); // clear toasts from earlier steps
    await panel.click('#view-meetings button:has-text("Start recording")');
    await panel.locator('#view-meetings button:has-text("Use the tab picker instead"), #toast.show').first().waitFor({ timeout: 10000 });
    if (await panel.locator('#toast.show').isVisible()) throw new Error(`Start showed: ${await panel.textContent('#toast')}`);
    const recPromise = context.waitForEvent('page', (p) => p.url().includes('recorder.html'));
    await panel.click('#view-meetings button:has-text("Use the tab picker instead")');
    const rec = await recPromise;
    await rec.waitForLoadState('domcontentloaded');
    await rec.click('#choose-btn');
    await rec.locator('#state-label', { hasText: 'Recording' }).waitFor({ timeout: 15000 });
    return rec;
  }

  await step('Meetings: a browser crash mid-recording keeps the saved audio (recovered on next start)', async () => {
    await startPickerRecordingOn(fixture2, 'Restart test');
    await panel.waitForTimeout(7000);
    // Kill the browser without any chance to save (a normal quit closes the meeting tab first, which the
    // recorder handles by saving gracefully; a crash or power loss does not).
    const killed = spawnSync('pkill', ['-9', '-f', `user-data-dir=${userData}`]);
    assert.equal(killed.status, 0, 'browser process was killed');
    await context.close().catch(() => {});
    context = await launch();
    env.watchConsole?.(context);
    sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const pagePromise = context.waitForEvent('page', (p) => p.url().includes('sidepanel.html'));
    await sw.evaluate((url) => chrome.windows.create({ url, type: 'popup', width: 420, height: 900 }), `chrome-extension://${extId}/sidepanel/sidepanel.html`);
    panel = await pagePromise;
    await panel.waitForLoadState('domcontentloaded');
    await showMeetings();
    const deadline = Date.now() + 40000;
    let m;
    while (Date.now() < deadline) {
      m = (await meetingsList()).find((x) => x.title === 'Restart test');
      if (m && m.status !== 'recording') break;
      await panel.waitForTimeout(1000);
      if (Date.now() > deadline - 30000) await showMeetings();
    }
    assert.deepEqual([m.status, m.stopReason], ['interrupted', 'interrupted']);
    const chunks = await chunksOf(m.id);
    assert.ok(chunks.length === 1 && chunks[0].partial && chunks[0].durationSec >= 4, JSON.stringify(chunks));
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '');
  });

  return { context, sw, panel };
}
