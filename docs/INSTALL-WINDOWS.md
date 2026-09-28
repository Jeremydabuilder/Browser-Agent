# Installing and using Satchel on Windows

This guide assumes no programming experience. It takes about 10 minutes, plus about 10 more if you want Gmail or Google Classroom.

You need:
* Windows 10 or 11
* Google Chrome (version 116 or newer) and/or Microsoft Edge (version 116 or newer)
* A free Groq account for the AI: <https://console.groq.com>

> **What has been tested so far (please read).** Satchel was built and tested on Linux in Chromium, with the companion running under PowerShell 7 and a simulated Groq service. **None of the following has been tried yet:** the Windows installer (`install.cmd`, registry registration, the `.bat` launcher, DPAPI key encryption, Windows PowerShell 5.1), Microsoft Edge, a real Groq key, and real Google sign-in for Gmail and Classroom. This guide describes how those parts are designed to work. If a step behaves differently, run `status.cmd` and note the exact message. [MANUAL-TESTS.md](MANUAL-TESTS.md) is the checklist for confirming each part.

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
5. **Close every Chrome/Edge window and reopen the browser** (needed once so the browser finds the companion).

There's nothing to start at login: the browser launches the companion automatically when Satchel needs it, and it closes again after each request.

**Check it:** click the Satchel icon. The header should say **AI: ready** (green). Or open ⚙️ Settings and press **Test connection**, which also lists the models available on your Groq account.

Companion tools (in `companion\windows`):
| File | Use |
|---|---|
| `install.cmd` | Install or repair the companion (safe to run again) |
| `set-key.cmd` | Replace your Groq key |
| `status.cmd` | Diagnose: shows registration, key status, and whether Groq is reachable |
| `uninstall.cmd` | Remove the companion (optionally delete the key) |

The companion is copied to `%LOCALAPPDATA%\Satchel\companion`, and the encrypted key is at `%LOCALAPPDATA%\Satchel\groq-key.dat`. Only your Windows account can decrypt it.

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

### Memory
* Type `/remember I prefer bullet-point summaries` in Ask, or use **Save a note to memory…** under an answer.
* Open 🧠 **Memory** to view, search, edit, switch off (“Use in AI”), export, import, or delete memories. Memories are limited to short notes (500 characters) so whole pages or emails can't be saved as memory.
* Chat history is separate: it's kept only until you close the browser, and **Clear chat** removes it immediately.

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| Header says **AI: not set up** / “companion is not installed” | Run `install.cmd`, then close **all** browser windows and reopen. |
| “installed for a different extension ID” | You loaded a copy with a different ID. Load the `extension` folder from this repository, or run `install.cmd` again. |
| “companion stopped unexpectedly” | Run `status.cmd`. School-managed PCs sometimes block PowerShell scripts; the rest of Satchel still works, but AI features won't. |
| “Groq rejected the stored API key” | Run `set-key.cmd` with a new key from console.groq.com/keys. |
| “rate limit reached” | Groq's free tier limits requests per minute. Wait the time shown, choose a smaller model in Settings, or lower “Max page text per request”. |
| “Could not reach Groq” | Check your internet connection. Some school networks block AI services. |
| A model disappeared | With **Auto**, Satchel picks another automatically and tells you. Otherwise pick one in Settings → Refresh list. |
| “can't be read” on a page | Browser pages (`chrome://`, `edge://`), extension stores, PDFs, and Google Docs can't be read by extensions. Copy the text into the chat instead. |
| School refresh says “signed out” | Sign in to the school site in a normal tab, then refresh. |
| Nothing found on a school page | Try **Import from this page** while viewing it, set the page's mode to **AI**, or add assignments manually. |

## 7. Updating and removing

* **Update:** replace the Satchel folder with the new version, then click the **↻ reload** icon on Satchel's card in `chrome://extensions` / `edge://extensions`. Run `install.cmd` again if the companion changed. Your data and key are kept.
* **Remove:** click **Remove** on the extension card (this deletes Satchel's browser data), then run `companion\windows\uninstall.cmd` (it asks whether to delete the key). Also delete the Groq key at console.groq.com if you no longer need it.
