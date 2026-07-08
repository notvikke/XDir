# Changelog

## 0.2.0 - 2026-07-08

- Revamped the settings experience around real library defaults, source preference, maintenance actions, and extension health
- Reworked smart scan into tracked background jobs with progress, cancellation, and a cleaner review flow
- Added durable source-map recovery so rescans can preserve matched metadata even when local folder names are noisy
- Expanded wishlist flows with direct source search, browser handoff, manual local linking, and auto-graduation into scanned games
- Improved DLsite scraping fallbacks, title normalization, and smart matching coverage with new Python and regression tests
- Published the Windows package as `XDir-0.2.0-windows.zip`

## 0.1.1 - 2026-07-06

- Added an immediate branded startup splash so first launch no longer looks hung
- Moved dedupe and optional startup scan work off the blocking API boot path
- Reduced cold-start overhead by removing unnecessary eager imports from the packaged app
- Published the Windows package as `XDir-0.1.1-windows.zip`

## 0.1.0 - 2026-07-06

- Prepared the first public Windows release
- Added a packaged `XDir.exe` build path through PyInstaller
- Added a native app icon and Windows shell identity for the desktop app
- Hardened local API origin and CORS handling for packaged and local use
- Fixed packaged runtime path handling for settings, database, frontend, and extension assets
- Added regression coverage for release-critical desktop and backend behavior
- Added repository setup files for source install and release builds
