# ⚡ Lightning Machine — 3-D ASCII lightning in a glass chamber

Live: **https://xboxzero.github.io/lightningmachine/**

Your screen is the front glass of a dark chamber. Inside, real-physics lightning grows, strikes, re-strikes, links up with neighbouring bolts, and slowly folds around in 3D on a lava-lamp-style convection flow. The viewpoint drifts on its own, and the perspective is always corrected so the screen behaves like a window into the box.

## Render engines
- **3-D ASCII (default, CPU + Canvas 2D, needs no WebGL):**
  - Lightning segments are projected through the off-axis window camera and rasterised straight into a grid of character cells.
  - Each sample deposits a sharp **Gaussian** core splat (σ ≈ 0.42 cell) and a wide Gaussian glow splat (σ ≈ 1.8 cells) for mist.
  - The projected channel direction is averaged as a doubled-angle vector, so lines get exact `- / | \` glyphs; elsewhere a brightness ramp is used.
  - Per-cell depth gives the 3D look: perspective glyph size, depth haze, glyphs extruded toward the vanishing point, and **Gaussian depth of field** around a drifting focal depth.
  - The glass chamber's edges are drawn in ASCII too.
- **Smooth HDR (optional):** WebGL2 when the browser has it, otherwise a Canvas 2D smooth renderer.

## Physics and maths (Rust → WebAssembly, `core/src/lib.rs`)
| | Model |
|---|---|
| **Charge cells** | Invisible buoyant cells, heated at the floor and cooled at the ceiling (Newtonian heating, Boussinesq buoyancy, Stokes drag). Their charge follows thermionic emission (Richardson–Dushman J = A T² e^{−W/kT}): hot rising cells turn positive and cold sinking cells stay negative. |
| **Electric field** | Coulomb's law with softened charges, E = k Σ q (x − x_q)/(r² + a²)^{3/2} in V/m. |
| **Quantum tunnelling** | Fowler–Nordheim field emission with Murphy–Good barrier functions: ln T_WKB = −v(f)·bφ^{3/2}/F, J = (a/φt²)F²T, with F = β|E|. The tunnelling probability weights every breakdown step, and J sets how fast the leader steps. |
| **Stepped leader** | 3-D stochastic dielectric breakdown. Candidate steps are weighted by (d̂·Ê)^η × T_WKB^w × e^{σN} and one is picked by the Born rule (P ∝ \|ψ\|²). Tips fork at random. |
| **Connections** | Leader tips attach to positive cells **or to any existing channel** (found with a spatial hash). Hot channels of different bolts that drift close together get bridging leaders. When one channel is hit by another, it re-strikes. |
| **Return stroke** | Heidler current function (IEC 62305-1), MTLE propagation at 1.2×10⁸ m/s, CIGRE peak-current statistics, re-strikes and continuing current. Temperature T = 4000 + 26000·(I/30 kA)^0.12. |
| **Gas spectra** | You choose the gas in the chamber: air (real lightning), neon, argon, xenon, helium, mercury vapour or krypton. Each uses its NIST emission lines with Boltzmann × Saha weighting plus a recombination continuum, integrated through CIE 1931. **Psychedelic** mode moves each channel's gas coordinate along its length and over time, so colours flow through the real spectra. |
| **Vortex tubes** | Burgers vortices, u_θ = Γ/(2πr)(1 − e^{−r²/r_c²}), with axial strain and precessing axes. They wrap filaments into organic helices, and the turbulence slowly breathes. |
| **Colour** | From the colour temperature of the air plasma: N II, O II, N I, O I and H emission lines (Boltzmann excitation × Saha ionisation) plus a recombination continuum, integrated against the CIE 1931 colour tables → sRGB. The channel flashes blue-violet-white, then cools through pink-violet to red. |
| **Smoke-like motion** | Kinematic-simulation turbulence (Kraichnan; Fung et al. 1992): divergence-free random Fourier modes whose energies follow Kolmogorov's E(k) ∝ k^{−5/3}, each changing at its eddy-turnover rate. This gives random, folding, smoke- or mist-like motion. Added to it: Stokes flow dragged by the charge cells, weak convection rolls, Brownian mist diffusion √(2D·dt), and recirculation where the smoke meets the glass. The velocity field is built with separable complex phasors on a coarse grid, refreshed every other frame, and trilinearly interpolated. Cooling channels widen into soft haze while keeping the same total light. |
| **Glass** | Off-axis "window" projection (Kooima). Mirror images in the five walls via the method of images, clipped to each wall and weighted by glass Fresnel reflectance (Schlick, n = 1.5, R₀ = 4%). |

## Controls
The buttons in the bottom-right corner hide after 2.5 s of no activity; move the mouse or tap to bring them back.
- ⚡ strike · ⚙ controller · 🔈 sound · 🎤 mic · ⛶ fullscreen
- **Drag** to move your eye and look around inside the glass · **tap** to strike
- **Panel sections:** Lightning · Quantum tunnelling · Chamber flow · Glass & view. Raise *Glass reflection* above 1 for a kaleidoscope-like effect.
- **Keys:** Space strike · H panel · F fullscreen · S sound · M mic

## Performance
Physics takes about 1.3 ms per frame. The renderer caps pixel density at 1.5× and draws reflections in one soft pass. It watches the frame time every half-second, lowering or raising render resolution to hold about 60 fps, and drops reflections only as a last resort.

## Compatibility
WebGL2 is used when available. Context creation retries with plainer options if the browser rejects the low-latency ones. Without WebGL2 (hardware acceleration off, blocked GPU, old browser) the page switches automatically to a Canvas 2D renderer: same simulation and colours, with simpler glow.

## Build
```bash
./build.sh   # Rust → lightning.wasm
```
