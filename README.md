# XDir

XDir is a Windows desktop library manager for locally stored games and archives. It scans a configured library folder, detects supported source links, stores a local library in SQLite, and enriches entries with metadata from F95Zone, DLsite, and Itch.io through the bundled browser extension.

## Status

This is a first public release build for Windows. The app is usable, but it is still early-stage software and should be treated as a local desktop utility rather than a polished cross-platform product.

## Features

- Scan a local library folder for game directories, executables, and archives
- Track installed titles, archives, wishlist entries, progress, notes, and tags
- Detect and link supported source URLs from local metadata and imported entries
- Enrich library records through the bundled browser extension
- Reduce duplicate records during ingestion and startup maintenance
- Run as a desktop app or in API-only mode for debugging

## Tech stack

- Python
- FastAPI
- SQLAlchemy
- pywebview
- Vanilla HTML, CSS, and JavaScript

## Repository layout

- `app.py`: desktop entry point
- `backend/`: API, database, ingestion, and settings logic
- `frontend/`: packaged UI assets
- `extension/`: bundled browser extension used for metadata sync
- `tests/`: regression checks for release-critical behavior
- `build-windows-release.bat`: Windows release build script
- `XDir.spec`: PyInstaller build definition

## Run from source

1. Create and activate a virtual environment.
2. Install dependencies:

```powershell
pip install -r requirements.txt
```

3. Start the desktop app:

```powershell
python app.py
```

For API-only mode:

```powershell
python app.py --server-only
```

## Windows release build

Build the packaged executable with:

```powershell
build-windows-release.bat
```

The packaged executable is produced at:

```text
dist\XDir\XDir.exe
```

Release uploads should ship the full packaged folder as a `.zip`, because the executable depends on adjacent bundled runtime files.

## Browser extension

The bundled extension lives in `extension/`. Load it as an unpacked Chromium-based extension to sync metadata from supported sites.

## Data and local files

- Library data is stored locally in SQLite and should not be committed
- Runtime cache and temporary files are intentionally ignored by Git
- A packaged build keeps its runtime files beside the executable

## Known scope limits

- Windows-focused; not prepared for Linux or macOS distribution
- No automatic updater yet
- No authenticated cloud sync
- Site integrations depend on external site structure remaining stable

## Testing

Release-critical regression checks live in `tests/` and can be run with Node:

```powershell
node tests/frontend-regressions.mjs
node tests/backend-regressions.mjs
node tests/app-upgrade-regressions.mjs
```

## License

No open-source license has been added yet. Until one is chosen, treat the repository as all rights reserved.
