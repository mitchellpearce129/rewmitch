REWMitch

On-device speaker measurement bench: plays an exponential sine sweep, records the
mic, deconvolves to an impulse response, and derives relative frequency response,
phase, group delay, driver time-offset and a decay waterfall. All client-side, no
backend. Built from `speaker-measurement-app-spec.md`.

**This is a relative / timing bench, not a calibrated SPL meter.** See the in-app
Setup / Help tab.

## Files

| File | Role |
| --- | --- |
| `index.html` | UI shell — Measure / Traces / Setup tabs, mode selector |
| `styles.css` | Mobile-first dark styling |
| `fft.js` | Radix-2 FFT (owned) |
| `dsp.js` | ESS gen, deconvolution, gating, spectrum, smoothing, phase/group-delay, driver offset, waterfall |
| `audio.js` | Web Audio: full-duplex play+record, mic constraints, level meter |
| `plot.js` | Log-frequency canvas plotter with multi-trace overlay |
| `export.js` | `.frd` text + PNG export |
| `cal.js` | Mic calibration file (UMIK/REW) parse + apply |
| `app.js` | Wiring, state, trace manager, sanity check |
| `electron/main.js` | Desktop wrapper (serves the app on localhost, opens a window) |
| `package.json` | Electron + electron-builder config for packaging |

## Driver-offset reference spec (in progress)

From `driver-offset-reference-spec.md`. Building in priority order:

- ✅ **P0 — Tweeter protection gate (SAFETY).** A "Driver under test" selector; whenever a
  tweeter is selected, Play / Repeatability / offset-capture show a blocking confirmation
  (verbatim safety copy + protection-cap checkbox) **before any audio**. A frequency range is
  never treated as protection. Re-confirms every press; no persistent opt-out. All 5 acceptance
  tests pass. (Driver-type is a lightweight selector now; the P2 wizard will drive it.)
- ✅ **P1 — Acoustic timing reference.** Each offset capture is self-referenced: a 2–4 kHz
  marker chirp plays on the reference channel (fixed reference speaker) alongside the sweep on
  the other channel, in one recording, so per-capture play/record latency cancels
  (`z = (t_driverB − t_refB) − (t_driverA − t_refA)`). Sub-sample detection via matched-filter
  cross-correlation (marker) + parabolic IR-peak (driver). Adds a reference toggle, L/R channel
  selector, "Test reference" button, averages count, and a results block with mean ± std-dev
  error bar and a plain-language verdict. Reference OFF reverts to the old (jittery) absolute
  method. Synthetic validation: known 1.0 ms delay → **343.0 mm exactly**, and same-driver ×8
  with varying latency → **0.00 mm std** (jitter fully cancels). Real-hardware acceptance
  (repeatability collapse) is Mitch's to confirm on gear.
- ✅ **P2 — Guided test-plan wizard** (beginner mode). New "Guide" tab: pick a speaker
  configuration (2-way / 2.5-way / 3-way / MTM / coax as tappable SVG icons) → a tick-off test
  plan → a 3-screen flow per test (info + layout SVG → setup/disconnect-gate → capture + result
  with beginner framing). Config drives driver-pair presets (a 3-way spawns two offset steps).
  Full verbatim glossary with inline tap-to-expand definition chips on every term. Generated
  inline SVGs (config icons, top-down layout, nearfield insets). New modules: `wizard.js`,
  `glossary.js`, `svg.js`, plus shared `safety.js` (P0 gate) and `session.js` (shared audio).
  All 4 acceptance tests pass (3-way → two offset steps; steps tick off + store results; every
  term has an inline definition; a first-timer can complete a 2-way offset from on-screen text).

## Desktop app (Electron) — standalone executable

REWMitch can ship as a real Windows app. Because it's ES-module + `getUserMedia`
based (blocked over `file://`), `electron/main.js` starts a tiny localhost server
inside the app and loads that — a proper secure context — and auto-grants the mic
permission.

### Portable build (what's already been built)

```bash
npm install
npm run dist:win        # tries a full NSIS installer (see caveat below)
# — or, no signing/symlink hassle, a portable folder:
npx @electron/packager . REWMitch --platform=win32 --arch=x64 \
    --out=dist-portable --overwrite \
    --ignore="/node_modules($|/)" --ignore="/dist" --ignore="/\.git"
```

Output: `dist-portable/REWMitch-win32-x64/` — **double-click `REWMitch.exe` to run**.
Zip that folder and hand it to a buddy; no install needed. ~260 MB (Electron bundles
its own Chromium — that's why mic/audio behave identically everywhere).

### Full installer (NSIS) — BUILT ✅

`npm run dist:win` produces, in `dist/`:

- **`REWMitch Setup 1.0.0.exe`** (~75 MB) — the installer (Start-menu shortcut + uninstaller). Share this.
- `REWMitch 1.0.0.exe` (~75 MB) — a portable single-file version (self-extracts to %TEMP% and runs).

Two Windows gotchas hit while building (both solved, noted here for rebuilds):

1. **Developer Mode must be ON** (System → For developers → Developer Mode) — otherwise
  the code-signing bundle's macOS symlinks fail to extract ("a required privilege is not held").
2. **Cache race** — the first run may fail with "Access is denied" / "Plugin not found (UAC)".
  Clear the caches and just re-run:
  
  ```powershell
  Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign","$env:LOCALAPPDATA\electron-builder\Cache\nsis" -ErrorAction SilentlyContinue
  npm run dist:win   # re-run once or twice; it fetches nsis + nsis-resources cleanly
  ```
  

Mac: `npm run dist:mac` → `.dmg` (build on a Mac; the `NSMicrophone` usage string is
already set in `package.json`).

### Heads-up for people you share the .exe with

It's **unsigned**, so Windows SmartScreen shows *"Windows protected your PC"* on
first run → click **More info → Run anyway**. (Signing needs a paid code-signing
cert — overkill for sharing with mates.) After building, `node_modules/` (~500 MB)
can be deleted to reclaim space; you only need it to rebuild.

## Giving it to someone else (zip)

Zip the whole folder and send it. Tell them to open **`INSTALL.html`** first — it's a
friendly, self-contained page (double-clickable) covering both Windows and Mac, with
two install paths (VS Code + Live Server, or Python) plus troubleshooting. Launchers
are included: **`start-windows.bat`** and **`start-mac.command`** — one double-click to
serve + open the browser. (On Mac the `.command` file loses its executable bit through
zipping; `INSTALL.html` tells them the one-time `chmod +x` / right-click→Open fix.)

## Host it as an installable PWA (free — for phones & sharing)

REWMitch is a PWA (`manifest.json` + `sw.js` + icons), so once hosted over HTTPS it
installs to a phone home-screen and runs offline. **The `deploy/` folder holds just
the 13 files needed to host** (no node_modules/dist). Both hosts below are free — no
website to buy.

**Easiest — Netlify Drop (~30 s, no account to start):**

1. Go to https://app.netlify.com/drop
2. Drag the **`deploy`** folder onto the page.
3. You get an instant `https://<random>.netlify.app` URL. Open it on the phone / share it.

**GitHub Pages (the "git test link"):**

1. github.com → **New repository** → name e.g. `rewmitch` → **Public** → Create.
2. On the repo page click **"uploading an existing file"** → drag everything **inside** the
  `deploy` folder → **Commit**.
3. **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)` → Save.**
4. Wait ~1 min → your link appears: `https://<you>.github.io/rewmitch/`.

> Host in a **separate personal public repo** — NOT the SBG work repo.

**On the phone:** open the link in Chrome → menu (⋮) → **Install app** / **Add to Home
screen** for an icon + full-screen; or just use it in the browser tab. Mic works because
the host is HTTPS. Nothing else to install.

When you change app files, refresh `deploy/` and **bump `CACHE` in `sw.js`** (e.g.
`rewmitch-v2`) so installed copies pick up the update.

## Run it locally (mic needs HTTPS or localhost)

`file://` will **not** grant mic access. Serve over `localhost`:

```bash
cd speaker-measurement-app
python -m http.server 8777
# then open http://localhost:8777/  in Chrome/Safari
```

or, with Node:

```bash
npx serve -l 8777
```

Click **Enable Mic & Audio** (grant permission), then **Play Sweep**. On a laptop
the built-in mic will pick up the laptop speakers — enough to prove the whole
pipeline. Run **Repeatability check** first: two back-to-back sweeps should
overlay within ~1 dB. If they don't, the browser is secretly processing the
input (AGC/NS/EC) and the numbers can't be trusted — this is the single biggest
validity risk (spec §3).

## Build status vs spec

- ✅ Milestones 1–6: tone out + mic in with anti-processing constraints, repeatability
  sanity check, ESS + deconvolution → IR, gate + FFT + smoothing → relative FR,
  trace hold/overlay, phase + group delay, driver-offset mode.
- ✅ Milestone 7: Distortion (THD vs freq) via the Farina time-reversed inverse
  filter — harmonics separate into the pre-impulse region, each plotted at its
  true level below the fundamental (H2–H7), plus worst-THD readout. Verified
  against a synthetic nonlinearity: measured H2/H3 levels match theory within ~1 dB.
- ✅ Basic waterfall, export (.frd + PNG).
- ✅ Milestone 8: mic-calibration-file hook (`cal.js`) — loads miniDSP UMIK `.txt`
  and REW/generic `.frd`/`.cal` (parses the Sens Factor header too), interpolates +
  clamps, and subtracts the mic's deviation from magnitude (FR + distortion, each
  harmonic corrected at its true acoustic frequency n·f). Plus an input-device
  picker so a UMIK-1 can be selected over the built-in mic. Parser + correction sign
  verified in Node against UMIK and REW sample files.

### Calibration & VituixCAD, honestly

- The cal file corrects **magnitude shape** → a calibrated *relative* FR that drops
  into VituixCAD. With a UMIK-1 on a laptop (select it as Input device) this is the
  real deal.
- **Absolute SPL is deliberately NOT claimed.** The UMIK Sens Factor is read and
  shown, but a browser can't reliably know the input gain chain. Use REW for true SPL.
- For VituixCAD, the genuinely hard bit is **timing/phase between drivers**, not
  magnitude — a single-channel USB mic can't do a dual-channel loopback reference.
  The **Driver-Offset** mode is the practical answer: it gives the acoustic z-offset
  in mm directly (fixed mic, per-driver IR).

### Note on the distortion frequency axis

Harmonic responses are plotted against the **fundamental** frequency (Farina's
result, same convention REW uses). If real-world testing ever shows a known
breakup peak landing at N× the expected frequency, the fix is a one-line divide-
by-N on each harmonic's frequency axis in `drawDistortion` — but the synthetic
verification says the current mapping is right.

## Deploy (later)

Any static host — GitHub Pages / Netlify / Cloudflare Pages / Vercel. It's all
static files; drop the folder in. HTTPS there gives you mic access on the iPhone.
