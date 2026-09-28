# Connecting Gmail and Google Classroom

Google services are optional. Everything else in Satchel works without them.

## Why a setup step is needed

Google requires every app that reads Gmail or Classroom data to have its own **OAuth client ID** registered in Google Cloud. Satchel is a personal extension, not a published Google-verified app, so you create a free client ID in your own Google account. It isn't a secret, and it only allows sign-in requests that you approve.

Satchel uses three **separate** connections. Each one is requested only when you click its **Connect** button:

| Connection | Google permission (scope) | What Satchel can do |
|---|---|---|
| Gmail: read the threads you pick | `gmail.readonly` | List recent threads, and open the ones you select to summarize or reply to. Email content is never saved. |
| Gmail: send replies you approve | `gmail.send` | Send a message **only** after you review it and click **Send email**. This permission can't read mail. |
| Google Classroom | `classroom.courses.readonly`, `classroom.coursework.me.readonly` | Import your classes, assignments, and due dates (read-only). |

Satchel also asks for your basic `email` address, so it can show which account is connected.

Access tokens are kept in memory only (browser session storage). They expire after about an hour and are refreshed silently while the browser is open. They're never sent to Groq.

## Steps (about 10 minutes, one time)

1. Open **<https://console.cloud.google.com/projectcreate>** and create a project named **Satchel**.
   *Tip:* school Google accounts usually can't create Cloud projects. Use a **personal** Google account for this step. You can still try connecting your school account later (see “School accounts” below).
2. In the project, go to **APIs & Services → Library** and **Enable**:
   * **Gmail API**
   * **Google Classroom API** (only if you use Classroom)
3. Go to **Google Auth Platform** (older consoles call it **OAuth consent screen**):
   * **Get started** → App name `Satchel`, your email as support contact.
   * **Audience:** choose **External**.
   * **Test users:** add every Google account you'll connect (your personal and/or school address).
   * Leave the app in **Testing** mode. That's fine for personal use.
4. Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**):
   * **Application type:** **Web application**
   * **Authorized redirect URIs → Add URI:**
     ```
     https://enhkjfoecodefiigkephlalmoebbfgmb.chromiumapp.org/
     ```
     (Satchel ⚙️ Settings → Google shows this address with a **Copy** button. It's the same in Chrome and Edge because Satchel's extension ID is fixed. If Settings ever shows a different address, add that one too.)
   * Click **Create** and copy the **Client ID** (it ends with `.apps.googleusercontent.com`). No client secret is needed.
5. In Satchel, open ⚙️ **Settings → Google**, paste the client ID, and click **Save**.
6. In the **Email** view (or Settings → Google), click **Connect** next to a connection.
   * The browser asks for the **identity** permission once. Click **Allow**.
   * A Google window opens. Choose your account.
   * Because the app is in Testing mode, Google warns that it **hasn't verified this app**. Click **Continue** (you created the app yourself).
   * Leave the requested permission ticked and click **Continue**.

To disconnect, click **Disconnect** next to a connection, or **Disconnect all Google access** in Settings. That also revokes Satchel's access at Google. You can review access at <https://myaccount.google.com/permissions>.

## School accounts (Google Workspace for Education)

Your school's Google administrator controls which third-party apps can use school accounts. What you might see:

| Message | Meaning | What to do |
|---|---|---|
| “Access blocked: … has not completed the Google verification process” | The app is in Testing mode and your school account isn't a test user, or the school blocks unverified apps. | Add the address as a test user (step 3). If it's still blocked, the admin must allow it. |
| “admin_policy_enforced” / “Your administrator has blocked…” | The school doesn't allow this app. | Ask school IT to allow it (below), or connect a personal account. |
| “The Classroom API has been disabled by the domain administrator” | Classroom API access is off for your school. | Ask school IT, or use the School view with your school website instead. |

When access is blocked, Satchel explains why in the Email or School view, and everything else keeps working.

**What to send school IT** if you want to request approval:
> I'd like to use a personal browser extension (“Satchel”) with my school Google account. It's a Google OAuth *Web application* client with ID `<your client ID>`. It requests `gmail.readonly` and `gmail.send` (sending only after I confirm each message), and/or `classroom.courses.readonly` + `classroom.coursework.me.readonly` (read-only). Could this client ID be marked as *Trusted* in Admin console → Security → API controls → App access control?

Whether this is allowed is entirely up to your school's policy.

## Limitations

* Satchel uses Google's browser sign-in flow for client-side apps (an access token, no stored refresh token). If Google ever retires that flow for new clients, sign-in will stop working until Satchel is updated.
* Apps in Testing mode can have at most 100 test users, and Google may show the unverified-app screen at every sign-in. That's expected for personal use.
