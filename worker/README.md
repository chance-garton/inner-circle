# innerverse-circle Worker

The live side of the Inner Circle (messages, images, who is here). The page itself is `index.html` at the repo root, built from `src/app.html` by `build-page.py`.

- Deployed to Cloudflare as the Worker `innerverse-circle` (Durable Object `Room`, R2 bucket `innerverse-circle-media`).
- `DEV_AUTH` must stay `"0"` when deployed.
- Project notes: `claude/DESIGN-inner-circle-2026-10-07.md` in the Website Recode project.
