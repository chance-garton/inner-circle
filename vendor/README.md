# vendor

Third-party code served with the page, kept here so the chat does not lean on anyone else's servers.

- `mediabunny-1.66.5.min.js`: Mediabunny 1.66.5 (https://mediabunny.dev, https://github.com/Vanilagy/mediabunny), unmodified, Mozilla Public License 2.0. The chat loads it only when a member picks a video: it shrinks the clip on their own device, trims it, and drops its location and camera details before upload.

To update: `npm pack mediabunny`, copy `dist/bundles/mediabunny.min.mjs` here under its version number with a `.js` ending (so every host serves it as a script), and change `MB_URL` in `worker/src/app.html`.
