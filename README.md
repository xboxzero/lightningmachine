# ⚡ Lightning Machine

Live: **https://xboxzero.github.io/lightningmachine/**

Full-screen, real-time Tesla-coil lightning. Arcs shoot out in every direction from a moving plasma orb, strike the screen edges, sweep around, and jump to your finger or mouse.

- **No delay:** every arc is regrown from scratch on each coil pulse (default 60 Hz). Physics takes about 0.1 ms per frame in Rust/WebAssembly. The canvas uses the low-latency `desynchronized` mode, and the sound is generated live each frame.
- **Physics:** arcs follow the electric field. The charged orb pushes them away (a 2-D line charge, ∝ r̂/r) and the target pulls them in. Gaussian angular noise makes the zig-zag, random forks make the branches, and Gaussian midpoint displacement adds fine detail.
- **Colour:** set by temperature. Planck black-body light is converted to screen colour through the CIE 1931 colour tables, and brightness follows ∝ T⁴.
- **Sound:** a spark-gap buzz at the firing rate plus crackle, following the arcs instantly.
- **Mic:** loudness gives the arcs more power and reach. Singing sets the firing rate and buzz pitch, like a "singing" Tesla coil.

## Controls
The buttons in the bottom-right corner hide after 2.5 s of no activity; move the mouse or tap to bring them back.
- ⚙ opens the controller: mode (Roam / Follow finger / Two coils), arcs, reach, branching, jaggedness, movement speed, firing rate, temperature, afterglow, brightness, thickness and volume.
- 🔈 sound · 🎤 mic · ⛶ fullscreen
- Touch or click anywhere to pull an arc to that spot.
- Keys: H panel · F fullscreen · S sound · M mic · 1/2/3 modes · Esc close panel

## Build
```bash
./build.sh   # Rust → lightning.wasm
```
The site is static (`index.html`, `style.css`, `js/`, `lightning.wasm`); serve it from any web server.
