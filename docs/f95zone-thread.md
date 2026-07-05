[CENTER]
[SIZE=7][B]XDir v0.1.1[/B][/SIZE]
[SIZE=4]Game Library Manager for F95Zone, DLsite, Itch.io and local archives[/SIZE]
[/CENTER]

[B]TL;DR:[/B] XDir is a Windows desktop app for keeping a local adult game library in one place. It scans your game folders, helps detect and merge duplicate entries, stores progress and notes locally, and can enrich games with metadata from sources like F95Zone, DLsite, and Itch.io through the bundled browser-helper workflow.

XDir is directly inspired by XLibrary. I liked the idea of having a dedicated library manager for this space, but I wanted something that felt less cluttered, more local-first, and friendlier to the way I actually store games in folders, archives, and mixed install directories. The focus here is not trying to do everything at once, but making folder-based library management faster, cleaner, and more reliable for people who keep their collection on disk.

[SIZE=5][B]Key Features[/B][/SIZE]

[LIST]
[*][B]Local-first desktop app[/B] - Windows release with portable-style packaging and local SQLite storage
[*][B]Folder and archive scanning[/B] - scan game folders, executables, and archives into one library
[*][B]Metadata linking[/B] - attach supported source URLs and enrich entries from F95Zone, DLsite, and Itch.io
[*][B]Duplicate handling[/B] - merge weak duplicates more safely during ingestion and startup maintenance
[*][B]Library tracking[/B] - keep installed entries, archive-only entries, wishlist items, notes, tags, and progress in one place
[*][B]Manual linking flow[/B] - paste a supported thread or store URL and fetch the related metadata
[*][B]Cleaner UI pass[/B] - refreshed blue-accent UI, denser library cards, and improved settings coverage
[/LIST]

[SIZE=5][B]Quick Start[/B][/SIZE]

[LIST=1]
[*]Download the Windows build from the link below
[*]Extract [ICODE]XDir-0.1.1-windows.zip[/ICODE] to a normal folder
[*]Run [ICODE]XDir.exe[/ICODE]
[*]Configure your game directory in Settings
[*]Optionally use the bundled extension/helper flow to import metadata from supported sites
[/LIST]

[B]Important:[/B] do not move only the exe by itself. The packaged runtime files need to stay beside [ICODE]XDir.exe[/ICODE].

[SIZE=5][B]What Is New In 0.1.1[/B][/SIZE]

[LIST]
[*]Immediate branded startup splash instead of a hidden first-launch window
[*]Startup maintenance moved off the blocking boot path so the library opens sooner
[*]Lower cold-start overhead for the packaged app and a more responsive first-run feel
[*]Carries forward the blue UI refresh, duplicate handling improvements, and packaged branding work from 0.1.0
[/LIST]

[SIZE=5][B]Screenshots[/B][/SIZE]

[B]Main library overview[/B]

[B]Game details overview[/B]

[B]Built-in screenshot gallery[/B]

[B]Settings and metadata tools[/B]

[B]F95 integration overlay[/B]

[B]DLsite integration overlay[/B]

[B]External page integration overlay[/B]

[SPOILER=Technical Details]
[B]Stack:[/B] Python - FastAPI - SQLAlchemy - pywebview - Vanilla HTML/CSS/JS

[B]Storage:[/B] local SQLite database

[B]Packaging:[/B] PyInstaller Windows build

[B]Platform:[/B] Windows

[B]Requirements:[/B] a local game/archive directory to scan and, optionally, a Chromium-based browser for the metadata helper flow
[/SPOILER]

[SPOILER=Current Scope and Known Limits]
[LIST]
[*]Windows-focused release for now
[*]No auto-updater yet
[*]No cloud sync yet
[*]Portable zip release, not a full installer
[*]Source integrations depend on external site markup staying compatible
[/LIST]
[/SPOILER]

[SPOILER=Planned and Next Improvements]
[LIST]
[*]Broader settings coverage and quality-of-life controls
[*]More resilient source detection and metadata recovery
[*]Further scan performance improvements on large libraries
[*]Better per-game detail pages and import flows
[*]Formal installer and smoother release/update flow
[/LIST]
[/SPOILER]

[SIZE=5][B]Feedback Wanted[/B][/SIZE]

The most useful reports right now are:

[LIST]
[*]Duplicate detection edge cases
[*]Entries that lose metadata or reappear as clones
[*]Directory scan reliability issues
[*]UI inconsistencies or awkward workflows
[/LIST]

[SIZE=5][B]Source / Issues[/B][/SIZE]

[B]GitHub Repo:[/B] [URL=https://github.com/notvikke/XDir]notvikke/XDir[/URL]

[B]Issues / Bug Reports:[/B] [URL=https://github.com/notvikke/XDir/issues]GitHub Issues[/URL]

If you want to report bugs or follow changes, GitHub is the main place for that right now.

[SIZE=5][B]Download[/B][/SIZE]

[B]GitHub Release Page:[/B] [URL=https://github.com/notvikke/XDir/releases/tag/v0.1.1]XDir v0.1.1 Release[/URL]

[B]Windows Build (.zip):[/B] [URL=https://github.com/notvikke/XDir/releases/download/v0.1.1/XDir-0.1.1-windows.zip]XDir-0.1.1-windows.zip[/URL]

[B]SHA / VirusTotal:[/B] add these before posting if you want the thread to look more complete.

[SIZE=5][B]Notes[/B][/SIZE]

XDir is an independent project and is not affiliated with F95Zone. Library data stays local on your machine in the current release build.

[SIZE=5][B]Suggested Thread Title[/B][/SIZE]

[CODE][Tool] XDir [v0.1.1] - Game Library Manager for F95Zone, DLsite, Itch.io and local archives[/CODE]
