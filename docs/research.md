# Research notes

Status of the unknowns that block milestone 1. "Unit" means checked on this car's head unit; nothing below has been yet.

## Publishing (confirmed from mgu-store `docs/PUBLISHING.md`)

- Repo-tree layout: `mgu-repo.json` at the root. The Store reads it from a branch or from tags.
- Build on the unit: Node 8.16.2 or Python 3.12, no network, 10 minutes, 200 MB, one `<id>@<version>.tgz` as output.
- Two reference repos use the same shape: `apps/*` with `app.json`, built by `kit/tools/build.py {id}` with `"sdk": "oap-sdk"`.
- The kit is MIT licensed, so it can be vendored with its licence file (`nickgcode/idrive7-apps` does this).
- `mgu-repo.json` is not added yet because it would point at a kit and app that don't exist in this repo.

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

Whether an app may write outside its own data folder is still unknown. The probe's report answers it: it runs write tests on the stick, `/tmp`, `/var/tmp`, the OAP folders and the home folder.

**Kit behaviour to change before the real app:** `kit/runtime/mgu.js` calls `process.exit(1)` on an uncaught exception. On the car that counts as a crash, so `CorruptAppsHandler` wipes the data folder. The service log must not depend on it: catch everything in the app, and decide whether to patch the vendored kit.

## Access

There is no SSH key (the unit was rooted on a PC that's gone), so `tools/unit-dump.sh` can't be used for now. [probe.md](probe.md) gets the same files through a USB-installed app.

## Vendored kit

`kit/` is from `cauliflowermossgrape/idrive7-apps` at commit `4578c01b3b80747ad7ffe5da0368abdc0b988af9` (MIT, `kit/LICENSE.idrive7-apps`). It includes `runtime/`, `platform/` and the build and preview tools. It leaves out the GPU renderer, the controller gate, the emulator and the translations. Apps here use native HMI menu screens, which need none of those.
