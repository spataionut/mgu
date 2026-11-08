# Research notes

Status of the unknowns that block milestone 1. "Unit" means checked on this car's head unit; nothing below has been yet.

## Publishing (confirmed from mgu-store `docs/PUBLISHING.md`)

- Repo-tree layout: `mgu-repo.json` at the root. The Store reads it from a branch or from tags.
- Build on the unit: Node 8.16.2 or Python 3.12, no network, 10 minutes, 200 MB, one `<id>@<version>.tgz` as output.
- Two reference repos use the same shape: `apps/*` with `app.json`, built by `kit/tools/build.py {id}` with `"sdk": "oap-sdk"`.
- The kit is MIT licensed, so it can be vendored with its licence file (`nickgcode/idrive7-apps` does this).
- `mgu-repo.json` is not added yet because it would point at a kit and app that don't exist in this repo.

## Car results, 2026-11-08 (SB Probe 0.1.0, installed from the GitHub Store source)

- **Install:** accepted, so `KombiIF.statusRangeTankStatus` has a getter on this firmware and `rs` is valid.
- **Odometer:** `mileageKilometre` reads 27081 km and updates while driving (27083 km a few minutes later). Still to confirm it matches the cluster exactly.
- **USB stick:** writing fails with `EROFS` at `/media/C1C6-1DF2`. Sticks are mounted read-only, at least for app users. USB export from the app is not possible as-is; see Data safety.
- **Wi-Fi server:** it starts, but a phone on the car's hotspot gets no answer. The unit's `ip filter` input chain (firewalldz) drops what it does not accept. mgu-store opens its own port 8470 with a root rule (`mgu-updater/README.md`, "Firewall"); an app's uid can't. **Apps can't serve anything to the hotspot.** Interfaces: `wlan_bridge 172.16.222.97` (hotspot), `vlan80 160.48.199.185`.
- **Next:** SB Probe 0.3.0 uploads to a release in the private `spataionut/mgu-dumps`, signed in through GitHub's device flow with the owner's own GitHub App, which is installed on that repo only. Names resolve through the lease's DNS servers, because the unit's resolver has no internet. It was checked against real github.com from the Mac, not yet with Node 8 on the unit. The 0.2.0 Mac receiver stays as a fallback.
- **0.4.0 widens the dump** for later apps: the whole OAP platform, every app's source, all of `/etc/oap`, identity files, systemd units, runtime facts and a filesystem index. Key material and apps' data are left out ([probe.md](probe.md), "What's in the dump"). The GitHub upload goes in gzip parts, so memory stays low and a failed part is retried on its own.
- **Mac fallback:** the probe connects out instead of serving. It declares `mguInternet`, so mgu-uplink routes its uid through the uplink. It then finds `tools/receive-dump.py` on the uplink's subnet and uploads to it. The kit's `build.py` is patched to write `"mguInternet": true` when `app.json` says `"internet": true`.

## Odometer (candidate, unverified on the unit)

`apps/live_data/signals.js` in `cauliflowermossgrape/idrive7-apps` reads:

- Interface alias `KOMBI`, field `statusRangeTankStatus`, member `mileageKilometre`, unit km, no scaling, max 16777215.
- It also lists a fallback under interface alias `VI`, field `Range`.

To check in `someip-interfaces.json`: the full interface name, whether the field has a getter and/or notifier (this decides `r` or `s`), and whether the value matches the cluster on the car.

## Speller / text input (open, biggest risk)

**What supports it existing:**

- IDriveConnectKit has an `input` component: `textModel`, `resultModel`, `suggestModel`, `action`, `resultAction`, `suggestAction`. The typed text arrives in action arg `8`.
- That library targets the BMW Connected (Etch) protocol, not OAP/joynr, so this does not prove OAP has it.

**What argues against it:**

- `docs/rhmi-widgets.md` in the kit lists the OAP component types from `RhmiApplication.js`. There is no `input` or speller type. The closest are `editRoll`, `dateRoll` and `timeRoll`.
- The same doc lists event subtypes `ToggleEdit=6`, `SetValue=7`, `CurrentValue=8`, `Confirm=9`, `Abort=10`, which may belong to the roll pickers.
- No app in either kit repo uses text input, and the kit's emulator and stub have no support for it.

**How to settle it, once `unit-dump/` exists:**

1. Search the SDK bundle's component dispatch table for `input`, `speller`, `editRoll` and related strings.
2. Search every BMW `application.xml` and `uiDescription.json` for `type="input"` and `LT_*Speller*` / `LT_*Input*` widget names.
3. If there is a declared type: copy a BMW usage exactly and test it in a minimal app.
4. If there is none: try an undeclared `input` component in a throwaway test app. Whether that is safe needs its own check, because a crash triggers `CorruptAppsHandler`.

**If OAP has no speller,** the options to bring back to the user are `editRoll`-style pickers, or a keyboard drawn by the app and driven by touch. That changes a stated requirement, so it is the user's decision.

## Data safety (open)

USB sticks are read-only for apps (`EROFS`, see Car results), and the firewall stops apps serving to the hotspot, so the planned "export to USB stick" needs another route. The candidates are an upload out through mgu-uplink (needs `mguInternet`, which CLAUDE.md rules out for the real app, so that is the user's call) or a writable location the report finds. Whether an app may write outside its own data folder is still unknown. The probe's report answers it: it runs write tests on the stick, `/tmp`, `/var/tmp`, the OAP folders and the home folder.

**Kit behaviour to change before the real app:** `kit/runtime/mgu.js` calls `process.exit(1)` on an uncaught exception. On the car that counts as a crash, so `CorruptAppsHandler` wipes the data folder. The service log must not depend on it: catch everything in the app, and decide whether to patch the vendored kit.

## Access

There is no SSH key (the unit was rooted on a PC that's gone), so `tools/unit-dump.sh` can't be used for now. [probe.md](probe.md) gets the same files through an app installed from the Store.

## Vendored kit

`kit/` is from `cauliflowermossgrape/idrive7-apps` at commit `4578c01b3b80747ad7ffe5da0368abdc0b988af9` (MIT, `kit/LICENSE.idrive7-apps`). It includes `runtime/`, `platform/` and the build and preview tools. It leaves out the GPU renderer, the controller gate, the emulator and the translations. Apps here use native HMI menu screens, which need none of those.
