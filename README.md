# Project Dashboard

A dark, focused dashboard for the Master Project Tracker Google Sheet.

**Live:** https://adnanpk.github.io/project-dashboard/ · **Setup:** [SETUP.md](SETUP.md)

- **Today's 5**: the five projects to work on today, from the sheet's *Today's Pick* column (or, until that column exists, the top 5 active projects by priority plus days since last logged). Each has a *Log session* button that records a voice note.
- **Not seen recently**: active projects not logged for 7–13 days (⚠) or 14+ days (🚨), from the sheet's *Days Since Logged* column.
- Views: Overview, Cards (sort by recently worked, most neglected, priority or due date), Today (today's 5 plus the rest of the rotation), Timeline (21 days of due dates), and Focus mode for one project.
- Filters: category, priority, today's 5 only, show/hide completed, search.
- Daily 30-minute goal rings, weekly progress, due-date countdowns.
- 🎙 play buttons for voice notes linked in the sheet's *Voice Log Link* columns (projects and log rows).
- Voice notes recorded in the browser and saved to Google Drive.
- Reads the sheet on load and every 5 minutes; writes back only the status column and a subscription's Reminder Date.
- **Subscriptions** tab: everything from the sheet's *Subscription Dashboard* tab, with subscriptions ending within 30 days flagged, an upcoming-reminders strip, and a *Set reminder* button that puts a reminder in Google Calendar.
- Passcode protected: no project data is stored in this repository or served by the page.

Plain HTML, CSS and JavaScript, no build step. The backend is [`apps-script/Code.gs`](apps-script/Code.gs), deployed from the sheet.
