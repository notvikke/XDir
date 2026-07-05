# XDir

XDir is a Windows desktop library manager for locally stored games and archives. It scans a configured library folder, identifies titles from local names or source links, and enriches entries with metadata from F95Zone, DLsite, and Itch.io.

## Current scope

- Scan a local games directory for folders, `.exe` files, and archives
- Maintain a local SQLite library with tags, notes, screenshots, and progress
- Link or auto-detect supported sources
- Sync metadata through the bundled browser extension
- Handle duplicate records and transient directory misses more safely

## Stack

- Python
- FastAPI
- SQLAlchemy
- pywebview
- Vanilla HTML/CSS/JS frontend

## Run locally

1. Create a virtual environment.
2. Install dependencies from `requirements.txt`.
3. Start the app:

```powershell
python app.py
```

For API-only mode:

```powershell
python app.py --server-only
```

## Browser extension

The bundled extension lives in [extension](D:\Dev 2026\Fun\XDir\extension). Load it as an unpacked Chromium extension to sync metadata from supported sites.

## Notes

- The app is Windows-focused.
- Local library data is not intended to be committed to Git.
- No open-source license has been added yet. Until one is chosen, treat the repository as all rights reserved.
