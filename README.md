# Satchel – School & Browsing Assistant

Satchel is a Chrome and Microsoft Edge extension (Manifest V3) that lives in the browser's **side panel**. It helps with schoolwork and everyday browsing, and asks for your approval before anything consequential happens.

| Area | What it does |
|---|---|
| **Ask** | Summarize the current page, answer questions grounded in it, compare selected tabs, or research a question across tabs. Answers separate **facts from the page** (with clickable source links and quote checks) from **Satchel's inference**. Pages it couldn't read are listed and never used. |
| **School** | Choose your school website and the pages that list assignments. **Refresh** reads them in background tabs using your signed-in session (no school API needed). You get Overdue / Today / This week / Later / Needs a date views. Missing, unclear, or guessed dates are flagged. You can correct or add assignments, repeated assignments are merged, and each links back to its original page. Optional Google Classroom import. |
| **Tabs** | List, search, group, save, reopen, and close tabs. Understands commands like “close duplicate tabs” and “save these research tabs and close them”. Before any tab closes, it shows the exact tabs, and pinned tabs are only included if you tick them yourself. |
| **Meetings** | Record a meeting running in a Chrome/Edge tab (Meet, Zoom web, Teams web…), optionally with your microphone, or import a recording (e.g. Zoom's `audio_only.m4a`). Audio is saved locally in 5-minute parts and sent to Groq for transcription only after you approve it. Failed parts can be retried alone. Correct the transcript, then generate editable notes (summary, key points, decisions, action items, open questions) with timestamp links back to the transcript. Decisions and action items must quote the transcript, and owners and dates are kept only when stated. Search, rename, export to Markdown or plain text, and delete audio, transcript, and notes separately. It can't record desktop apps (such as the Zoom app) live. |
| **Email** | Separate Gmail connections for *reading* and *sending*. Summarize the threads you pick and draft replies with AI. Before sending, you review the recipients, subject, and full message and confirm each send. |
| **Memory** | Save preferences, projects, and facts on purpose (`/remember …`). A Memory page lets you inspect, edit, export, import, and delete them. Chat history is separate and cleared when the browser closes. |
| **AI** | Uses **your Groq account** through a small **Windows companion**. The API key is stored encrypted with Windows DPAPI and never enters the extension, browser storage, logs, or Git. The model list comes live from Groq, so you can choose any available model. Rate limits, timeouts, retired models, and long pages are handled. |

**➡ Installing on Windows (no programming needed): [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md)**

Other docs: [Google setup](docs/GOOGLE-SETUP.md) · [Privacy & security design](docs/PRIVACY-AND-SECURITY.md) · [Manual test plan for Chrome and Edge](docs/MANUAL-TESTS.md)

## Quick start

Satchel is a Chrome/Edge **sidebar**; there's no separate desktop app to open.

1. Download this repository (**Code → Download ZIP**) and run **`release\SatchelSetup.exe`** (per-user, no admin; if SmartScreen warns, **More info → Run anyway**). It installs the companion and the extension files, registers the companion with Chrome and Edge, and adds Start menu shortcuts.
2. On its last page, keep **Add my Groq key now** ticked and paste your key from <https://console.groq.com/keys>. It is saved encrypted for your Windows account.
3. Follow the guide it opens: in `edge://extensions` or `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `%LOCALAPPDATA%\Satchel\extension`.
4. Restart the browser, click the Satchel toolbar icon (or press **Alt+Shift+S**), and check that the header says **AI: ready · Groq**. If anything is missing, a setup card at the top of the sidebar lists the exact steps. The AI works without starting anything.
5. Optional: add an OpenAI key (Start menu → **Satchel - Set OpenAI key**) and choose OpenAI for chat/notes or transcription in Settings. Satchel shows an estimated cost before each OpenAI request and has a local monthly spending guard (an app-side estimate, not an OpenAI billing limit).

Full guide: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md). Without the installer, `companion\windows\install.cmd` does the same companion setup.

## Verification status

"Simulated" below means a local stand-in replaced the real service. "Real" means the actual thing ran.

| Part | Status |
|---|---|
| Extension UI and logic (Ask, School, Tabs, Memory, Settings, setup card, actionable errors, remembered sidebar state, activity strip and badge) | **Tested automatically** on Linux: unit tests plus a 41-step browser test on the real extension in Playwright Chromium (from the source folder, the release ZIP, and the files installed by `SatchelSetup.exe`) and in **Microsoft Edge 154 for Linux** |
| Meetings: tab recording, one-click (`chrome.tabCapture` after clicking the Satchel icon on the tab) | **Untested.** Automation can't click the toolbar icon. Tests only confirm that Satchel detects Chrome's refusal and offers the picker. The playback that keeps the tab audible in this mode is untested |
| Meetings: tab recording through the browser's tab picker | **Tested on Linux Chromium, simulated picker choice:** headed Chromium under Xvfb records a local test page playing a 440 Hz tone. The saved chunks decode, and their dominant frequency is ~440 Hz. Tests cover 5-minute chunk rotation (10 s in tests), the timer, the REC badge and banner, the page still playing, and stopping when the tab closes. **Not** verified with a real meeting site, on Windows, or in Edge |
| Meetings: microphone | **Simulated** (Chromium's fake microphone). A real microphone, the permission prompt, and the denied-permission path in a real browser are untested |
| Meetings: interruption and recovery | **Tested on Linux Chromium:** closing the recorder window, and SIGKILL of the browser followed by a relaunch, keep the saved audio (at most ~2 s lost) as an "interrupted" meeting with a playable partial chunk |
| Meetings: import | **WAV tested on Linux Chromium and Edge.** **Zoom-style M4A/MP4 (AAC) tested in Edge 154 for Linux** with generated files (`audio_only.m4a`, `zoom_0.mp4`): split into parts at the right times and transcribed in order. **No real Zoom recording yet**, and not on Windows. Open-source Chromium has no AAC decoder, so that step is skipped there. Live capture of the Zoom desktop app is not supported |
| Meetings: transcription | **Simulated Groq (browser test) and simulated OpenAI (unit and companion tests):** the real companion uploads each part as multipart, a failed part is retried alone, parts keep their order, timestamps are shifted to the meeting timeline, and the job keeps running in the service worker when the side panel closes. Real Whisper / OpenAI output and real rate limits are untested |
| Meetings: transcript correction, notes, timestamp links | **Simulated Groq:** the correction UI and the grounding rules are tested (an invented decision is dropped; owners and dates only when stated); the note text came from a fake AI |
| Meetings: export, search, rename, separate deletion, no memory writes | **Tested on Linux Chromium** |
| Companion protocol (`satchel-host.ps1`), including `transcribe` | **Tested** under PowerShell 7 on Linux through Chromium native messaging, with a simulated Groq service (a 10 MB chunk succeeds, 26 MB is rejected) |
| API key never stored in the browser | **Tested:** after the browser test, every file in the Chromium profile and the companion's log folder is scanned for the key |
| `SatchelSetup.exe` (NSIS, per-user) | **Tested under Wine on Linux, not on Windows:** the real 32-bit installer's silent install, installed files, native messaging manifest, Chrome and Edge `HKCU` registry entries, Start menu shortcuts, Settings > Apps entry, upgrade (stale files removed, keys kept) and silent uninstall (keys kept). The browser test then passed using the extension folder and companion scripts it installed. **Untested on real Windows:** its pages when double-clicked, SmartScreen, the Finish-page key window and setup guide, and Chrome/Edge on Windows reading the registry entries |
| `install.cmd`, `.bat` launcher, DPAPI (both keys), Windows PowerShell 5.1 | **Not tested** (no Windows machine was available); scripts are parse-checked only |
| Microsoft Edge | **Tested on Linux** (Edge 154, all 39 browser steps including real tab-audio capture). Edge and Chrome on Windows are **not tested** |
| OpenAI as an optional provider (chat/notes and transcription, separately) | **Simulated only:** unit tests cover model filtering, `whisper-1` vs `gpt-4o-mini-transcribe` formats, unsupported-parameter retries, quota (`insufficient_quota`), bad or missing key, and cost recording; companion tests confirm OpenAI requests go to the OpenAI endpoint with the OpenAI key and never reach Groq. **No real OpenAI request has been made** |
| Cost estimates and OpenAI spending guard | **Tested with simulated responses** (the guard blocks before a request; Groq is never blocked; $0 blocks all OpenAI requests). It's an app-side estimate from an editable price table, not billing data; real charges are **untested** |
| A real Groq key and API | **Not tested**; no real Groq request has been made from the build environment |
| Google sign-in for Gmail read, Gmail send, and Classroom | **Not tested with a real Google account.** The UI and API handling are tested only against simulated Google responses. Sign-in uses Google's implicit flow, which Google discourages; see [docs/GOOGLE-SETUP.md](docs/GOOGLE-SETUP.md) |

## Repository layout

```
release/SatchelSetup.exe   The Windows installer users download (built by `npm run build`; lint fails if it is out of date)
extension/            The browser extension (load this folder unpacked; no build step needed)
  manifest.json       MV3 manifest with a fixed public key, so the extension ID is always
                      enhkjfoecodefiigkephlalmoebbfgmb in both Chrome and Edge
  background/         Service worker: side panel, school refreshes you start, REC badge, recording recovery
  sidepanel/          Side panel UI (Ask, School, Tabs, Meetings, Email views)
  meetings/           Recorder window (visible while recording: timer, sources, Stop)
  options/            Settings page (companion test, model choice, privacy, Google setup)
  memory/             Memory page (inspect / edit / export / import / delete)
  lib/                Modules: AI client, extractors, date parser, assignments, action validator,
                      tabs, memory, Gmail, Classroom, Google auth, prompts, UI helpers
companion/windows/    Windows companion: native messaging host (PowerShell) + install scripts
  installer/          SatchelSetup.exe source (NSIS script) and the offline "add the extension" guide
tests/unit/           Unit tests (extraction, dates, assignments, action validation, memory, AI errors, Google)
tests/companion/      Runs the real companion under PowerShell against a fake Groq server
tests/e2e/            Drives the real extension in Chromium or Edge with the real companion
tests/installer/      Runs SatchelSetup.exe under Wine: install, registry, shortcuts, upgrade, uninstall
docs/                 Install, Google setup, privacy/security, manual test plan
scripts/              check.mjs (static checks), build.mjs (zips + installer), installer-inputs.mjs, make-icons.mjs
```

## Development

Requires Node.js 22+. The companion tests and end-to-end tests also need PowerShell 7 (`pwsh`). Building the installer needs NSIS (`makensis`, e.g. `apt install nsis` or `choco install nsis`); testing it on Linux also needs Wine with 32-bit support (`apt install wine wine32:i386`).

```bash
npm install            # dev dependencies only (jsdom, playwright); the extension has no runtime deps
npm run lint           # static checks: manifest refs, imports, syntax, no secrets, no innerHTML/eval
npm test               # unit tests
npm run test:companion # real PowerShell companion over native-messaging framing (fake Groq)
npm run test:e2e       # real extension in Chromium + real companion (fake Groq, simulated Google APIs)
                       # on Linux run it as `xvfb-run -a npm run test:e2e`: tab-audio capture needs a headed
                       # browser (headless still tests recording mechanics but skips the audio-content check)
npm run test:e2e:dist  # same, but from freshly built release ZIPs (fresh-install check)
npm run test:e2e:installer  # same, using the files SatchelSetup.exe installs (runs it under Wine)
npm run test:installer # SatchelSetup.exe under Wine: files, registry, shortcuts, upgrade, uninstall
npm run build          # dist/ zips + dist/SatchelSetup.exe, and refreshes release/SatchelSetup.exe (commit it)
```

The end-to-end test loads the real extension into Chromium, registers the real PowerShell companion as a native messaging host, and drives the side panel through every feature area: summarize, compare, chat, school refresh, corrections, tab commands, saving and reopening tabs, Gmail review and send, Classroom import, memory, settings, and rate-limit handling. Groq is replaced by a local OpenAI-compatible fake, and Google APIs by canned HTTP responses, because a test can't use your real accounts. Screenshots are written to `tests/e2e/.artifacts/`.

## How it works (short)

```
Side panel (extension page) ──chrome.runtime.sendNativeMessage──▶ satchel-host.bat → satchel-host.ps1
        │                                                           │  reads the DPAPI-encrypted key
        │  chrome.scripting (read-only extractors)                  └──HTTPS──▶ api.groq.com
        ▼
   Web pages you choose        Google APIs (Gmail / Classroom) ◀── OAuth token (session memory only)
```

* The companion is a **native messaging host**. Chrome or Edge starts it on demand, so there is nothing to launch at login. It opens no network port, and only Satchel's extension ID may call it.
* Page and email text is wrapped as *untrusted data* in prompts. AI output is rendered as text, never HTML. Tab actions proposed by the AI must pass an allowlist validator (`extension/lib/actions.js`) and a confirmation screen. Sending email and submitting forms are not AI actions at all: Satchel never submits forms, and email is sent only from the review screen.
