# Service Book 0.3.0

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
- **Reference only.** The app sends nothing to the car: the catalog has no way for an app to press steering-wheel buttons or reach the DME (checked 2026-11-08).

Next: import from a USB stick, then the Due and Stats screens.

## Files

| File | What it does |
|---|---|
| `app.json` | id `sp_servicebook`, one `canvas` screen, `KombiIF.statusRangeTankStatus` (`rs`), `VehicleInformation.VehicleType` (`s`), no internet. Both flags pass `kit/tools/check_signals.py` against the car's catalog. |
| `main.js` | The pages: header with the **Service log**, **Car** and **Custom Code** tabs, odometer, **+ Add entry**, the rows. A row opens it for editing. Every handler is wrapped. |
| `car.js` | The Car page: model (series → name table plus your variant), body, VIN, km, document tiles. |
| `customcode.js` | The Custom Code page: the CCM table (`FEATURES`) and a drawn tachometer whose needle shows the picked submenu or value. |
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
| 18 | Uninstall is **not** part of the test | An uninstall deletes the data folder. Use updates only. |

**If something fails, send a photo of the screen.** The most likely failure is #4, if touch doesn't reach sheets in this layout. The fallback then is the controller (#9).

**Result on the car (2026-11-08):** passed. The touch keyboard works, the odometer shows the car's km, the Car tab shows G01 · Sports Activity Vehicle (so `VehicleType` arrives as enum names) and a 17-character VIN, an RCA period shows the right days left, and the log entry, RCA period and variant all survived a head-unit restart. Milestone 1 is done.
