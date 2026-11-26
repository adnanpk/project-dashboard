# Setup guide

The dashboard is a static page. All of your data stays in your Google Sheet and Drive; the page talks to them through one small Apps Script that you deploy from the sheet. It takes about 10 minutes, once.

Live dashboard: **https://adnanpk.github.io/project-dashboard/**

## 1. Paste the script into your sheet

1. Open the **Master Project Tracker** sheet.
2. Menu **Extensions → Apps Script**. A new tab opens.
3. Delete everything in `Code.gs`, then paste the whole contents of [`apps-script/Code.gs`](apps-script/Code.gs) ([raw version to copy](https://raw.githubusercontent.com/adnanpk/project-dashboard/main/apps-script/Code.gs)).
4. Click the **Save** icon.

## 2. Set your passcode and time zone

1. In the Apps Script tab, click the **gear icon (Project Settings)** on the left.
2. Under **General settings**, set **Time zone** to `(GMT+03:00) Riyadh`.
3. Scroll to **Script properties → Add script property**:
   - Property: `DASHBOARD_TOKEN`
   - Value: a passcode you choose. Make it long (for example four random words). This is what protects your data.
4. Click **Save script properties**.

Also make sure the sheet itself uses Riyadh time: in the sheet, **File → Settings → Time zone → (GMT+03:00) Riyadh**.

## 3. Deploy it as a web app

1. In the Apps Script tab, click **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set:
   - Description: `Dashboard`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**, then **Authorize access** and pick your Google account.
5. Google shows "Google hasn't verified this app". That's expected for your own script: click **Advanced → Go to (project name) (unsafe) → Allow**.
6. Copy the **Web app URL** (it ends in `/exec`).

"Anyone" only means the URL can be reached. Every request is refused unless it carries your passcode, which is checked inside the script.

## 4. Connect the dashboard

1. Open https://adnanpk.github.io/project-dashboard/
2. Enter your passcode and click **Sign in**. (The Web app URL is built into the page; if you ever redeploy to a new URL, paste it under "Use a different Apps Script URL".)

The URL and passcode are saved only in that browser. Repeat this step on each device (phone, laptop). Use **Settings (gear icon) → Sign out** to remove them.

## What the dashboard can change

- **Status (the Current Status column only)**: from Focus mode (click any card) or the ⋯ menu on a card. "Mark completed and archive" sets it to `Completed`. Each change shows an Undo button.
- **Voice notes**: the mic button records in the browser (up to 5 minutes) and saves the audio to **My Drive → Al-Marfat → Project Voice Notes → <Project Name>**. The newest note is linked on the card; all of them are listed in Focus mode.
- **Subscription reminders**: "Set reminder" on a subscription card writes only that row's Reminder Date on the Subscription Dashboard tab, and the script adds the Google Calendar event.
- It never writes any other column, never touches formula columns, and never writes the Daily Voice Log.

## Sheet columns the dashboard reads

The script finds columns by their **header text** (row 2 on Active Projects, row 1 on Daily Voice Log), so columns can be added or reordered. Headers it looks for:

| Header contains | Used for |
| --- | --- |
| `Priority Score` | Today's 5 fallback ranking |
| `Days Since Logged` | Days-since label, ⚠ at 7–13 days, 🚨 at 14+ |
| `Today's Pick` | Today's 5: rows marked `✅ Today` |
| `Voice Log Link` (both tabs) | 🎙 play buttons on cards and log rows (a URL, a `HYPERLINK()` formula or a linked cell) |

Until a column exists, the dashboard works it out itself: days since logged from the last 30 days of the log (older shows as 30+), and Today's 5 as the top 5 active projects by priority (High 3, Medium 2, Low 1, times 5) plus days since logged.

The script uses Google's standard Drive permission, which Google words as access to your Drive. It runs only under your own account and only creates and lists files in the `Al-Marfat/Project Voice Notes` folder.

## Subscriptions

The **Subscriptions** tab at the top of the dashboard reads the sheet's **Subscription Dashboard** tab. Set it up once:

1. Paste the latest `Code.gs` into Extensions → Apps Script and save.
2. In the function picker at the top of the editor, choose **setupSubscriptionDashboard** and click **Run**. Google asks for permission again because the script now uses **Google Calendar**: click Review permissions, pick your account, then Allow.
3. **Deploy → Manage deployments → pencil icon → Version: New version → Deploy** (the URL stays the same).

`setupSubscriptionDashboard` adds the tab if it isn't there (it never touches your other tabs), with these columns:

| Column | What goes in it |
| --- | --- |
| Service | e.g. ChatGPT Plus |
| Nature | Paid, Trial, Free or Complimentary (dropdown) |
| Account / Email | the account the subscription is on |
| Start Date, End Date | dates |
| Amount Paid | e.g. SAR 75 |
| Action on Expiry | Renew, Cancel, Downgrade, Upgrade, Switch to free or Decide (dropdown) |
| Reminder Date | the day you want to be reminded |
| Calendar Reminder | filled in by the script (✅ and the time) |
| Action Taken | what you actually did at expiry |
| Status | Active, Expired, Cancelled or Renewed (dropdown) |
| Notes | anything else |
| Calendar Event ID | hidden, used by the script so a reminder is never created twice |

**Reminders:** when a row has a Reminder Date, the script creates an event at **9:00 AM Riyadh time** that day in the Google Calendar of the account that owns the sheet, with a pop-up the day before, a pop-up on the day and an email. It runs as soon as you edit a row, again every morning at 7, and from the sheet menu **Subscriptions → Sync calendar reminders now**. Changing the date moves the event; clearing it deletes the event. You can also set or change a reminder from the dashboard with **Set reminder** on any subscription card.

**Flags on the dashboard:** subscriptions ending within 30 days are amber, within 7 days red, and ones past their end date with no Action Taken show 🚨. A subscription counts as done once its Status is Cancelled or Renewed, or Expired with Action Taken filled in.

## Updating the script later

If `Code.gs` changes, paste the new version, then **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. The URL stays the same.

## Troubleshooting

| Message | Fix |
| --- | --- |
| "That passcode doesn't match" | Check `DASHBOARD_TOKEN` in Script properties, with no extra spaces. |
| "DASHBOARD_TOKEN is not set" | Step 2 wasn't saved. |
| "Couldn't reach the Apps Script" | Make sure you copied the `/exec` URL and that access is **Anyone**. |
| No Today's 5 marks or 🎙 buttons from the sheet | Paste the latest `Code.gs` and deploy a new version (see above). |
| Minutes show 0 for today | The sheet's or script's time zone isn't Riyadh (step 2). |
| Mic doesn't start | Allow microphone access in the browser's address bar. |
| Subscriptions says "Update the Apps Script" | Paste the latest `Code.gs` and deploy a new version. |
| Subscriptions says "Set up the Subscription Dashboard tab" | Run `setupSubscriptionDashboard` once (see Subscriptions above). |
| A reminder isn't in Calendar | Check the Calendar Reminder column for a message, then use Subscriptions → Sync calendar reminders now. |

## Shortcuts

`P` projects · `S` subscriptions · `/` search · `1`–`4` switch views · `R` refresh · `T` light/dark · `Esc` close

## Momentum deferral

On a day when you put **2× or more** of a project's daily goal into it (60+ minutes on a 30-minute goal), the projects you didn't touch that day are **deferred**, not neglected. They go back to normal tracking the next day.

Turn it on once:

1. Paste the latest `Code.gs` into Extensions → Apps Script and save.
2. In the function picker choose **setupMomentumDeferral** and click **Run** (or use the sheet menu **Subscriptions → Turn on momentum deferral**).
3. **Deploy → Manage deployments → pencil icon → Version: New version → Deploy** (the URL stays the same).

What it changes:

- **Daily Voice Log** gets a formula column **Momentum Day**. A ⚡ marks every log row on a momentum day. Never type in it.
- **Active Projects → Days Since Logged**: momentum days since a project was last logged are not counted, so its Priority Score and Today's Pick don't jump.
- **Today's Goal Status**: an untouched project shows `⏸ Deferred` instead of `🔴 Pending` on a momentum day.
- **Reminder Alert**: `⚠️ NEGLECTED` now reads the momentum-aware Days Since Logged.
- The dashboard's Today's 5 header says when today is a momentum day.

Limits that keep it honest:

- **Not two days in a row on the same project.** If the same project gets 2× again the next day, that second day is not a momentum day.
- **Due dates are never deferred.** A project due today or overdue stays `🔴 Pending`, `⏰ DUE TODAY` or `🚨 OVERDUE`.
- **Touched counts as touched.** A project you worked on but under goal stays `⏳ Partial`.
- **It starts the day you switch it on.** Earlier days are not rewritten (the start date is kept in the Script property `MOMENTUM_START`).
