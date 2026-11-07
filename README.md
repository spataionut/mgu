# Service Book

A service log for the BMW iDrive 7 head unit (MGU): every service and repair done on the car, plus what's due next. Installed and updated through [mgu-store](https://github.com/robertnisipeanu/mgu-store).

**Status:** pre-milestone 1. No installable app yet. See [docs/research.md](docs/research.md) for what is confirmed and what is still open.

## Planned features

- **Log:** entries with date, km, type, cost, workshop and notes, newest first.
- **Add / edit:** km filled from the odometer; text typed on BMW's on-screen keyboard.
- **Due:** recurring items by km and/or time, with ok / soon / overdue states.
- **Backup:** export and import the whole log as JSON on a USB stick.
- **Stats (later):** spend per year and category, cost per km.

## Development

Pull the reference files off the head unit into the git-ignored `unit-dump/` folder. This only reads from the unit:

```bash
tools/unit-dump.sh -i /path/to/ssh/key
```

BMW SDK files, anything extracted from the unit, built packages, VINs and keys must never be committed. `.gitignore` covers the known paths.
