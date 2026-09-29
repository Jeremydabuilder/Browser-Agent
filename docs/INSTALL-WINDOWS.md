# Installing and using Satchel on Windows

This guide assumes no programming experience. It takes about 10 minutes, plus about 10 more if you want Gmail or Google Classroom.

You need:
* Windows 10 or 11
* Google Chrome (version 116 or newer) and/or Microsoft Edge (version 116 or newer)
* A free Groq account for the AI: <https://console.groq.com>
* Optional: an OpenAI account with billing, if you want to use OpenAI for chat/notes or transcription

> **What has been tested so far (please read).** Satchel was tested on Linux in Chromium and in Microsoft Edge 154 for Linux, with the companion running under PowerShell 7 and **simulated** Groq and OpenAI services. **None of the following has been tried yet:** the Windows installer (`install.cmd`, registry registration, Start menu shortcuts, the `.bat` launcher, DPAPI key encryption, Windows PowerShell 5.1), Chrome or Edge on Windows, a real Groq key or a real OpenAI key (chat or speech-to-text, and therefore real costs), real Google sign-in for Gmail and Classroom, one-click meeting-tab capture after clicking the Satchel icon, and importing a real Zoom recording (a generated Zoom-style M4A/MP4 was imported in Linux Edge). This guide describes how those parts are designed to work. If a step behaves differently, run Start menu → Satchel - Check companion (or `status.cmd`) and note the exact message. [MANUAL-TESTS.md](MANUAL-TESTS.md) is the checklist for confirming each part.

---

## 1. Download Satchel

1. On the GitHub page for this repository, click **Code → Download ZIP**. (If you were given the built files instead, use `satchel-extension.zip` and `satchel-companion-windows.zip`.)
2. In your Downloads folder, **right-click the ZIP → Properties**. If there's an **Unblock** checkbox at the bottom, tick it and click **OK**. This stops Windows from blocking the setup scripts.
3. Right-click the ZIP → **Extract All…** and pick a permanent place, for example `C:\Users\<you>\Documents\Satchel`.
   *Don't delete this folder later.* The browser loads the extension from it.

## 2. Add the extension to your browser

**Google Chrome**
1. Type `chrome://extensions` in the address bar and press Enter.
2. Turn on **Developer mode** (top-right switch).
3. Click **Load unpacked** and select the **`extension`** folder inside your Satchel folder. (If you downloaded the built zip, select the `satchel-extension` folder.)
4. Click the puzzle-piece icon in the toolbar and **pin** Satchel so its icon stays visible.

**Microsoft Edge**
1. Type `edge://extensions` in the address bar and press Enter.
2. Turn on **Developer mode** (left side, near the bottom).
3. Click **Load unpacked** and select the same **`extension`** folder.
4. Click the puzzle-piece icon and click the eye icon next to Satchel to show it in the toolbar.

Both browsers show Satchel's ID as `enhkjfoecodefiigkephlalmoebbfgmb`. If a different ID appears, you loaded the wrong folder.

> Edge may occasionally show a banner saying developer-mode extensions are on. That's normal for extensions you load yourself; you can dismiss it.
> **School-managed computers or browser profiles** may not allow Developer mode or unpacked extensions. If the switch is greyed out, use a personal browser profile or computer.

## 3. Get your Groq API key

1. Go to <https://console.groq.com/keys> and sign in (Google sign-in works).
2. Click **Create API Key**, give it a name like `Satchel`, and **copy** the key (it starts with `gsk_`).
   Keep it private, like a password. You'll paste it into the companion in the next step, and nowhere else.

## 4. Install the Satchel companion (stores your key securely)

The companion is a small helper that lets the extension use Groq without the key ever being inside the browser.

1. Open your Satchel folder → **companion** → **windows**.
2. Double-click **`install.cmd`**.
   * If Windows shows **“Windows protected your PC”**, click **More info → Run anyway**.
3. When it asks for the key, **paste it** (right-click or Ctrl+V; the characters are hidden on purpose) and press **Enter**.
4. It checks the key with Groq and saves it **encrypted for your Windows account** (Windows DPAPI). You'll see “Key verified and saved”.
5. It then asks whether you also want to add an **OpenAI key**. This is optional: press **Enter** to skip (you can add one later, see [Optional: OpenAI](#optional-use-openai-for-some-tasks)).
6. **Close every Chrome/Edge window and reopen the browser** (needed once so the browser finds the companion).

There's nothing to start at login: the browser launches the companion automatically when Satchel needs it, and it closes again after each request.

**Check it:** click the Satchel icon. The header should say **AI: ready · Groq** (green).
If something is missing, a **setup card** at the top of the side panel says exactly what to do (for example “Install the Satchel companion” with the three steps, or “Add your Groq key”), with a **Check again** button. Pages, tabs and memory keep working while AI is not set up. For details, open ⚙️ Settings → **Companion** and press **Test connection**: it shows which keys are stored, and **AI providers** shows the provider and model each task will use.

The installer also adds a **Start menu → Satchel** folder, so you never have to find the download folder again:
| Start menu shortcut | Same as (in `companion\windows`) | Use |
|---|---|---|
| Satchel - Set Groq key | `set-key.cmd` | Add or replace your Groq key |
| Satchel - Set OpenAI key | `set-openai-key.cmd` | Add or replace your optional OpenAI key |
| Satchel - Check companion | `status.cmd` | Diagnose: registration, each key's status, whether the providers are reachable, and whether PowerShell is restricted |
| Satchel - Uninstall companion | `uninstall.cmd` | Remove the companion (asks about each key) |

Run `install.cmd` again any time to repair the companion.

The companion is copied to `%LOCALAPPDATA%\Satchel\companion`. The encrypted keys are `%LOCALAPPDATA%\Satchel\groq-key.dat` and (if you add one) `openai-key.dat`. Only your Windows account can decrypt them. Keys are never stored in the browser, in logs, or in the repository.

## Optional: use OpenAI for some tasks

Groq stays the default for everything. You can switch **chat and notes** (Ask, school AI reading, email drafts, meeting notes) and **meeting transcription** to OpenAI separately.

1. Create a key at <https://platform.openai.com/api-keys> (it starts with `sk-`). OpenAI is paid per use: your account needs billing or credit.
2. Start menu → **Satchel - Set OpenAI key**, paste the key, press Enter. It is checked with OpenAI and saved encrypted, like the Groq key.
3. In ⚙️ Settings → **AI providers and models**, choose **OpenAI** for chat/notes, transcription, or both. Under each task, **Will use:** shows the provider, the model (Auto picks one from your account's live model list), its estimated price, and for transcription whether transcript lines get exact timestamps (`whisper-1` does; the `gpt-4o-…-transcribe` models don't, so lines are timed per 5-minute part).

**Costs and the spending guard** (Settings → **Costs**):
* Before sending anything to OpenAI, the consent dialog shows the **estimated cost**. For a meeting it is based on the recording length (for example 60 min × $0.006/min = $0.36 with `whisper-1`). Nothing is sent until you press Send.
* **OpenAI spending guard (per month):** when Satchel's running estimate for this month would go over the amount you set, Satchel stops **before** making the next OpenAI request and tells you. The default is $5; set it to $0 to block OpenAI completely. A long transcription that would cross the guard can't be started (the Send button is disabled).
* **This is an estimate made by Satchel on your computer, not an OpenAI billing limit.** Real charges can differ (price changes, retries, rounding), and it only counts requests made by Satchel in this browser. To cap what OpenAI can actually charge, set a budget in your OpenAI account's billing settings.
* The prices used for estimates are listed there and can be edited if OpenAI changes them. **Reset this month's estimate** clears the running total.

## 5. Using Satchel

Open Satchel by clicking its toolbar icon or pressing **Alt+Shift+S**. It opens in the side panel and stays open while you browse.

### Ask (pages and research)
* **This page → 📝 Summarize page**, or type a question about the page and press Enter.
* The first time you use a site, the browser asks whether Satchel may read it. Click **Allow**. You can remove access later in the extension's **Details → Site access**.
* Before anything is sent, Satchel shows **what will be sent to Groq** (page titles and approximate length) and asks you to confirm. You can tick “Don't ask again until I restart the browser”, or turn the question off in Settings.
* **Selected tabs**: tick tabs, then **⚖️ Compare selected**, or type a question and press **🔎 Research question**.
* Answers show **“From the page (retrieved)”** facts with source chips (S1, S2… link to the page). A green ✓ means the quote was found on the page. **“Satchel's inference”** is the AI's own reasoning. Pages that couldn't be read (browser pages, PDFs, Google Docs canvas pages) are listed and not used.
* Highlight text on a page before asking, and Satchel focuses on that passage.
* **No page**: plain chat; nothing from your browser is shared.

### School
1. Go to your school website and sign in normally.
2. Open **School** in Satchel, check the website address, and click **Save & allow access** (then **Allow** in the browser prompt).
3. Open a page that lists assignments (for example “Upcoming” or a class page) and click **＋ Add this page**. You can give it a name and a default class. You can also paste addresses. Add as many pages as you need (up to 25).
4. Click **↻ Refresh pages**. Satchel opens each page in a background tab using your signed-in session, reads the assignments, and closes the tab. If you've been signed out, it tells you: sign in again and refresh.
5. Assignments appear under **Overdue / Today / This week / Later / Needs a date**:
   * **⚠ … (check)** means the date was unclear or conflicting; **?** means the year or day was guessed (for example “Friday”); **No due date** means none was found. Hover for the reason.
   * Click **More** to see instructions and links to the original page, then **Edit** to correct anything. **Your corrections are kept** when you refresh again.
   * Tick the checkbox to mark an assignment done. **＋ Add manually** adds your own.
   * **Import from this page** reads the page you're viewing right now, without adding it to the list.
* If the built-in reader finds nothing on a page, Satchel can ask the AI to read it, but it asks you first. Set a page to **No AI** to never send it, or **AI** to always use AI. Items the AI claims but that don't appear on the page are discarded.
* Dates like 03/04 are read as month/day. Change this in Settings if your school uses day/month.

### Tabs
* Search, tick tabs, and use **Group**, **Save**, **Save & close**, or **Close**. Click a tab title to switch to it.
* Type commands such as **close duplicate tabs**, **save these research tabs and close them** (“these” = the tabs you ticked), **group these as Chemistry**, **reopen Research**, or **find wikipedia**. Other requests are interpreted by the AI, which sees only the tab titles and site addresses of the current window.
* **Before tabs close, a confirmation screen lists the exact tabs.** You can untick any of them. **Pinned tabs are never included unless you tick them yourself.**
* **Saved groups** at the bottom let you reopen, rename, or delete what you saved.

### Email
Needs the one-time Google setup: **[docs/GOOGLE-SETUP.md](GOOGLE-SETUP.md)**. **Google sign-in has not yet been tested with a real Google account**, so treat Gmail and Classroom as unverified (see the note at the top of that guide). After setup:
* **Connect** “Gmail: read the threads you pick”. Search (e.g. `is:unread`), tick threads, and press **Summarize**.
* **Draft reply**: the recipient and subject come from the thread itself. Type what you want to say and press **Draft** to have the AI write it, then edit freely.
* **Review & send…** shows the recipients, subject, and complete message. Sending needs the separate “Gmail: send replies you approve” connection, plus your click on **Send email** for each message. Without the send connection, use **Copy text** and send from Gmail yourself.

### Meetings
**What has been checked so far.** Automated tests ran on Linux in open-source Chromium and in Microsoft Edge 154 for Linux. Nothing below has been tried on Windows. Please run section H of [MANUAL-TESTS.md](MANUAL-TESTS.md).

* **Tested** = the real feature ran in an automated test (on Linux Chromium and Linux Edge).
* **Simulated** = it ran against a stand-in (a fake Groq service, a fake microphone, or an automatically chosen tab).
* **Untested** = not run at all yet.

| Meetings capability | Status | Details |
|---|---|---|
| Record a browser tab: one-click (after clicking the Satchel icon on the tab) | **Untested** | Automation can't click the toolbar icon. Only the refusal message and fallback were checked. The playback that keeps the meeting audible in this mode is also untested. |
| Record a browser tab: tab picker | **Tested on Linux, simulated picker** | Real capture of a local test page playing a tone, with the tab choice made automatically by a test flag. Recording, 5-minute chunk rotation, timer, REC badge, the page still playing, and stopping when the tab closes were all checked. **Not** tried with a real meeting site, on Windows, or in Edge. |
| Microphone recording | **Simulated** | Chromium's fake microphone only. A real microphone, the permission prompt, and the denied-permission warning in a real browser are untested. |
| Recovery after a closed recorder window or a browser crash | **Tested on Linux** | Audio saved up to about 2 s before the interruption is kept and playable. |
| Import WAV | **Tested on Linux** | A generated WAV file is split into parts correctly. |
| Import Zoom recordings (M4A/MP4) | **Tested in Edge on Linux, generated file** | A generated Zoom-style `audio_only.m4a` and `zoom_0.mp4` (AAC) were imported in Microsoft Edge 154 for Linux, split into parts, and transcribed in order. No real Zoom recording and no Windows Edge/Chrome yet. Open-source Chromium can't decode AAC. |
| Transcription (Groq or OpenAI) | **Simulated** | The real companion uploads each part, one failed part is retried alone, timestamps line up, and it keeps running with the side panel closed. Groq and OpenAI were fake services, so real accuracy, real rate limits and real charges are untested. |
| Transcript correction, notes, timestamp links | **Simulated (Groq)** | The UI and the grounding rules are tested (invented decisions are dropped; owners and dates only when stated). The notes' wording came from a fake AI. |
| Export (Markdown / plain text), search, rename | **Tested on Linux** | |
| Separate deletion of audio, transcript, notes; no memory writes | **Tested on Linux** | |

**Record a meeting that runs in a browser tab** (Google Meet, Zoom in the browser, Teams in the browser, and similar):
1. Open the meeting tab. Then **click the Satchel toolbar icon while that tab is showing** (or press **Alt+Shift+S**, or right-click the page → **Record this tab with Satchel…**). Chrome and Edge only let an extension capture a tab after you invoke it on that tab.
2. In **Meetings → Record a meeting in a browser tab**, check the title and read **What will be recorded**: the audio of that tab, plus your microphone if you tick **Also record my microphone** (wear headphones to avoid echo). Other tabs, desktop apps, your screen, and video are never captured.
3. Tick the box confirming you've told participants and have their consent where required, then press **⏺ Start recording**.
4. A small **recorder window** opens with a red dot, a timer, and a **Stop** button, and the Satchel icon shows **REC**. You can minimize the window, but don't close it. You keep hearing the meeting.
   * If Satchel says **“Chrome needs one more step”**, you didn't invoke Satchel on the tab (step 1). Do that and press Start again, or choose **Use the tab picker instead**: in the browser's dialog, pick the meeting **tab** and tick **Also share tab audio**.
5. Press **Stop** (in the recorder window or the side panel). If the meeting tab is closed, recording stops by itself and everything so far is kept.
   * If the recorder window is closed by accident, the computer crashes, or the browser quits, audio saved up to the last ~2 seconds is kept, and the meeting shows **interrupted – audio kept**.
   * If microphone access is denied, recording continues with the tab audio only, and the recorder says so.

**Import a recording** (Meetings → Import a recording):
* Supported: M4A, MP4 (audio track), MP3, WAV, WebM, OGG/Opus, FLAC. Limits: 300 MB and 2 hours per file, because the file is decoded inside the browser.
* **Zoom desktop app:** Satchel can't record the Zoom app (or any desktop app) live. Record in Zoom instead (**Record → Record on this computer**). When the meeting ends, open `Documents\Zoom\<meeting folder>` and import **`audio_only.m4a`**, which is much smaller than the MP4. You can also join the meeting in the browser (Zoom's “Join from your browser” link) and record that tab.

**Transcribe, review, and make notes:**
1. Open the meeting and press **Transcribe with Groq…** (or **with OpenAI…** if you chose OpenAI for transcription). Satchel shows how many minutes and MB of audio will be sent, the model, and the **estimated cost**, and sends nothing until you press **Send audio to Groq** / **Send audio to OpenAI**. Parts are sent one at a time. If one fails, the others are kept; press **Retry failed parts**. If the provider's rate limit is reached (on Groq's free tier, about 2 hours of audio per hour), your progress is saved; press **Resume transcription** later. **It keeps going if you close the side panel**; reopen it to see the result.
2. Read the transcript and fix names or words (edits save automatically).
3. Press **I reviewed the transcript: generate notes…**, then approve sending the transcript text. The notes have a summary, key points, decisions, action items, and open questions. Every item links to the moment in the transcript (⏱ chips).
   * Decisions and action items appear only if the transcript actually contains them. Suggestions the AI couldn't back up are listed separately as “left out”.
   * Owners and due dates are filled in only when someone stated them. Anything uncertain has a **⚠ Review** note.
4. Edit any field (it saves automatically), tick action items when done, and export **Markdown** or **plain text** (notes only, transcript only, or everything).
5. Delete separately with **Delete raw audio**, **Delete transcript**, and **Delete notes**, or delete the whole meeting. Meeting content is never added to Satchel's memory.

Settings → **AI providers and models** lets you choose the transcription provider and model (from your account's live list) and the meeting language.

### Memory
* Type `/remember I prefer bullet-point summaries` in Ask, or use **Save a note to memory…** under an answer.
* Open 🧠 **Memory** to view, search, edit, switch off (“Use in AI”), export, import, or delete memories. Memories are limited to short notes (500 characters) so whole pages or emails can't be saved as memory.
* Chat history is separate: it's kept only until you close the browser, and **Clear chat** removes it immediately.

## 6. Troubleshooting

Error messages in the side panel now include the next step: numbered steps, a button to the right Settings section, and **Try again** for temporary problems (for rate limits it counts down first).

| Problem | Fix |
|---|---|
| Header says **AI: not set up** / “companion is not installed” | Follow the setup card at the top of the side panel: run `install.cmd`, then close **all** browser windows and reopen. |
| “installed for a different extension ID” | You loaded a copy with a different ID. Load the `extension` folder from this repository, or run `install.cmd` again. |
| “companion could not start” | Start menu → **Satchel - Check companion** (or `status.cmd`). School-managed PCs sometimes block PowerShell scripts; the rest of Satchel still works, but AI features won't. |
| “Groq rejected the stored API key” / “OpenAI rejected…” | Start menu → **Satchel - Set Groq key** / **Set OpenAI key** with a new key. |
| “No OpenAI key is stored” | You chose OpenAI for a task. Add the key (Start menu → Satchel - Set OpenAI key), or switch the task back to Groq in Settings → AI providers. |
| “Your OpenAI account has no credit or quota left” | Add billing or credit in your OpenAI account, or switch the task to Groq. Satchel doesn't retry this. |
| “Stopped before sending: … spending guard” | Satchel's own monthly estimate reached your guard. Raise it in Settings → Costs, reset the month's estimate, or switch the task to Groq. |
| “rate limit reached” | Groq's free tier limits requests per minute. Wait the time shown, choose a smaller model in Settings, or lower “Max page text per request”. |
| “Could not reach Groq” | Check your internet connection. Some school networks block AI services. |
| A model disappeared | With **Auto**, Satchel picks another automatically and tells you. Otherwise pick one in Settings → Refresh list. |
| Meetings: “Chrome needs one more step” | Click the Satchel icon while the meeting tab is showing (or right-click the page → Record this tab with Satchel…), then press Start again. Or use the tab picker. |
| Meetings: “The shared tab has no audio” | In the picker, choose a **tab** (not a window or screen) and tick **Also share tab audio**. |
| Meetings: import says it can't decode the file | Use Chrome or Edge (not a Chromium build without AAC), or import Zoom's `audio_only.m4a` / an MP3. |
| Meetings: “speech-to-text limit … reached” | Groq limits audio per hour. Wait the time shown, then press **Resume transcription**; finished parts are kept. |
| “can't be read” on a page | Browser pages (`chrome://`, `edge://`), extension stores, PDFs, and Google Docs can't be read by extensions. Copy the text into the chat instead. |
| School refresh says “signed out” | Sign in to the school site in a normal tab, then refresh. |
| Nothing found on a school page | Try **Import from this page** while viewing it, set the page's mode to **AI**, or add assignments manually. |

## 7. Updating and removing

* **Update:** replace the Satchel folder with the new version, then click the **↻ reload** icon on Satchel's card in `chrome://extensions` / `edge://extensions`. Run `install.cmd` again if the companion changed. Your data and key are kept.
* **Remove:** click **Remove** on the extension card (this deletes Satchel's browser data), then Start menu → **Satchel - Uninstall companion** (or `companion\windows\uninstall.cmd`; it asks whether to delete each key). Also delete the keys at console.groq.com / platform.openai.com if you no longer need them.
