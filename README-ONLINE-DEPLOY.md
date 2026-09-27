# Smart Grievance online deployment

## What is ready

- `index.html` — public frontend with user login, department login, AI triage, photo evidence, voice input, tracking, timeline and feedback.
- `server.js` — Node/Express API with SQLite storage.
- `package.json` — backend start configuration.

## Important

GitHub Pages can host only the frontend. The Node API must be deployed on a Node hosting service such as Render or Railway. SQLite data needs a persistent disk or a hosted database for long-term storage.

## Connect the hosted frontend to the hosted API

Open the frontend with the hosted API URL in the query string:

`https://YOUR-USER.github.io/YOUR-REPO/?api=https://YOUR-BACKEND.example.com/api`

The frontend also accepts `window.SMART_GRIEVANCE_API_BASE` if you prefer to configure it in the HTML.

## Demo accounts

- Citizen: `demo.user@example.com` / `user1234`
- Water department: `water.department@example.com` / `dept1234`
- Sanitation department: `sanitation.department@example.com` / `dept1234`

Change demo passwords before any public production use.

## Do not upload

Do not commit `smart-grievance.sqlite`, `-wal`, `-shm`, real citizen photos, or personal data to GitHub. Keep the database on the backend host.
