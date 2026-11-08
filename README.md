# ⚡ Lightning Machine — real-time 4D lightning simulation

Live: **https://xboxzero.github.io/lightningmachine/**

A real-time lightning simulation in 3D space plus time. It has surround thunder, an on-screen and gamepad controller, several camera views, a fullscreen button and microphone control.
The physics runs in **Rust compiled to WebAssembly (SIMD)**. That is the fastest, lowest-latency option that runs in a browser.
Rendering is **WebGL2 HDR** and audio is **Web Audio**. Thunder is synthesised in a **Web Worker**, so the frame loop never stalls.

## Physics and maths (`core/src/lib.rs`)

| Part | Model |
|---|---|
| Electric field | Poisson equation ∇²φ = −ρ/ε₀ on a 3-D lattice, solved by red-black SOR. The cloud base has a Gaussian potential profile, the ground is φ = 0 and the lower positive charge region is a Gaussian space charge. |
| Stepped leader | Dielectric Breakdown Model (Niemeyer–Pietronero–Wiesmann): P ∝ \|∇φ\|^η over 26-neighbour candidates. Each step adds log-normal (Gaussian) space-charge noise. Node positions get a Gaussian jitter and a Gaussian midpoint displacement. |
| Quantum tunnelling | Fowler–Nordheim field emission with Murphy–Good barrier functions (Forbes approximation). The WKB transmission T = exp(−v(f)·bφ^{3/2}/F) weights each breakdown site, and sites are sampled by the Born rule, P ∝ \|ψ\|² ∝ T. The emitted current density J sets the leader's stepping rate. The local field includes a field-enhancement factor β. |
| Attachment | Contact with the ground, or a grounded tower within striking distance (upward connecting leader). |
| Return stroke | Heidler current function with IEC 62305-1 waveforms (1/200 µs first stroke, 0.25/100 µs later strokes). It travels up the channel by the MTLE model at v = 1.2×10⁸ m/s with λ = 2 km. Peak currents come from the CIGRE log-normal distributions. Flashes have several strokes, dart leaders and continuing current. |
| Temperature | Joule-heating equilibrium T ∝ √I, so radiance σT⁴ ∝ I². The channel then cools exponentially. |
| Colour | Planck's law integrated against the CIE 1931 2° colour-matching functions (Wyman–Sloan–Shirley multi-lobe Gaussian fit), then XYZ → linear sRGB (D65). This is precomputed as a lookup table from 800 K to 40,000 K. |
| Thunder | Few's blast-wave theory: R₀ = √(E_l/πp₀) and N-wave fundamental f = 0.63c/R₀. It adds weak-shock lengthening, sinc directivity for tortuous micro-segments, 1/r spreading, a ground image source and range-dependent rise time. |
| Surround | 2-D VBAP for 5.1 (L, R, C, LFE, Ls, Rs, with a bass-managed LFE). Stereo and headphones use constant-power panning plus Woodworth ITD. Playback is offset by the synthesis latency, so thunder arrives exactly at distance / 343 m/s. |

## Controls
- **Buttons:** ⚡ Strike, 🎥 camera (Orbit, Cinematic, Ground observer, Free fly, Strike-point chase), ⟲ reset, 🎤 Mic, ⏸, 🎮 on-screen joysticks, ☰ panel, ⛶ Fullscreen.
- **Keys:** Space strike · C camera · F fullscreen · M mic · P pause · H panel · R reset · WASD/QE move · arrows orbit · +/- zoom.
- **Gamepad:** sticks move/look · LT/RT zoom · LB/RB height · A strike · B camera · X mic · Y panel · D-pad activity/η.
- **Microphone:** loudness speeds up leader growth and claps trigger strikes. Pitch (spectral centroid) lowers η for more branching and sets the direction of a steering field. The mic is only analysed and never sent to the speakers.

## Build
```bash
./build.sh   # needs rustup; builds core/ → lightning.wasm
```
The site itself is static: `index.html`, `style.css`, `js/` and `lightning.wasm`. Serve it from any web server; it needs HTTP because WebAssembly won't load from `file://`.
