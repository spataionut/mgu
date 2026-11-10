# Research notes

What is settled about the car's head unit, and what is still open. "Unit" means checked on this car.

## The unit (from the 0.4.0 dump, 2026-11-08)

- Firmware `BMW MGU P18_23w44.2-1-3 mgu-high` (`/etc/os-release-id-dlt`), build `20231031083504`. Kernel 4.14.198-apl, x64, 4 CPUs, 5.6 GB.
- Node 8.16.2 (V8 6.2, OpenSSL 1.1.1t, ICU 60.2); apps run with `--max_old_space_size=192`.
- The SDK the unit built SB Probe with: `oap-sdk` 26.23.1. It is copied into the ignored `oap-sdk/`, so `python3 kit/tools/build.py <id>` makes installable packages on the Mac.
- Apps run as their own uid (the probe: 12223), with `HOME=/var/opt/public/oap/` and `cwd` = its data folder. The environment holds `VIN`, `INSTANCE_TYPE` and `HOME`. Only names are recorded; no VIN-shaped string is in the dump.
- Other apps' folders, `/var/opt/public` and `/var/opt/personal` can't be read by an app. So the dump has MainApp, `/etc/oap` and the probe's own installed package, not BMW's apps.
- `dump-2026-11-08T14-17-30-886Z` in `spataionut/mgu-dumps` holds 334 files (35 MB) and a 13,800-line filesystem index; it's unpacked in `unit-dump/`.
- **Probe bug for next time:** its key-material name filter was too broad. It skipped 4 SOME/IP interface definitions in MainApp's `src-gen` because their names contain "Private" or "Provisioning". They're definitions, not keys. A later probe should match key files by extension and content only.

## Publishing (confirmed from mgu-store `docs/PUBLISHING.md`, and on the car)

- Repo-tree layout: `mgu-repo.json` at the root. The Store reads it from a branch or from tags.
- Build on the unit: Node 8.16.2 or Python 3.12, no network, 10 minutes, 200 MB, one `<id>@<version>.tgz` as output.
- Two reference repos use the same shape: `apps/*` with `app.json`, built by `kit/tools/build.py {id}` with `"sdk": "oap-sdk"`.
- The kit is MIT licensed, so it can be vendored with its licence file (`nickgcode/idrive7-apps` does this).
- The Store installs from this repo's `main` branch and builds on the unit (SB Probe 0.1.0–0.4.0).

## Car results, 2026-11-08 (SB Probe 0.1.0, installed from the GitHub Store source)

- **Install:** accepted, so `KombiIF.statusRangeTankStatus` has a getter on this firmware and `rs` is valid.
- **Odometer:** `mileageKilometre` reads 27081 km and updates while driving (27083 km a few minutes later). Still to confirm it matches the cluster exactly.
- **USB stick:** writing fails with `EROFS` at `/media/C1C6-1DF2`. Sticks are mounted read-only, at least for app users. USB export from the app is not possible as-is; see Data safety. **Reading works:** on 2026-11-08 Service Book 0.4.0 read `servicebook-import.json` from the top of the stick and imported it (6 entries, 4 document periods), and the data survived a head-unit restart.
- **Wi-Fi server:** it starts, but a phone on the car's hotspot gets no answer. The unit's `ip filter` input chain (firewalldz) drops what it does not accept. mgu-store opens its own port 8470 with a root rule (`mgu-updater/README.md`, "Firewall"); an app's uid can't. **Apps can't serve anything to the hotspot.** Interfaces: `wlan_bridge 172.16.222.97` (hotspot), `vlan80 160.48.199.185`.
- **Next:** SB Probe 0.3.0 uploads to a release in the private `spataionut/mgu-dumps`, signed in through GitHub's device flow with the owner's own GitHub App, which is installed on that repo only. Names resolve through the lease's DNS servers, because the unit's resolver has no internet. It was checked against real github.com from the Mac, not yet with Node 8 on the unit. The 0.2.0 Mac receiver stays as a fallback.
- **0.4.0 widens the dump** for later apps: the whole OAP platform, every app's source, all of `/etc/oap`, identity files, systemd units, runtime facts and a filesystem index. Key material and apps' data are left out (the removed `docs/probe.md`, "What's in the dump", in git history). The GitHub upload goes in gzip parts, so memory stays low and a failed part is retried on its own.
- **Mac fallback:** the probe connects out instead of serving. It declares `mguInternet`, so mgu-uplink routes its uid through the uplink. It then finds `tools/receive-dump.py` (removed with the probe) on the uplink's subnet and uploads to it. The kit's `build.py` is patched to write `"mguInternet": true` when `app.json` says `"internet": true`.

## Odometer (settled)

- `de.bmw.infotainment.KombiIF`, instance `1`, field `statusRangeTankStatus` with flags `rs`: the install accepted it, and updates arrive while driving.
- It reads 27081 → 27083 km; whether that matches the cluster exactly is still to confirm.
- The same struct carries `range` (km), `fluidLevelFuelTank` (and left/right) and `statusFluidLevelFuelTankSpare`. Raw on the unit: `{"fluidLevelFuelTank":61,"fluidLevelFuelTankLeftHand":80,"fluidLevelFuelTankRightHand":37,"statusFluidLevelFuelTankSpare":"NICHT_AKTIV","range":478,"mileageKilometre":27083}`.

## Speller / text input (settled: OAP has none)

- MainApp's own RHMI component table (`usr/lib/oap-mainapp/src/main.js`) has 33 types:
  - containers and overlays: `state`, `overlay`, `player`, `icPopUp`, `icState`, `hudState`, `hudPopUp`, `hudMidPopUp`, `popUp`, `preview`, `previewMap`, `startWidget`
  - controls: `toolBar`, `button`, `label`, `checkBox`, `radioButton`, `title`, `toolBarButton`, `toolBarCheckBox`, `image`, `valueList`, `slider`, `progressBar`, `dropDownMenu`, `separator`, `bookmark`, `selectionBar`, `selectionBarButton`, `selectionBarCheckBox`
  - pickers: `timeRoll`, `dateRoll`, `editRoll`
- **There is no `input` and no speller type.** MainApp's code doesn't mention "speller" at all.
- `editRoll` is a row picker: it reports the focused row (`CurrentValue`) and sets `SelectedItem` on `Confirm`. It takes no text.
- So the requirement to type with BMW's own on-screen keyboard through an RHMI input component **can't be met on OAP**. BMW's speller exists in the HMI, but no OAP component reaches it. This is the user's decision. The options:
  1. **Pickers instead of typing:**
     - type from a list
     - workshop from a remembered list (new names added on the Mac or from a backup file)
     - km prefilled from the odometer
     - cost and corrections with `editRoll` digit rolls
     - notes from preset phrases
  2. **A keyboard drawn by the app and driven by touch:** the kit's GPU renderer and mgu-store's mgu-render/inputgate, which the car already runs for other Store apps. It's more work, and it isn't BMW's speller.
  3. **The phone page:** typing on the phone, which was rejected earlier.
- **Decided 2026-11-08: option 2, an app-drawn keyboard.** The parts are already on the car and in the vendored kit:
  - **Car:** mgu-render is installed (`/run/mgu-render/render.sock`, `mgu-render.socket`) beside upstream's `idrive7-renderd`, and so is mgu-inputgate (`hmi.service.d/zz-mgu-inputgate.conf`).
  - **Kit:** `kit/runtime/display.js` runs a `canvas` screen itself on mgu-render/1. It draws the header, page and slim bar, claims them for touch, and holds the iDrive controller while the screen shows.
  - **Kit:** `kit/runtime/sheet.js` sheets draw over the page and return tap targets. Touch goes to the targets; the knob goes to `move`/`press`/`back`. The keyboard is such a sheet, opened with `ctx.sheet(...)`.
  - **Licence:** everything used is MIT (the kit). mgu-store's own `mgu_render_client.js` is GPL-3.0 and is not copied.
  - **Not checked on the car yet:** mgu-render's README lists "touch in embed mode" as unverified. The kit uses the `layer` placement, where the Store's own screens already take touch on this car.
  - **Preview:** `kit/tools/preview.js` draws the software path, which has no touch. The keyboard sheet is tested by calling its `draw()` and targets directly, and its frames are rendered to PNG with `canvas.js`.
  - **Built:** Service Book 0.1.0 ([servicebook.md](servicebook.md)), with the car checklist there. The kit's fonts have no arrows (`← ↑ →` are baked as empty boxes; `✓ € …` are fine), so the keyboard draws those icons as shapes.

## MG Flasher's Custom Code from the head unit (open, 2026-11-08)

**Correction:** the 0.3.0 note said apps can't reach the DME. That was wrong. The catalog search looked at vehicle signals only and missed the diagnostic transport.
- **The link:** `com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu` (instance `SystemFunctionsInternalTasuInst1`), method `sendTasuRequest`, broadcast `sendTasuResponse`. It is the head unit's own UDS transport, used by BMW's `ts_diagnostic_service`, so no ENET adapter is involved. The vendored kit already wraps it: `kit/runtime/diag.js` (any request) and `kit/runtime/readonly-diag.js` (reads only). The DME is address `0x12`.
- **Proof it works on G cars:** upstream's `apps/live_adjustments` ("Engine Config" 0.8.1) sends DME and DSC commands through it from an app, and declares it in `app.json` as above.
  - **Exhaust flap, BMW's own job (no tuner needed):** `2F 60FD 03 03E8` open, `2F 60FD 03 2328` close, `2F 60FD 00` back to the DME. Tested on MG1 cars. The DME drops a tester's command after about 20 s, so the app re-sends every 15 s.
  - **Tuner commands:** BM3 and MHD only. MHD: `2F 01 <map-1>` switches the map, and `2F 03 01` / `2F 03 00` switches Max Cooling (engine running only). These were captured over ENET on an MHD car. `2F 01 02` made the check-engine light flash, which is MHD's map-change sign. **There are no MG Flasher commands.** The README asks owners to capture them.
  - xDrive off (DSC `2E DB E1 00`) was measured on a **G01 X3 M40i** through the same link.
- **Captured 2026-11-10** (`tools/mgf-capture.sh` with the iPhone on USB, then `tools/hsfz-parse.py`). MG Flasher's link to the adapter is plaintext HSFZ. Each feature is one UDS write to the DME in the default session, with no security access. The DME answers it with a non-standard negative reply, and MG Flasher confirms the change by reading the new state from RAM. All four features were seen, with the values the CCM table expects. The command bytes and addresses are in `apps/sp_servicebook/mgf.js`. The capture and full notes stay in git-ignored `private/`. The RAM addresses may change with an MG Flasher update.
- **Head unit, 2026-11-10:** reads work (MGF Test 0.1.0), and so does a confirmed map write (0.2.1). Service Book 0.5.0 sets all four settings, each confirmed in the car ([mgflasher-capture.md](mgflasher-capture.md)).
- *(Before the capture:)* - **What MG Flasher sends is unknown.** Its menu numbers (1 maps, 3 Max Cooling) look like MHD's `2F 01` and `2F 03`, but that is a guess. **No guessed command goes to the DME.**
- **Next:** capture what the MG Flasher iPhone app sends over ENET when it changes each feature. Use `rvictl` on the Mac to mirror the iPhone's traffic, and look for UDS to `0x12` in the HSFZ frames (TCP 6801). It is plaintext unless MG Flasher encrypts its own link. Separately, a read-only `22 F1 50` to `0x12` names the DME variant (MG1 or MEVD17), which decides whether the BMW flap job applies. Steps and tools: [mgflasher-capture.md](mgflasher-capture.md), `tools/mgf-capture.sh` and `tools/hsfz-parse.py` (tested on made-up captures only).

## Data safety (mostly settled)

- **Crash handling is not BMW's for Store apps.** mgu-store's app-privacy patch in MainApp checks `isLocalOnlyApp` (installed `package.json` has `"mguLocalOnly": true`, as the Store set for SB Probe).
  - For such an app, a crash only **restarts** it, at most 5 times in 10 minutes, then leaves it stopped.
  - There is **no data wipe and no uninstall**.
  - Apps that aren't local-only keep BMW's steps: wipe the data folder after the first crash, uninstall and reinstall after the second, then mark the app corrupt and wipe it.
- **Updates keep data:** mgu-store's reinstalls and rollbacks carry the data folder over (`deploy/README.md`). **Only an explicit uninstall removes it.**
- **Writable places:**
  - persistent: only the app's own data folder (and `/var/opt/public/oap/` itself, the apps' root, which must not be used)
  - RAM only: `/tmp`, `/var/tmp` (→ `/var/volatile/tmp`) and `/dev/shm`
  - not writable: USB sticks (`EROFS`)
- So the log lives in the data folder, written atomically, with rolling backups beside it. An off-car copy can't go to USB or be served to the hotspot. The only way out is an upload through mgu-uplink: GitHub, as SB Probe does, or a Mac. That needs `mguInternet`, which CLAUDE.md rules out, so it's **the user's decision**.
- Still to do in the app: `kit/runtime/mgu.js` exits the process on an uncaught exception. For a local-only app that is now a restart and not a wipe, but handlers should still catch everything.

## Access

There is no SSH key (the unit was rooted on a PC that's gone), so `tools/unit-dump.sh` can't be used for now. SB Probe got the same files through an app installed from the Store; it was removed on 2026-11-10 (`apps/sp_probe` and `docs/probe.md` are in git history, last in `f31c7c1`).

## Vendored kit

`kit/` is from `cauliflowermossgrape/idrive7-apps` at commit `4578c01b3b80747ad7ffe5da0368abdc0b988af9` (MIT, `kit/LICENSE.idrive7-apps`). It includes `runtime/`, `platform/` and the build and preview tools. It leaves out the GPU renderer, the controller gate, the emulator and the translations. Apps here use native HMI menu screens, which need none of those.
