# Satchel – School & Browsing Assistant

Satchel is a Chrome and Microsoft Edge extension (Manifest V3) that lives in the browser's **side panel**. It helps with schoolwork and everyday browsing, and asks for your approval before anything consequential happens.

| Area | What it does |
|---|---|
| **Ask** | Summarize the current page, answer questions grounded in it, compare selected tabs, or research a question across tabs. Answers separate **facts from the page** (with clickable source links and quote checks) from **Satchel's inference**. Pages it couldn't read are listed and never used. |
| **School** | Choose your school website and the pages that list assignments. **Refresh** reads them in background tabs using your signed-in session (no school API needed). You get Overdue / Today / This week / Later / Needs a date views. Missing, unclear, or guessed dates are flagged. You can correct or add assignments, repeated assignments are merged, and each links back to its original page. Optional Google Classroom import. |
| **Tabs** | List, search, group, save, reopen, and close tabs. Understands commands like “close duplicate tabs” and “save these research tabs and close them”. Before any tab closes, it shows the exact tabs, and pinned tabs are only included if you tick them yourself. |
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

| Part | Status |
|---|---|
| Extension UI and logic in Chromium (Ask, School, Tabs, Memory, Settings) | **Tested automatically:** unit tests plus a 27-step browser test on the real extension, run from both the source folder and the release ZIP |
| Companion protocol (`satchel-host.ps1`) | **Tested** under PowerShell 7 on Linux through Chromium native messaging, with a simulated Groq service |
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
  background/         Service worker: opens the side panel and runs school-page refreshes you start
  sidepanel/          Side panel UI (Ask, School, Tabs, Email views)
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
