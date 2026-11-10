# Capturing MG Flasher's Custom Code commands

Goal: learn which UDS commands the MG Flasher iPhone app sends to the DME (`0x12`) for each Custom Code feature, so a head-unit app can send the same ones over the car's own diagnostic link (`InternalTasu`, see [research.md](research.md)). The capture only listens. Nothing new is sent to the car: you change the features in MG Flasher as you always do.

## What you need

- The Mac in the car, with this repo, and the iPhone connected to it by **USB cable**. Unlock the phone and tap **Trust** the first time.
- The ENET adapter in the OBD port, and MG Flasher connected the usual way.
- The car parked, in P, with the parking brake on. Start the **engine**, because some features (Max Cooling) may only switch with it running.

## Steps

1. On the Mac:
   ```bash
   tools/mgf-capture.sh
   ```
   It finds the iPhone, starts mirroring its traffic, and records it to `private/mgf-<time>.pcap`. It asks for your Mac password, because tcpdump needs root.
2. In MG Flasher, connect to the car. Then **do nothing for 10 seconds**, so the background polling is recorded on its own.
3. Change one feature at a time and **wait about 10 seconds after each change**. The pauses separate the commands in the recording.

   | # | Feature | Change |
   |---|---|---|
   | 1 | Switchable Maps | slot 1 (95 RON) |
   | 2 | Switchable Maps | slot 2 (stock) |
   | 3 | Switchable Maps | slot 0 (100 RON) |
   | 4 | Max Cooling | Enable |
   | 5 | Max Cooling | Disable |
   | 6 | Exhaust Flap | Closed |
   | 7 | Exhaust Flap | Opened |
   | 8 | Exhaust Flap | Automatic |
   | 9 | Valet Mode | Enable |
   | 10 | Valet Mode | Disable (don't drive off in valet mode) |

   If you skip a step, do things in another order, or MG Flasher shows an error, note it.
4. Disconnect in MG Flasher, then press **Ctrl-C** on the Mac. The script stops the mirror and makes the file yours.
5. Tell me the file name. I read it here with:
   ```bash
   python3 tools/hsfz-parse.py private/mgf-<time>.pcap --no-reads
   ```

## Privacy

The recording holds the VIN, the car's replies and the phone's other traffic, which is mostly encrypted. It stays in `private/`, which git ignores, as are `*.pcap` files. Don't share it. The parser's candidate list shows only the command bytes.

## What can go wrong

- **"rvictl not found" or "could not start":** open Xcode once so it installs its device support, unlock the phone, and run the script again.
- **The parser finds no HSFZ/DoIP but lists `16 03 …` streams:** MG Flasher encrypts its link to the adapter, and this route is closed. The next idea would then be recording at the adapter instead.
- **Requests appear, but to another address than `12`:** run the parser with `--all`. A tuned DME can also answer at a second address.

## After the capture

For each feature, the candidates should show the request sent right after each change, with the DME's reply, positive or negative. Before any app sends one of them:
- The command must match your change in the table above, and the DME must answer it positively.
- In the app it is sent only on a button press, and with the car's state checked first (engine running, parked).
- The first test in the car is one feature, with you watching the tachometer.

## Step 2: the read-only test on the head unit (MGF Read Test, `apps/sp_mgfread`)

*MGF Read Test was removed from the repo on 2026-11-10, once Service Book 0.5.0 did the same. Its code and test are in git history (last in `f31c7c1`). The steps below are the record of how it was tested.*

This checks whether the DME answers the head unit's own diagnostic link (`InternalTasu`, tester `0xF2`), and whether the head unit can read MG Flasher's state from it.
- **It only reads.** `reader.js` `check()` lets out the DME's identity (`22 F1 50`) and six fixed memory reads (`23 44 ...`). Everything else throws before it reaches the transport: writes, routines, sessions, I/O control, other addresses, other lengths. `test/mgfread.test.js` checks this.
- It reads once when it opens, and again on **Read again**. Each row shows the decoded value, the raw bytes and the time taken, and the same goes to the app's log.

Install it from the USB stick. Nothing has to be pushed:
```bash
python3 kit/tools/build.py sp_mgfread
node mgu-install.js usb-repo /Volumes/MGU dist/sp_mgfread@0.1.0.tgz
```
In the car, parked with the engine running: Store → **Check now** → **MGF Read Test** → Install, then open it.

Pass when:
- **DME** shows an SGBD index.
- **Map, Max Cooling, Exhaust Flap and Valet** match what MG Flasher last set. After the capture that was slot 0 · 100 RON, off, automatic, off.

If the rows say "no answer" or "refused", the head unit's link can't reach MG Flasher's state like this.

**Result 2026-11-10 (0.1.0):** passed. Every read answered in about 200 ms, and the values matched what the owner had last set (map slot 2, flap opened, last command id `49 69` = the flap).

## Step 3: one watched write (0.2.0)

0.2.0 adds a single write, the map to **slot 0** or **slot 2**, with the same bytes the MG Flasher app sends. Every other write is still refused by `check()`, including slot 1, Max Cooling, the flap and valet.
- **Double tap:** the first tap arms it. A second tap on the same button within 5 s sends it.
- **Car check:** it goes only while the live speed is under 1 km/h, the engine runs (over 400 rpm) and the selector isn't in R, N or D. These are fresh signals only (3 s), so a missing signal means no write.
- **Confirmation,** as MG Flasher does it: the DME's reply `7F 2E 69` is expected. Then the last command id must read `45 69`, and the map must read the new slot. Only then does the screen say **CONFIRMED**.

```bash
python3 kit/tools/build.py sp_mgfread
node mgu-install.js usb-repo /Volumes/MGU dist/sp_mgfread@0.2.0.tgz
```

**Result 2026-11-10 (0.2.1):** passed. 0.2.0 refused the write because the parked car sends no fresh speed, which is the gate working as designed. 0.2.1 polls the getters every second, and the Car row then read `0 km/h · 658 rpm · P · map write allowed`. The map write from the head unit got `7F 2E 69` (expected), the last command id read `45 69`, and the map read the new slot: **CONFIRMED**. The head unit can switch MG Flasher's map without the ENET adapter.

**Result 2026-11-10 (Service Book 0.5.0):** all four settings (map, Max Cooling, exhaust flap, valet) were set from the Custom Code tab and confirmed by read-back. MGF Test isn't needed any more.
