# inner-circle
## app/ (the InnerVerse home-screen app)

`app/` is a separate installable app (episodes, Plus+ login and full episodes, player, and this chat in its Inner Circle tab), served at `https://circle.innerversepodcast.com/app/`. Its chat tab shows the root page in a frame and hides `.nav` and `.ptop > a.ibtn[aria-label="Back to InnerVerse"]` inside it, so keep those selectors or update `mountChat()` in `app/index.html`. It registers its own service worker scoped to `/app/`; a service worker for the chat itself should register at the root. Notes: `claude/APP-home-screen-2026-10-08.md` in the Website Recode project.
