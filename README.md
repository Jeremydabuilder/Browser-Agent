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

1. Download this repository (**Code → Download ZIP**), right-click the ZIP → **Properties → Unblock**, then extract it, for example to `Documents\Satchel`.
2. **Chrome:** open `chrome://extensions`. **Edge:** open `edge://extensions`. Turn on **Developer mode**, click **Load unpacked**, and select the `extension` folder.
3. Double-click `companion\windows\install.cmd` and paste your Groq API key from <https://console.groq.com/keys>.
4. Restart the browser, click the Satchel toolbar icon (or press **Alt+Shift+S**), and check that the header says **AI: ready**.

## Verification status

"Simulated" below means a local stand-in replaced the real service. "Real" means the actual thing ran.

| Part | Status |
|---|---|
| Extension UI and logic in Chromium (Ask, School, Tabs, Memory, Settings) | **Tested automatically** (Linux, Playwright Chromium): unit tests plus a 36-step browser test on the real extension, run from both the source folder and the release ZIP |
| Meetings: tab recording, one-click (`chrome.tabCapture` after clicking the Satchel icon on the tab) | **Untested.** Automation can't click the toolbar icon. Tests only confirm that Satchel detects Chrome's refusal and offers the picker. The playback that keeps the tab audible in this mode is untested |
| Meetings: tab recording through the browser's tab picker | **Tested on Linux Chromium, simulated picker choice:** headed Chromium under Xvfb records a local test page playing a 440 Hz tone. The saved chunks decode, and their dominant frequency is ~440 Hz. Tests cover 5-minute chunk rotation (10 s in tests), the timer, the REC badge and banner, the page still playing, and stopping when the tab closes. **Not** verified with a real meeting site, on Windows, or in Edge |
| Meetings: microphone | **Simulated** (Chromium's fake microphone). A real microphone, the permission prompt, and the denied-permission path in a real browser are untested |
| Meetings: interruption and recovery | **Tested on Linux Chromium:** closing the recorder window, and SIGKILL of the browser followed by a relaunch, keep the saved audio (at most ~2 s lost) as an "interrupted" meeting with a playable partial chunk |
| Meetings: import | **WAV tested on Linux Chromium.** **Zoom M4A/MP4 untested:** open-source Chromium has no AAC decoder; branded Chrome and Edge do. Live capture of the Zoom desktop app is not supported |
| Meetings: transcription | **Simulated Groq:** the real companion uploads each part as multipart, a failed part is retried alone, parts keep their order, and timestamps are shifted to the meeting timeline. Real Whisper output and Groq audio rate limits are untested |
| Meetings: transcript correction, notes, timestamp links | **Simulated Groq:** the correction UI and the grounding rules are tested (an invented decision is dropped; owners and dates only when stated); the note text came from a fake AI |
| Meetings: export, search, rename, separate deletion, no memory writes | **Tested on Linux Chromium** |
| Companion protocol (`satchel-host.ps1`), including `transcribe` | **Tested** under PowerShell 7 on Linux through Chromium native messaging, with a simulated Groq service (a 10 MB chunk succeeds, 26 MB is rejected) |
| API key never stored in the browser | **Tested:** after the browser test, every file in the Chromium profile and the companion's log folder is scanned for the key |
| Windows installer, registry registration, `.bat` launcher, DPAPI, Windows PowerShell 5.1 | **Not tested** (no Windows machine was available); scripts are parse-checked only |
| Microsoft Edge | **Not tested** |
| A real Groq key and API | **Not tested**; Groq's API was unreachable from the build environment |
| Google sign-in for Gmail read, Gmail send, and Classroom | **Not tested with a real Google account.** The UI and API handling are tested only against simulated Google responses. Sign-in uses Google's implicit flow, which Google discourages; see [docs/GOOGLE-SETUP.md](docs/GOOGLE-SETUP.md) |

## Repository layout

```
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
tests/unit/           Unit tests (extraction, dates, assignments, action validation, memory, AI errors, Google)
tests/companion/      Runs the real companion under PowerShell against a fake Groq server
tests/e2e/            Drives the real extension in Chromium with the real companion
docs/                 Install, Google setup, privacy/security, manual test plan
scripts/              check.mjs (static checks), build.mjs (zips), make-icons.mjs
```

## Development

Requires Node.js 22+. The companion tests and end-to-end tests also need PowerShell 7 (`pwsh`).

```bash
npm install            # dev dependencies only (jsdom, playwright); the extension has no runtime deps
npm run lint           # static checks: manifest refs, imports, syntax, no secrets, no innerHTML/eval
npm test               # unit tests
npm run test:companion # real PowerShell companion over native-messaging framing (fake Groq)
npm run test:e2e       # real extension in Chromium + real companion (fake Groq, simulated Google APIs)
                       # on Linux run it as `xvfb-run -a npm run test:e2e`: tab-audio capture needs a headed
                       # browser (headless still tests recording mechanics but skips the audio-content check)
npm run test:e2e:dist  # same, but from freshly built release ZIPs (fresh-install check)
npm run build          # dist/satchel-extension/, dist/satchel-extension.zip, dist/satchel-companion-windows.zip
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
