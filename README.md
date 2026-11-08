# ⚡ Lightning Machine — liquid lightning

Live: **https://xboxzero.github.io/lightningmachine/**

Full-screen lightning that folds and swirls like water or liquid metal. Each bolt strikes as a jagged, branching channel, then flows around the screen. It curls into whirlpools, stretches along the edges, re-strikes, and cools from blue-white through yellow and orange to red before it fades out.

## The maths (Rust → WebAssembly, `core/src/lib.rs`)
- **Bolts:** each bolt grows in steps guided toward a target. Gaussian angular noise makes the zig-zag, and random forks make the branches.
- **Liquid flow:** an incompressible 2-D fluid made of point vortices with Lamb–Oseen Gaussian cores, v_θ = Γ/(2πr)(1 − e^{−r²/r_c²}). The vortices move each other (Biot–Savart law). The screen edges are walls, enforced with the method of images, so the flow runs along the edges and the lightning circulates around the screen.
- **Moving the strands:** every node of every bolt is moved by the flow using midpoint (RK2) integration. Strands are re-sampled as they stretch or squeeze, and a curvature term acts like surface tension to keep them smooth.
- **Crackle:** Ornstein–Uhlenbeck (Gaussian) jitter on top of the flowing shape.
- **Colour:** Planck black body → CIE 1931 → sRGB, with brightness ∝ T⁴. Bolts flash on strike, flash again on re-strikes, then cool.
- **Speed:** about 2 ms per frame for 5 bolts at 1080p. There is no slow motion or delay, and thunder plays the instant a bolt strikes.

## Controls
The buttons in the bottom-right corner hide after 2.5 s of no activity; move the mouse or tap to bring them back.
- ⚡ strike · ⚙ controller · 🔈 sound · 🎤 mic · ⛶ fullscreen
- **Looks:** Lightning (plasma glow) · Liquid metal (chrome tube) · Water (glassy tube)
- **Sliders:** bolts, flow speed, swirls, smoothness, crackle, branching, re-strikes, lifetime, temperature, brightness, thickness, volume
- **Tap** strikes a new bolt from your finger. **Drag** stirs the liquid.
- **Mic:** loudness speeds up the flow and adds more re-strikes; a clap or shout strikes a new bolt.
- **Keys:** Space strike · H panel · F fullscreen · S sound · M mic · 1/2/3 looks · Esc close panel

## Build
```bash
./build.sh   # Rust → lightning.wasm
```
The site is static (`index.html`, `style.css`, `js/`, `lightning.wasm`); serve it from any web server.
