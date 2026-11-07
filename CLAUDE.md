# Service Book: iDrive 7 service log app

A personal app for the BMW iDrive 7 head unit (MGU) that keeps a log of every service and repair done on the car, and shows what's due next. Installed and updated through **mgu-store** (robertnisipeanu/mgu-store), which is already installed on the car.

## The car and setup

- Car: BMW X3 M40i (G01), iDrive 7 / MGU, touchscreen.
- Head unit has root SSH access (key-based). Default address over the car's Wi-Fi hotspot: `172.16.222.97`, port 22. Ask the user for the key path; never commit keys.
- mgu-store is installed and working: Store app, updater, deploy tool, renderer, Python, internet uplink 0.7.7.
- The user installs offline via USB stick with `node mgu-install.js usb-repo /Volumes/MGU <inputs>` (stick is FAT32, 32 GB partition, MBR), or via a GitHub source added in the Store.
- Developer machine: macOS.

## What the app does

1. **Log**: list of service entries, newest first: date, km, type, cost, workshop, notes.
2. **Add / edit entry**:
   - Type picked from a list: Oil & filter, Brakes, Spark plugs, Tyres, Air/cabin filter, Fluids, Battery, Coding/Mods, Inspection, Other.
   - Date defaults to today.
   - **km is filled automatically from the car's odometer** (editable).
   - Cost, workshop, notes are free text.
   - **Text input uses BMW's native on-screen keyboard (the "speller") through an RHMI input component.** The user wants touchscreen typing. No phone/web page for input; that idea was rejected.
3. **Due**: recurring items with intervals in km and/or time (e.g. oil every 10,000 km or 12 months), shown as "due in X km / Y days" with colour states (ok / soon / overdue). A "Done today" action logs a new entry for that item.
4. **Stats** (later): spend per year and per category, cost per km.
5. **Backup**: export/import the whole log as JSON to/from a USB stick.

## Hard requirements and rules

- **Never commit BMW SDK files** (`oap-sdk/`), anything extracted from the unit (catalog, app bundles), built `.mgu` files containing the SDK, VINs, keys or provisioning files. Put them in `.gitignore` from the first commit.
- Publish in the mgu-store **repo-tree layout**: an `mgu-repo.json` at the repo root, with the head unit building the app from source. Read mgu-store's `docs/PUBLISHING.md` before writing it, and use `nickgcode/idrive7-apps` (a working repo-tree source for iDrive 7) as the reference for structure.
- App id must be unique and prefixed, e.g. `sp_servicebook`. Set `mguHmi: ["ID7"]`. No internet needed (`mguInternet` false/absent).
- Don't guess signal names, widget names or APIs. Check them against the unit's own SOME/IP catalog and existing working apps.

## Data safety (important)

The OAP platform's `CorruptAppsHandler` **wipes an app's data folder if the app crashes, and uninstalls it on the second crash.** This log is personal and irreplaceable, so:
- Write the log atomically (temp file + rename) and keep a rolling backup copy.
- Investigate whether the app can also write a backup outside its own data folder (e.g. a path its permissions allow). If not, make USB export prominent and easy.
- Wrap all handlers so an exception never kills the process.
- Never `kill` an app process on the unit. Restart the platform with `systemctl restart oapcontroller`.

## Platform knowledge (from cauliflowermossgrape/idrive7-apps)

- Apps are Node.js 8 packages run by BMW's OAP platform (MainApp), one Linux user per app, installed under `/var/opt/public/oap/oap_<uid>/`.
- Screens are described with BMW RHMI widgets (`rhmiData/`). Apps push text, list rows, images and visibility, and receive clicks.
- That repo's kit gives `app.json` + `main.js` → generated package, with `ctx.ui`, `ctx.settings`, `ctx.dataDir`, `ctx.signals`, `ctx.log`. Tools: `kit/tools/build.py`, `preview.js` (renders on the PC with a stubbed head unit), `extract_sdk.js`, `check_signals.py`, `sigdoc.py`. Its `docs/rhmi-widgets.md` documents widgets and ids.
- The kit's existing apps use canvas images + buttons + settings screens, **not text input**. Adding an RHMI input/speller component is new work. Research it first: the unit's widget templates, BMW's own apps on the unit (e.g. how they declare input fields), and the bimmergestalt/IDriveConnectKit RHMI model (Input component + speller actions).
- Signal flags: `r` = read once (needs a getter), `s` = subscribe (needs a notifier). The installer rejects `r` on fields without a getter.
- Useful files on the unit:
  - SOME/IP catalog: `/etc/oap/someip/someip-interfaces.json`
  - A BMW app bundle for SDK extraction: `/var/opt/public/oap/oap_12204/source/javascript/app.js`

## First steps

1. Create the repo skeleton, `.gitignore` and `README.md`.
2. With the user, copy the catalog and one BMW app bundle off the unit into ignored local folders; extract the SDK for local preview only.
3. Find the odometer / total mileage field in the catalog (search for mileage, odometer, kilometer, `km` in field names; check getter/notifier and scaling).
4. Find how RHMI text input with the speller is declared and how the entered text comes back to the app.
5. **Milestone 1 (test build):** a minimal app with one list screen, an "Add" screen with one text field using the speller, and a live mileage readout. Preview it locally, install it via USB, and verify on the car that (a) the speller opens and works by touch, (b) the text comes back, (c) mileage is correct, (d) data survives a head-unit restart.
6. Only after milestone 1 works on the car: build the full log, due-items, export/import and stats.

## Working style

- The user is technical (DevOps / observability background). Be concise, give exact commands, explain unit-side risks before running anything on the head unit.
- Any command that changes the head unit: say what it does first and prefer reversible steps (the mgu-store deploy tool snapshots before changes).
