# Privacy and security design

## What goes where

| Data | Where it's stored | Sent to Groq? |
|---|---|---|
| Groq API key | `%LOCALAPPDATA%\Satchel\groq-key.dat`, encrypted with Windows DPAPI (current user) plus app-specific entropy | Only as the HTTPS `Authorization` header, sent by the companion |
| Settings, school pages, assignments, saved tab groups | `chrome.storage.local` (this browser profile) | Assignment pages only when you use AI extraction, after you confirm |
| Memories | `chrome.storage.local` | Only if “Use in AI” is on (global and per-memory switches) |
| Chat history | `chrome.storage.session` (memory only, cleared when the browser closes) | Only in “No page” chat, and only the last few turns |
| Page text | Not stored | Only the pages you ask about, after the consent notice |
| Email content | Not stored | Only the threads you select, after the consent notice |
| Tab titles and addresses | Not stored | Only for AI tab commands: the current window, with query strings and fragments removed |
| Google access token | `chrome.storage.session` (memory only) | Never |

Satchel has **no background monitoring**. The service worker only sets up the side panel and runs school-page refreshes that you start. It never records or uploads browsing history.

## Permissions (and why)

| Permission | Why |
|---|---|
| `sidePanel` | Show Satchel in the side panel |
| `storage` | Save your settings, assignments, memories, and saved tabs locally |
| `tabs` | List, search, and manage tabs (titles and addresses) |
| `tabGroups` | Group tabs and reopen saved groups as a group |
| `scripting` | Run the read-only page extractor on pages you ask about |
| `activeTab` | Temporary access to the tab you invoked Satchel on |
| `nativeMessaging` | Talk to the Windows companion that holds the Groq key |
| `identity` | Opens Google's sign-in window when you click Connect. It shows no install warning and gives no access to data by itself; each Google service still needs your consent on Google's own screen. (It was optional in an earlier version, but that can't be reliably tested, so it is now a normal permission.) |
| Site access (optional, per site) | Requested for each site the first time you ask Satchel to read it. Nothing is granted at install time. Revoke any site in the extension's Details page. |

## Companion hardening

* Implemented as a **native messaging host**: no network listener, so no other website or program on the network can talk to it. The browser registry entry (`HKCU\Software\{Google\Chrome|Microsoft\Edge}\NativeMessagingHosts\com.satchel.companion`) lists only Satchel's fixed extension ID in `allowed_origins`, and the host also checks the caller origin itself.
* Accepts exactly three requests (`ping`, `models`, `chat`). A `chat` body must be JSON with `model` and `messages`, and requests are capped at 8 MB. The key is never returned.
* Logs contain only error codes and timestamps (`%LOCALAPPDATA%\Satchel\companion-errors.log`). They never include prompts, page text, email, or the key.
* `SATCHEL_GROQ_BASE_URL` and `SATCHEL_DATA_DIR` environment variables exist for automated tests only.

## Prompt-injection defenses

* Page, email, and tab-title text is wrapped in `<source>`, `<email>`, `<page>`, or `<tabs>` tags and labeled **untrusted data** in every system prompt. Closing tags inside the data are neutralized so it can't break out.
* Page and email tasks can only produce text. There's no code path from those answers to any browser action.
* Tab actions proposed by the AI are checked against an explicit allowlist (`search_tabs`, `focus_tab`, `group_tabs`, `ungroup_tabs`, `close_tabs`, `close_duplicate_tabs`, `save_tabs`, `reopen_saved_group`, `none`). The validator checks types, strips unknown fields, drops tab IDs that don't exist, removes pinned tabs you didn't tick, and caps the number of tabs. Then:
  * any action that closes tabs, and every AI-proposed action except a search (which only fills the search box), goes through a confirmation screen listing the exact tabs;
  * execution re-validates against the tabs that exist at that moment.
* Email recipients and threading headers come from the Gmail thread metadata, never from AI output. Recipient and subject lines are checked for header injection. A message is sent only from the review screen, with an explicit click each time.
* Satchel never fills in or submits forms.
* AI-extracted assignments are kept only if their title appears in the page text, and due text that isn't on the page is discarded.
* AI answers are grounded: facts must cite a source that was provided, and their quotes are checked against the full page text. Claims without a valid citation are shown as inference.
* All AI output is rendered with DOM text nodes (no `innerHTML`). Links are allowed only for `http(s)` addresses. `npm run lint` fails if `innerHTML`, `eval`, or `new Function` appear in the extension.
