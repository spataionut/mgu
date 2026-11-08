# Service Book 0.1.0: milestone 1 (test build)

`apps/sp_servicebook`. It has:
- a log list, newest first
- Add and Edit, typed on a keyboard the app draws itself
- the odometer, read live
- a log file that survives crashes and restarts

The Due and Stats screens and backup export come only after this works on the car.

## Files

| File | What it does |
|---|---|
| `app.json` | id `sp_servicebook`, one `canvas` screen, `KombiIF.statusRangeTankStatus` (`rs`), no internet |
| `main.js` | The page: header, odometer, **+ Add entry**, the rows. A row opens it for editing. Every handler is wrapped. |
| `form.js` | The Add/Edit sheet: type pills, date (−/+/Today), km (number pad, or **Odometer**), notes, cost and workshop (keyboard), Save and Cancel. Delete takes two taps within 4 s. |
| `keyboard.js` | The keyboard sheet: QWERTY with `- ' , . ?`, a 123 page (digits, `@ # € & * ( ) / : ; + % = " ! _ < > [ ]`), shift (tap twice for caps lock), space, backspace, Cancel and Done. The number pad is for km. |
| `store.js` | `<dataDir>/servicebook.json`. Writes go temp file → fsync → rename → fsync the folder. Each write first copies the old file to `backups/` and keeps the last 20. A damaged file is kept as `.corrupt-<time>`, and the newest good backup is loaded instead, with a warning on screen. |

The kit's `display.js` has one small patch: a sheet with a `tilt(dir)` method takes controller pushes up and down itself. The keyboard uses this to move between rows.

**Fonts:** the kit's fonts have no arrow glyphs (they come out as empty boxes), so the backspace and shift icons are drawn as shapes.

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
| 12 | Uninstall is **not** part of the test | An uninstall deletes the data folder. Use updates only. |

**If something fails, send a photo of the screen.** The most likely failure is #4, if touch doesn't reach sheets in this layout. The fallback then is the controller (#9).
