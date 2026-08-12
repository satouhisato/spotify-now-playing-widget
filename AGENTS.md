# AGENTS.md

## Project

This is a personal Windows Spotify now-playing widget built with Tauri 2, Rust, React, and TypeScript.
The project root is the directory containing this file. The similarly named parent directory is only a container.

Spotify data comes from Windows Global System Media Transport Controls. The app must run as the signed MSIX package because `globalMediaControl` requires package identity and a manifest capability. Spotify Web API authentication is not part of normal operation.

## Product requirements to preserve

- Keep the widget always on top, frameless, transparent, and absent from the taskbar.
- Keep the window draggable from non-interactive areas.
- Preserve the existing cover-art-led visual identity unless the user explicitly asks for a redesign.
- Keep long titles and artist names readable with the existing marquee behavior.
- Keep both selectable track transitions subtle: the default focus zoom replaces all content without retaining the old layer; the classic slide preserves the synchronized 0.3.10 movement and short crossfade.
- Do not add playback controls or other permanent UI without an explicit request.
- Do not reintroduce Spotify Web API polling or account authentication without an explicit product decision.

## Current behavior and known limitations

- The local Windows media-session list is checked every 200 ms; only visible track or playback-state changes are emitted to React.
- The width can vary from 180 px to 520 px and the height from 72 px to 180 px.
- Marquee animation pauses during resize and track transitions, then restarts after remeasurement.
- Hovering reveals a settings button for transition mode, separate focus/slide durations, background blur, and text scale; values persist in local storage.
- Spotify sessions are selected by source app ID so an active browser or video session does not replace Spotify.
- Album art is read from the Windows media-session thumbnail and passed to React as a local data URL.
- When no Spotify session or track is available, the waiting screen remains draggable and keeps its settings and close buttons.
- Old `tokens.json` files from releases before 0.7 are legacy data and are not read.

## Development rules

- Never commit legacy Spotify tokens, signing private keys, local `.env` files, `node_modules`, `dist`, or `src-tauri/target`.
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
For UI, Windows media-session, or MSIX changes, also complete the relevant manual checks in `docs/QA_CHECKLIST.md`. Build the distributable with `npm.cmd run build:msix`; the custom script adds the required capability manifest and signs the MSIX with the local development certificate.
