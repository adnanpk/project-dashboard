# Project Dashboard

A dark, focused dashboard for the Master Project Tracker Google Sheet.

**Live:** https://adnanpk.github.io/project-dashboard/ · **Setup:** [SETUP.md](SETUP.md)

- Views: Board (drag to change status), Cards (sort by priority, due date or time slot), Today (06:00–16:00 schedule), Timeline (21 days ahead plus overdue), and Focus mode for one project.
- Filters: category, priority, today's slots only, show/hide completed, search.
- Daily 30-minute goal rings, weekly progress, overdue flags, due-date countdowns.
- Voice notes recorded in the browser and saved to Google Drive.
- Reads the sheet on load and every 5 minutes; writes back only the status column.
- Passcode protected: no project data is stored in this repository or served by the page.

Plain HTML, CSS and JavaScript, no build step. The backend is [`apps-script/Code.gs`](apps-script/Code.gs), deployed from the sheet.
