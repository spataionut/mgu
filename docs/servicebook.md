# Service Book 0.5.2

`apps/sp_servicebook`. Milestone 1 (0.1.0) has:
- a log list, newest first
- Add and Edit, typed on a keyboard the app draws itself
- the odometer, read live
- a log file that survives crashes and restarts

0.2.0 adds a **Car** tab:
- **Model:** `BMW X3` comes from the series the car reports (G01). You type the variant (M40i) once.
- **Identity:** the series and body type, the VIN and the total km.
- **Documents:** a tile each for **RCA, CASCO, Rovinieta and ITP**, showing the days left in green, amber (30 days or fewer) or red (expired).
  - A tile opens a card with **Edit** and **Renew**. Renew starts the next period the day after the current one ends; the old periods are kept.
  - Saving a new ITP also adds an "Inspection" entry to the log.

0.3.0 adds a **Custom Code** tab: a guide to MG Flasher's Custom Code Menu (CCM), so the steps don't have to be remembered.
- In the CCM, the cruise-control buttons move through the menu, and the tachometer needle shows the submenu (feature) and then the value.
- The tab lists the features in use, with their needle positions: **Switchable Maps** (1K: this car's maps, 100 RON max power 0K, 95 RON max power 1K, stock 2K), **Max Cooling** (3K: Disable 0K, Enable 1K), **Exhaust Flap** (6K: Automatic 0K, Closed 1K, Opened 2K), **Valet Mode** (7K: Disable 0K, Enable 1K). 0K (READY) is Exit. Burbles, Antilag RPM and Ethanol Content Override are left out on purpose.
- Tap a feature and the drawn tachometer points at its submenu. Tap a value and it points at that value.
- **Reference only.** The app sends nothing to the car. (Apps can reach the DME through the head unit's diagnostic link; MG Flasher's commands aren't known yet. See [research.md](research.md).)

0.4.0 adds **USB import**, for history and documents typed on the Mac instead of in the car. See [Import from USB](#import-from-usb).

0.5.0 makes **Custom Code** live: it reads MG Flasher's settings from the DME and sets them, with no ENET adapter. See [Custom Code live](#custom-code-live).

0.5.1 fixes Custom Code staying info only after the car has slept ("last command 00 00"). See the sanity check under [Custom Code live](#custom-code-live).

0.5.2 lets Custom Code set the map, Max Cooling and the exhaust flap **while driving**, as MG Flasher's own menu does. Valet Mode is still set only stopped in P, because it cuts power at once.

Next: the Due and Stats screens.

## Files

| File | What it does |
|---|---|
| `app.json` | id `sp_servicebook`, one `canvas` screen, `KombiIF.statusRangeTankStatus` (`rs`), `VehicleInformation.VehicleType` (`s`), no internet. Both flags pass `kit/tools/check_signals.py` against the car's catalog. |
| `main.js` | The pages: header with the **Service log**, **Car** and **Custom Code** tabs, odometer, **+ Add entry**, the rows. A row opens it for editing. Every handler is wrapped. |
| `car.js` | The Car page: model (series → name table plus your variant), body, VIN, km, document tiles. |
| `customcode.js` | The Custom Code page: the CCM table (`FEATURES`) and a drawn tachometer whose needle shows the picked submenu or value. 0.5.0: a green dot on each setting's current value, the armed value outlined, and a status line. |
| `mgf.js` | 0.5.0: MG Flasher's settings over the head unit's diagnostic link (`InternalTasu`, DME `0x12`). `check()` allows only the captured reads and each setting's own writes. Sets and confirms as the MG Flasher app does. |
| `carstate.js` | The write gate, from signals no older than 3 s: engine over 400 rpm; for Valet Mode also live speed under 1 km/h and not in R/N/D (0.5.2; before, every setting needed that). |
| `importer.js` | USB import: finds `servicebook-import.json` on the sticks under `/media`, checks every item, and works out what's new. Also a checker on the Mac: `node apps/sp_servicebook/importer.js <file>`. |
| `docs.js` | Document status, and the period form: valid from/until (date pad, Today, length pills such as 12 months = from + 12 months − 1 day), insurer or station, policy/serial number, km for ITP, cost. Delete takes two taps. |
| `dates.js` | Calendar maths on `YYYY-MM-DD`. |
| `form.js` | The Add/Edit sheet: type pills, date (−/+/Today), km (number pad, or **Odometer**), notes, cost and workshop (keyboard), Save and Cancel. Delete takes two taps within 4 s. |
| `keyboard.js` | The keyboard sheet: QWERTY with `- ' , . ?`, a 123 page (digits, `@ # € & * ( ) / : ; + % = " ! _ < > [ ]`), shift (tap twice for caps lock), space, backspace, Cancel and Done. The number pad is for km. The date pad takes 8 digits, shows them as YYYY-MM-DD, and refuses dates that don't exist. |
| `store.js` | `<dataDir>/servicebook.json`. Writes go temp file → fsync → rename → fsync the folder. Each write first copies the old file to `backups/` and keeps the last 20. A damaged file is kept as `.corrupt-<time>`, and the newest good backup is loaded instead, with a warning on screen. The car details and document periods live in the same file (`car`), so they get the same protection. 0.1.0 files load unchanged. |

The kit's `display.js` has one small patch: a sheet with a `tilt(dir)` method takes controller pushes up and down itself. The keyboard uses this to move between rows.

**Fonts:** the kit's fonts have no arrow glyphs (they come out as empty boxes), so the backspace and shift icons are drawn as shapes.

**Where the car details come from:**
- **Series and body:** `de.bmw.infrastructure.VehicleInformation.VehicleType`, instance 1. It has a notifier only, so it shows once the car sends it. Until then the page says "series not reported yet".
- **VIN:** the app's `VIN` environment variable, which the OAP platform sets; BMW's SDK `getVin()` reads the same variable. It's shown on screen only: it's not written to the log file, the app's log or the repo. (`VehicleInformation.ChassisNumber` exists too, but it holds only 7 bytes.)
- **Model name:** the car doesn't report one. The table in `car.js` maps the series to a name (G01 → X3), and you type the variant.

## Import from USB

Fill the log and the documents from a file made on the Mac.

1. Write the file. [import-example.json](import-example.json) shows the format, with made-up values. Keep the real file in `private/` (git-ignored, as is any `servicebook-import*.json`), because it holds policy numbers and history.
   - `type` is one of: Oil & filter, Brakes, Spark plugs, Tyres, Air/cabin filter, Fluids, Battery, Coding/Mods, Inspection, Other (case doesn't matter).
   - Dates are `YYYY-MM-DD`. `km` is a number. `cost`, `workshop`, `notes`, `who` (insurer or ITP station) and `number` are free text.
   - `docs` has a list each for `rca`, `casco`, `rovinieta` and `itp`; older periods can go in too. `variant` sets the model variant.
2. Check it the way the car will:
   ```bash
   node apps/sp_servicebook/importer.js private/servicebook-import.json
   ```
3. Copy it to the **top** of the stick as `servicebook-import.json`, and plug the stick into the car.
4. Service log → **USB import**. The card shows what's new; **Import** adds it.

What it does and doesn't do:
- It **only adds**. An entry already in the log (same date, type and km) or a period already there (same from and until) is skipped, so importing the same file twice is safe.
- **All or nothing.** If any item has a problem, nothing is imported, and the card names the first problem; the checker on the Mac lists all of them.
- One write, with the usual backup of the log taken first.
- An imported ITP doesn't add an Inspection entry; put that in `entries` if you want it.
- If no file is found, the card lists each folder under `/media` and what happened there (not found, or the error), which shows whether apps can read the stick at all.

## Custom Code live

How it works (the bytes and addresses are in `mgf.js`; the capture and head-unit tests are in [mgflasher-capture.md](mgflasher-capture.md)):
- **When it talks to the DME:** nothing is sent until the Custom Code tab is opened. Then it reads the four settings and the last command id about every 5 s, only while that tab is on screen.
- **Sanity check:** every value must be in range and the last id must end in `69`, or read `00 00`. The DME's RAM is cleared each time the car wakes, so until MG Flasher or this app sends a command it reads `00 00` (seen in the car 2026-11-13; 0.5.0 treated that as a wrong build). `00 00` never counts as a confirmation. Otherwise the page says the settings don't read as expected and stays info only: no write. MG Flasher keeps the settings at RAM addresses that may move after an MG Flasher update.
- **Current value:** each setting's current value has a green dot.
- **Setting a value:** tap a value to arm it ("Tap again to set"), and tap it again within 5 s to send. It only goes while the engine runs (live engine speed). Since 0.5.2 the map, Max Cooling and the flap also go while driving, at any speed and in any gear (the owner's choice, 2026-11-13). **Valet Mode** still needs the car stopped (live speed) and the selector in P, because it cuts power at once. Otherwise the status line says why.
- **Confirmation:** after the write, the last command id must read the setting's id and the setting must read the new value. Only then is it "confirmed by the DME". Otherwise the line says what it read.
- **Signals added:** `InternalTasu` (`sendTasuRequest` / `sendTasuResponse`), `Vehicle2.statusCarSpeed2`, `CDS.statusEngineSpeed2`, and `VehicleInformation.statusGearboxDrive` / `DataPowerTrain2`. All are optional: a unit without them installs the app, and the page stays info only.
- **Tests:** `node test/servicebook-mgf.test.js` checks the guard, the settings against a stubbed DME, a write that isn't taken, a fresh DME (last `00 00`), the write gate (driving vs Valet), a build that reads wrong, no answer, and the page.

## Controls

- **Touch:** tap keys, pills and fields. A key fires when the finger lifts, as everywhere in the kit.
- **iDrive controller:**
  - **Knob:** moves along the keys or fields.
  - **Push up or down:** moves to the row above or below. Pushing up from the top row goes to the header.
  - **Press:** types or acts.
  - **Push left:** Cancel.
- **Without the GPU renderer** (software path): the list still shows, but it's read-only and **Add entry** isn't offered. The keyboard and form are sheets, and sheets need mgu-render.

## Checks on the desk

```bash
node test/servicebook.test.js
```

This builds the preview package, then:
- drives the keyboard (typing, auto capital, caps lock, symbols, max length, knob rows, number pad)
- drives the form (type, keyboard round trip, km, date, save, edit, two-tap delete, a disk error)
- tests the store (reload, ordering, backups capped at 20, damaged file, missing file)

Set `SB_SHOTS=<folder>` to also write PNG frames of each sheet. The main page on the software path:

```bash
node kit/tools/preview.js dist/sp_servicebook <outdir>
```

`<outdir>` is the data folder there; put a `servicebook.json` in it to see rows.

## On the car

Install it from the Store's GitHub source once it's pushed to `main`: Store → **Check now** → **Service Book** → Install. Nothing else on the unit changes.

**An update that isn't pushed (0.5.0):** the Store updates an app only from the source that installed it, here `github:spataionut/mgu`. It refuses a loose `.tgz` on a stick ("Not installable": the id belongs to another source). Instead, put a **checkout** on the stick: `usb-repo` writes `mgu-copy.json` naming the checkout's GitHub remote, so the Store treats the folder as the same source and the unit builds from it. `usb-repo` copies git's tracked files only, so for uncommitted work, export the tracked and untracked (not ignored) files to a scratch folder, `git init` and `git add -A` there, set the same `origin` remote, then:
```bash
node mgu-install.js usb-repo /Volumes/MGU <export folder>
```

| # | Check | Pass when |
|---|---|---|
| 1 | Open Service Book | The header says SERVICE LOG, and the odometer shows the cluster's km within a minute. |
| 2 | **Odometer vs cluster** | Same number as the cluster's total km. Note any offset. |
| 3 | Tap **+ Add entry** | The form opens over the page, with km already filled from the odometer. |
| 4 | Tap **Notes** | The keyboard opens. Keys respond to touch, and the first letter is a capital. |
| 5 | Type `Front pads` and check backspace, shift, 123 and back to ABC | The field shows exactly what was typed. |
| 6 | **Done** | Back on the form, Notes shows the text. |
| 7 | Tap **KM**, Clear, type a number, Done | The km field shows it, with a space every 3 digits. |
| 8 | Pick a type, **Save** | The form closes. The row appears at the top, and "Saved: …" shows at the bottom. |
| 9 | Controller: open Add, then turn, push up and down, press, push left | The focus ring moves over the pills and fields. On the keyboard, push up and down change rows, press types, push left cancels. |
| 10 | Tap the row, Edit, Save | The change shows. Tap Delete twice, and the row is gone. |
| 11 | Add 2–3 entries, then **restart the head unit** (hold the volume knob until it reboots, or ignition off, lock, wait 5 min) | Every entry is still there after the restart. |
| 12 | **Car** tab | Shows BMW X3, then G01 · Sports Activity Vehicle (once the car sends it), the VIN matching the registration document, and the km. |
| 13 | Model **Add variant**, type `M40i`, Done | It shows **BMW X3 M40i**. |
| 14 | **RCA** tile: valid from (date pad), **12 months**, insurer, Save | The tile shows days left and the colour. Check the date against the policy. |
| 15 | RCA tile again → **Renew** | The new period starts the day after the old one ends. |
| 16 | **ITP** tile: add a period with km | The log gets an Inspection entry. |
| 17 | Restart the head unit | The variant and all documents are still there. |
| 18a | **Custom Code** tab | Four features with their needle positions. Tapping a value moves the drawn needle. Compare with MG's menu on the real tachometer once. |
| 18b | **USB import** with the stick that has `servicebook-import.json` | The card shows the expected counts. Import adds them, and the Car tiles show the documents. A second Import says "Nothing new". |
| 18c | 0.5.0 **Custom Code**, stopped with the engine running | Green dots match MG Flasher. Map → 100 RON, tapped twice, says confirmed. Do the same for Max Cooling, Flap and Valet, one at a time, and set each back. |
| 18 | Uninstall is **not** part of the test | An uninstall deletes the data folder. Use updates only. |

**If something fails, send a photo of the screen.** The most likely failure is #4, if touch doesn't reach sheets in this layout. The fallback then is the controller (#9).

**Result on the car (2026-11-08):** passed. The touch keyboard works, the odometer shows the car's km, the Car tab shows G01 · Sports Activity Vehicle (so `VehicleType` arrives as enum names) and a 17-character VIN, an RCA period shows the right days left, and the log entry, RCA period and variant all survived a head-unit restart. Milestone 1 is done.

**0.3.0 and 0.4.0 on the car (2026-11-08):** passed.
- **18a:** the Custom Code tab draws the dial and the four features as designed.
- **18b:** USB import read the file from the stick, so apps can read sticks. It added 6 entries and 4 document periods. The log shows 7 entries, and the Car tiles show RCA, CASCO, Rovinieta and ITP with days left.
- Everything survived a head-unit restart.

**0.5.0 on the car (2026-11-10):** passed (18c). Installed from a stick copy of the GitHub source. In Custom Code the green dots matched MG Flasher, and the map, Max Cooling, flap and valet were each set from the head unit and **confirmed by the DME**, then set back.

**0.5.0 on a later drive (2026-11-13):** Custom Code showed "don't read as expected (last command 00 00)" and stayed info only: the last command id is `00 00` until a command is sent after the car wakes. Fixed in 0.5.1, not yet tested in the car.

**0.5.2 (2026-11-13):** the map, Max Cooling and flap may be set while driving; Valet only stopped in P. Not yet tested in the car. To test: while driving, set the flap and say it is confirmed; Valet while moving must say "not now: the car is moving".
