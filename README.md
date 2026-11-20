<img src="icons/icon-192.png" alt="" width="96" height="96">

# OBD Dash
*by Falcon Image and Sound*

A free web app for the **Veepeak OBDCheck BLE+** (and other Bluetooth LE ELM327 adapters):

- **Read trouble codes** — stored, pending and permanent — with plain-English descriptions, repair hints and a “Look it up” link
- **Clear codes** and turn off the check-engine light (with a safety checklist first)
- **Freeze frame** — engine conditions when the code was set
- **Emissions readiness** — see if the car is ready for a smog/inspection test
- **Digital dashboard** — tachometer with shift light, speed, and tiles for coolant, battery, boost, fuel trims, oil temp, economy and more (only what your car supports)
- **Race Dash** — a full-screen race-car dashboard that turns on automatically on iPad/tablets: shift-light LEDs (green → amber → red → flashing blue at redline), a segmented RPM bar, huge speed + RPM, temperature and power columns, a bottom data strip with peak RPM, top speed and a **0–60 timer**, and warning lights. Tap **Focus** to hide the app bar. Pick Auto / Standard / Race / Muscle under Vehicle → Settings.
- **Muscle Dash** — a restomod / stock-car cluster on a carbon-fibre panel: big chrome-bezel analog tach and speedometer with sprung needles (and a start-up needle sweep), a peak-RPM tell-tale needle, a row of six analog gauges (water, oil, volts, fuel, boost…), a SHIFT lamp, jewel warning lamps, a trip meter and the 0–60 timer.
- **Gear indicator** on every dashboard, with a **GEAR** button to turn it on or off. It only works when the transmission reports its gear over OBD-II (some newer cars); on cars that don’t, the button is dimmed and the gear isn’t shown — nothing is guessed.
- **GPS speed** — one tap switches the speedometer to the phone’s GPS (handy if your car doesn’t report speed, and it frees the adapter to update RPM faster)
- **Record** live data to a CSV file, **US / metric** units, keeps the screen awake
- **Demo mode** with a simulated car, and a raw **console** for ELM327 commands

It’s plain HTML/CSS/JavaScript using Web Bluetooth — no app store, no build step. Install it from the browser and it works offline.

---

## 1. Deploy it (one time, ~2 minutes)

Phones only allow Bluetooth on **https://** pages, so the app needs to be hosted. GitHub Pages is free.

**Easiest — run the deploy script** (uses the GitHub CLI you’re already signed in to):

```powershell
cd "C:\Users\SilverRock\Documents\OBD Dash"
powershell -ExecutionPolicy Bypass -File tools\deploy.ps1
```

It creates a **public** repo named `obd-dash`, turns on GitHub Pages, and prints your address — for this account:

**https://thefalconimageandsound.github.io/obd-dash/**

Give it a minute or two the first time. To publish changes later, run the same script again.

<details>
<summary>Prefer to do it by hand?</summary>

```powershell
git init -b main
git add -A
git commit -m "OBD Dash"
gh repo create obd-dash --public --source . --remote origin --push
gh api -X POST "repos/{owner}/{repo}/pages" -f "source[branch]=main" -f "source[path]=/"
```

Or on github.com: create a repo, upload these files, then **Settings → Pages → Deploy from a branch → main / (root)**.
</details>

<details>
<summary>No GitHub? Use Netlify Drop</summary>

Go to <https://app.netlify.com/drop> and drag the whole `OBD Dash` folder onto the page. You get an https:// address instantly (sign up to keep it permanently).
</details>

---

## 2. Use it in the car

1. Plug the Veepeak into the OBD-II port (under the dash, driver’s side). Its light comes on.
2. Turn the ignition **ON** (or start the engine).
3. Open the app and tap **Connect adapter** → pick **VEEPEAK**.
   **Don’t pair it in your phone’s Bluetooth settings** — BLE adapters connect from inside the app.

### Android
Open the address in **Chrome**. Menu ⋮ → **Install app** (or *Add to Home screen*) to get an app icon that opens full-screen.
Chrome needs the **Nearby devices** permission (Android 12+) or **Location** turned on (older Android) to find Bluetooth devices.

### iPhone / iPad
Apple doesn’t let Safari — or any iPhone browser built on it, including Chrome for iPhone — talk to Bluetooth devices. Use **Bluefy**, a free browser made for this:

1. Install **Bluefy – Web BLE Browser** from the App Store.
2. Open Bluefy and go to **https://thefalconimageandsound.github.io/obd-dash/**
   (If you open the app in Safari first, tap **Copy link for Bluefy** and paste it into Bluefy.)
3. Bookmark the page in Bluefy so it’s one tap next time.
4. When asked, allow Bluefy to use Bluetooth.

Notes for iPhone:
- Don’t use Safari’s *Add to Home Screen* for this app — home-screen web apps run on Safari’s engine, which has no Bluetooth.
- iPhone can’t make a web page full-screen, so that button is hidden. Turn the phone sideways for the car-mount layout.
- If the screen dims while driving, set **Settings → Display & Brightness → Auto-Lock** to a longer time.
- For **GPS speed**, allow location when asked. If you said no, turn it on in **Settings → Bluefy → Location → While Using the App**.

### Windows / Mac / Chromebook
Chrome or Edge works if the computer has Bluetooth LE. Handy for testing at the desk.

---

## About clearing codes

Clearing does more than turn off the light:

- It erases the **freeze frame** — write codes down first (**Copy report** on the Codes tab).
- It resets the **readiness monitors**, so the car will **fail an emissions inspection** until it has been driven enough for them to complete (often 50–100+ miles over several days).
- If the fault isn’t fixed, the code and light come back.
- **Permanent codes** can’t be cleared by any scan tool; the car removes them after it verifies the repair.

For best results clear with the engine **off** and ignition **on**.

Generic OBD-II only covers the engine/emissions computer (and often the transmission). ABS, airbag and body modules use manufacturer-specific protocols that this app doesn’t read.

**Please don’t fiddle with the phone while driving** — mount it and let a passenger handle it.

---

## Troubleshooting

| Problem | Try |
|---|---|
| VEEPEAK isn’t in the list | Check the adapter’s light is on; ignition ON; tap *Show all Bluetooth devices*; close other OBD apps (an adapter can only talk to one app at a time); unplug it for 10 seconds. |
| “Car isn’t answering” banner | Ignition must be ON. Tap **Retry**. Some cars need the engine running. |
| A gauge tile disappears | Your car doesn’t report that value — normal. Pick others under **Gauges**. |
| Updates feel slow | Fewer tiles = faster refresh. RPM/speed update most often; temperatures rotate in slower. Turning on **GPS speed** also speeds up RPM. |
| GEAR button is dimmed / no gear shown | Your car’s transmission doesn’t report its gear over standard OBD-II (most cars don’t — it’s mainly some newer models). Vehicle → Settings → Gear indicator says which. |
| GPS speed shows “Waiting for GPS” | Give it a few seconds outdoors with a clear sky view. Location must be allowed for the browser. GPS speed is shown only while the phone is getting fresh fixes. |
| Something odd | **Console** tab shows every command and reply. Turn on *Log dashboard traffic* under Vehicle → Settings for full detail. |

---

## Working on the code

```powershell
npm start      # local server at http://localhost:8080 (Bluetooth works on localhost in Chrome/Edge)
npm test       # protocol + parser tests against the simulated adapter
```

| File | What it does |
|---|---|
| `index.html`, `css/styles.css` | The UI |
| `js/app.js` | Screens, polling loop, codes, recording, settings |
| `js/ble.js` | Web Bluetooth connection (finds the adapter’s serial service automatically) |
| `js/elm327.js` | ELM327 command queue + OBD-II parsing (CAN multi-frame, multiple ECUs) |
| `js/pids.js` | Live values, unit conversions, warning thresholds |
| `js/dtc.js`, `js/dtc-codes.js` | Trouble-code decoding, descriptions, readiness monitors |
| `js/sim.js` | Simulated adapter + car for demo mode and tests |
| `js/race.js` | The Race Dash layout (shift lights, RPM bar, data slots, peaks) |
| `js/muscle.js` | The Muscle Dash (analog gauges with needle physics, carbon-fibre texture, shift lamp, trip meter) |
| `js/gear.js` | Gear indicator: decodes the transmission-reported gear (PID A4) |
| `js/launch.js` | 0–60 / 0–100 timer shared by both special dashes |
| `js/gps.js` | Phone GPS speed (uses the phone’s speed, or works it out from position changes) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app + offline support |
| `tools/deploy.ps1` | One-command GitHub Pages deploy |

After deploying an update, phones pick it up on the next launch (the offline cache refreshes in the background) — open the app twice to see changes.

### A native iPhone app?
Possible later by wrapping this same code with Capacitor and a Bluetooth plugin, but Apple requires an Apple Developer account ($99/year) and a Mac or a cloud Mac build service to install it on a phone. Bluefy gets you there today for free.
