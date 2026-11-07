# Service Book

A service log for the BMW iDrive 7 head unit (MGU): every service and repair done on the car, plus what's due next. Installed and updated through [mgu-store](https://github.com/robertnisipeanu/mgu-store).

**Status:** pre-milestone 1. The only app so far is **SB Probe** (`apps/sp_probe`), a one-off helper that copies reference files off the head unit without SSH ([docs/probe.md](docs/probe.md)). See [docs/research.md](docs/research.md) for what is confirmed and what is still open.

## Planned features

- **Log:** entries with date, km, type, cost, workshop and notes, newest first.
- **Add / edit:** km filled from the odometer; text typed on BMW's on-screen keyboard.
- **Due:** recurring items by km and/or time, with ok / soon / overdue states.
- **Backup:** export and import the whole log as JSON on a USB stick.
- **Stats (later):** spend per year and category, cost per km.

## Development

Apps live in `apps/<id>/` as `app.json` + `main.js`, built by the vendored kit (`kit/`, MIT, from [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)). The head unit builds them from source through `mgu-repo.json`.

```bash
python3 kit/tools/build.py --preview-only sp_probe
node kit/tools/preview.js dist/sp_probe
node test/probe_tar.test.js
node test/probe_e2e.test.js
```

With SSH access, `tools/unit-dump.sh -i <key>` pulls the reference files into the git-ignored `unit-dump/` folder (read-only on the unit). Without it, use SB Probe.

BMW SDK files, anything extracted from the unit, built packages, VINs and keys must never be committed. `.gitignore` covers the known paths.
