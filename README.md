# Service Book

A service log for the BMW iDrive 7 head unit (MGU): every service and repair done on the car, plus what's due next. Installed and updated through [mgu-store](https://github.com/robertnisipeanu/mgu-store).

**Status:** **Service Book** 0.5.2 (`apps/sp_servicebook`) has the log list, Add/Edit typed on the app's own touch keyboard, the live odometer, a Car tab (model, VIN, km, RCA / CASCO / Rovinieta / ITP), a Custom Code tab that reads and sets MG Flasher's map, Max Cooling, exhaust flap and valet over the car's own diagnostic link (no ENET adapter), and USB import of history and documents; it passed the car checklist on 2026-11-08 and 2026-11-10 ([docs/servicebook.md](docs/servicebook.md)). Two helpers used along the way, **SB Probe** (reference dump of the head unit) and **MGF Read Test** (the MG Flasher link tests), were removed on 2026-11-10; they are in git history before that commit. See [docs/research.md](docs/research.md) for what is confirmed and what is still open.

## Planned features

- **Log:** entries with date, km, type, cost, workshop and notes, newest first.
- **Add / edit:** km filled from the odometer; text typed on BMW's on-screen keyboard.
- **Due:** recurring items by km and/or time, with ok / soon / overdue states.
- **Backup:** export and import the whole log as JSON on a USB stick.
- **Stats (later):** spend per year and category, cost per km.

## Development

Apps live in `apps/<id>/` as `app.json` + `main.js`, built by the vendored kit (`kit/`, MIT, from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)). The head unit builds them from source through `mgu-repo.json`.

```bash
python3 kit/tools/build.py --preview-only sp_servicebook
node kit/tools/preview.js dist/sp_servicebook <outdir>
node test/servicebook.test.js
node test/servicebook-mgf.test.js
```

With SSH access, `tools/unit-dump.sh -i <key>` pulls the reference files into the git-ignored `unit-dump/` folder (read-only on the unit). Without it, SB Probe did the same through the Store (removed; see git history).

BMW SDK files, anything extracted from the unit, built packages, VINs and keys must never be committed. `.gitignore` covers the known paths.
