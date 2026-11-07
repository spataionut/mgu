# SB Probe: getting the reference files without SSH

`apps/sp_probe` is a throwaway app. It copies these to a USB stick:

- the SOME/IP catalog
- one BMW app bundle (it contains the SDK)
- every RHMI layout file on the unit
- a report

The report covers which user the app runs as, where it can write, the odometer signal, and where BMW's javascript mentions a speller or the RHMI component table. The probe never reads apps' data folders.

## At home: put it on the stick

The stick is FAT32 and mounts as `/Volumes/MGU`.

```bash
tools/make-stick.sh /Volumes/MGU
```

This exports only the committed files (`git archive`) and runs `mgu-install.js usb-repo` on them. Don't point `usb-repo` at this folder directly: it copies a folder as it is, including any `dist/`, `oap-sdk/` or `unit-dump/` in it. Don't use `github:spataionut/mgu` either: that input only reads repos that publish releases. Eject the stick before you unplug it.

## In the car

1. Turn the ignition on. With the head unit only awake, the car sends little vehicle data.
2. Plug in the stick. In the Store, the stick shows up as a source. Install **SB Probe**. The unit builds it from source, which takes a minute or two.
3. Open **SB Probe** from the app list.
4. Write down the **Odometer** line and the km reading on the instrument cluster. Take a photo of both.
5. Tap **Copy files to USB stick**. Wait until the status line says `/media/...: N files`.
6. If the copy fails (the status says why), use Wi-Fi instead:
   1. Turn on the car's hotspot and join it from the Mac.
   2. Tap **Serve files over Wi-Fi (10 min)**. The bottom line shows the head unit's addresses.
   3. On the Mac, run this, using the address shown if it isn't `172.16.222.97`:
      ```bash
      curl -o ~/Desktop/sp_probe-dump.tar http://172.16.222.97:8737/dump.tar
      ```
7. Uninstall **SB Probe** in the Store when done.

## Back at the desk

```bash
mkdir -p unit-dump && tar xf /Volumes/MGU/sp_probe/dump-*.tar -C unit-dump
```

If you used Wi-Fi, extract `~/Desktop/sp_probe-dump.tar` instead. `unit-dump/` is git-ignored. Then tell Claude it's there, along with the odometer photo.

## Risks

- **Install refused:** if your firmware has no getter for `KombiIF.statusRangeTankStatus`, the Store refuses the install and says "no getter". Tell Claude and the probe gets rebuilt without the odometer.
- **Crash:** only the probe is affected. The platform wipes its data after one crash and uninstalls it after a second. Nothing else changes on the unit.
- **Wi-Fi server:** it only answers clients on private addresses (the hotspot) and stops after 10 minutes.
