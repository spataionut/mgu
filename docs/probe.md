# SB Probe: getting the reference files without SSH

`apps/sp_probe` is a throwaway app. It uploads these to the private repo `spataionut/mgu-dumps` on GitHub, or, as a fallback, sends them to a Mac:

- the SOME/IP catalog
- one BMW app bundle (it contains the SDK)
- every RHMI layout file on the unit
- a report

The report covers which user the app runs as, where it can write, the odometer signal, the uplink, and where BMW's javascript mentions a speller or the RHMI component table. The probe never reads apps' data folders.

## Why it sends over the phone hotspot

Version 0.1.0 showed on the car that neither of the easy routes works:

- **USB stick:** the stick is mounted read-only for apps (`EROFS`).
- **Server on the car's hotspot:** the head unit's firewall drops incoming connections. Only root can open a port.

So from 0.2.0 the probe connects out. It declares `mguInternet`, so mgu-uplink routes it through the phone hotspot the car joined.

## Upload to GitHub (0.3.0, no laptop needed)

### One-time setup at home

The private repo `spataionut/mgu-dumps` already exists. It must stay private: the dump holds BMW's SDK and catalog.

Create a GitHub App that only the probe uses: GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

| Field | Value |
|---|---|
| Name | anything unique, e.g. `sp-probe-upload` |
| Homepage URL | `https://github.com/spataionut/mgu` |
| Callback URL | leave empty |
| **Enable Device Flow** | on |
| Webhook → Active | off |
| Repository permissions → **Contents** | Read and write (Metadata: read-only comes with it) |
| Where can this GitHub App be installed? | Only on this account |

After creating it:
1. Copy the **Client ID** from the App's page (it starts with `Iv`). It's public, not a secret.
2. Use **Install App** → your account → **Only select repositories** → `mgu-dumps`.
3. Don't generate a client secret or a private key; the probe doesn't need either.

Done on 2026-11-08: the App is `sp-probe-upload`, and its Client ID `Iv23liqYfRZ1xiIC5PIm` is `GH_CLIENT_ID` in `apps/sp_probe/main.js`.

### In the car

1. **Online:** the car joins the phone hotspot in Store → Settings → **Wi-Fi**, and the Store shows `Online`.
2. **Update:** Store → **Check now** → update **SB Probe** to **0.3.0**. The Store may say it uses the internet; that's for the upload.
3. **Upload:** open SB Probe and tap **Upload to GitHub**. The screen shows `On your phone open github.com/login/device and enter ABCD-1234`.
4. **Approve:** on the phone, open that page, enter the code and authorize the App.
5. **Wait:** the probe creates a release `dump-<time>` in `mgu-dumps` with `report.txt` and `dump.tar`. It then says `Uploaded N files to GitHub`.
6. **Clean up:** uninstall **SB Probe**.

The token exists only in the probe's memory for that one upload. It can write only to `mgu-dumps`, because that's the only repo the App is installed on, and it expires after 8 hours. The App can be uninstalled at any time from GitHub → Settings → Applications.

### If it fails

The status line says what failed:

| Status | Meaning |
|---|---|
| `sign-in start: HTTP 404` | The Client ID is wrong, or Device Flow is off. |
| `release: HTTP 404` or `403` | The App isn't installed on `mgu-dumps`, or Contents isn't read and write. |
| `CERT_…` / `UNABLE_TO_…` | Node 8 on the unit refused GitHub's certificate. Use the Mac fallback below. |
| `ENOTFOUND` / `EAI_AGAIN` / `timeout` | DNS or the uplink. Check that the Store shows `Online`. |

Send Claude a photo of the screen in any of these cases.

## Fallback: send to a Mac on the hotspot

You need the phone, the Mac and this repo on the Mac.

1. **Hotspot:** turn on the phone's hotspot. The car joins it in Store → Settings → **Wi-Fi**, as when you added the source. The Store shows `Online`.
2. **Mac:** join the **same phone hotspot**, not the car's own Wi-Fi. Then run:
   ```bash
   python3 tools/receive-dump.py
   ```
   If macOS asks whether Python may accept incoming connections, allow it.
3. **Update the probe:** update **SB Probe** to 0.3.0, as above.
4. **Send:** open SB Probe and tap **Send files to Mac (phone hotspot)**. The terminal prints `Probe found this Mac from …`, then `Received …dump-….tar`. The car says `Sent N files to <Mac address>`.
5. **Clean up:** uninstall **SB Probe** in the Store.

Files land in `~/Desktop/sp_probe-dump/`.

### If it says "No receiver found"

The line under the button lists why each address failed:

- **Mostly `timeout`:** the Mac isn't reachable from the car on that network.
  - Check that the Mac is on the phone hotspot and that the script is running.
  - Some phones isolate hotspot clients from each other. If so, use the Mac as the hotspot instead: System Settings → General → Sharing → **Internet Sharing** over Wi-Fi, then let the car join that network. The probe tries the network's router first, which is then the Mac.
- **`EPERM` / `EHOSTUNREACH` / `ENETUNREACH`:** the uplink isn't letting the probe out. The probe has to be 0.2.0, installed while mgu-uplink was installed. Send Claude a photo of the screen.
- **`No uplink`:** the car isn't online. Check Store → Settings → Wi-Fi.

## Back at the desk

From GitHub, Claude fetches the newest release:

```bash
tag=$(gh release list -R spataionut/mgu-dumps -L 1 --json tagName -q '.[0].tagName')
mkdir -p unit-dump && gh release download "$tag" -R spataionut/mgu-dumps -D unit-dump/_dl && tar xf unit-dump/_dl/dump.tar -C unit-dump
```

From the Mac fallback, run this instead:

```bash
mkdir -p unit-dump && tar xf ~/Desktop/sp_probe-dump/dump-*.tar -C unit-dump
```

`unit-dump/` is git-ignored.

## Risks

- **Crash:** only the probe is affected. The platform wipes its data after one crash and uninstalls it after a second. Nothing else changes on the unit.
- **What leaves the car:** only the files above.
  - GitHub upload: they go only to the private `mgu-dumps` repo, under your approval on the phone.
  - Mac fallback: they go only to an address on the hotspot's own network that answers as `receive-dump.py`.
- **The receiver:** it listens on port 8737 on all of the Mac's networks while it runs, and accepts only `report-*.txt` / `dump-*.tar` uploads. Stop it with Ctrl-C when done.
