# AGENTS.md

## Project

This is a personal Windows Spotify now-playing widget built with Tauri 2, Rust, React, and TypeScript.
The project root is the directory containing this file. The similarly named parent directory is only a container.

Spotify data comes from the Spotify Web API. Authentication uses Authorization Code with PKCE and the callback URL `http://127.0.0.1:43821/callback`.

## Product requirements to preserve

- Keep the widget always on top, frameless, transparent, and absent from the taskbar.
- Keep the window draggable from non-interactive areas.
- Preserve the existing cover-art-led visual identity unless the user explicitly asks for a redesign.
- Keep long titles and artist names readable with the existing marquee behavior.
- Keep track changes subtle: preload artwork, crossfade the background, and move content only a few pixels.
- Do not add playback controls or other permanent UI without an explicit request.
- Do not remove or expose the Spotify PKCE state check, access token, or refresh token.

## Current behavior and known limitations

- Playback information is polled about every second while playing and every three seconds while idle, with backoff after errors.
- The width can vary from 180 px to 520 px and the height from 72 px to 180 px.
- Marquee animation pauses during resize and track transitions, then restarts after remeasurement.
- Hovering reveals a settings button for transition duration, background blur, and text scale; values persist in local storage.
- `spotify_url` is returned by Rust but is not currently used by the React UI.
- When no track is returned, the same screen used for initial connection is displayed while polling continues.
- Tokens are stored as JSON in the OS configuration directory under `spotify-now-playing-widget/tokens.json`.

## Development rules

- Never commit Spotify tokens, local `.env` files, `node_modules`, `dist`, or `src-tauri/target`.
- Keep `package-lock.json` and `src-tauri/Cargo.lock` committed for reproducible builds.
- Keep the version synchronized in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
- Prefer small, reviewable changes. Avoid unrelated visual cleanup during functional work.
- Format Rust with `cargo fmt` when Rust code changes.
- Keep TypeScript strict and do not suppress errors without documenting the reason.
- Update `CHANGELOG.md` for user-visible changes.
- Update `docs/QA_CHECKLIST.md` when behavior or supported interactions change.

## Validation

From the project root, run:

```powershell
npm.cmd run build
Push-Location src-tauri
cargo test --locked
Pop-Location
```

Use `npm.cmd` on Windows because PowerShell execution policy may block `npm.ps1`.
For UI, authentication, installer, or Spotify API changes, also complete the relevant manual checks in `docs/QA_CHECKLIST.md`.
