# ⚡ Lightning Machine — 3-D liquid lightning

Live: **https://xboxzero.github.io/lightningmachine/**

Real-time lightning inside a 2 km block of thundercloud, shown in 3D. Rotate around it, zoom in, and watch the bolts grow, strike, re-strike and keep folding through the air like a liquid.

## The physics (Rust → WebAssembly, `core/src/lib.rs`)
| | Model |
|---|---|
| **Charge** | Thundercloud *tripole*: a main negative layer, an upper positive layer and a lower positive region. Each charge is a softened point charge (Coulomb's law). |
| **Stepped leader** | 3-D stochastic dielectric breakdown. At each step the leader tries several directions and picks one with probability ∝ (d̂·Ê)^η · e^{σN}. Negative leaders move along −E toward positive charge and fork at random. |
| **Return stroke** | Heidler current function (IEC 62305-1: 1/200 µs first stroke, 0.25/100 µs later strokes). It travels along the channel by the MTLE model at v = 1.2×10⁸ m/s with λ = 2 km. Peak currents follow the CIGRE log-normal statistics. Re-strikes and continuing current are included. |
| **Temperature** | T = 4000 + 26000·(I/30 kA)^0.12. Peak stroke temperatures stay near 28–31 kK, matching spectroscopy (Orville 1968). The channel cools toward the continuing-current equilibrium. |
| **Colour** | The air-plasma emission spectrum: N II, O II, N I, O I, Hα, Hβ, Hγ lines weighted by Boltzmann excitation e^{−E_u/kT} and the Saha ionisation balance of nitrogen, plus a recombination/bremsstrahlung continuum ∝ x². This is integrated against the CIE 1931 colour tables → sRGB. The result runs from a blue-violet-white flash, through pink and violet, to red as the channel cools. |
| **Brightness** | Fechner's law (perceived brightness is logarithmic) across 7 decades of luminance. |
| **Atmosphere** | Beer–Lambert extinction with Rayleigh (∝ λ⁻⁴) plus haze coefficients, so distant channels look warmer. |
| **Liquid motion** | Arnold–Beltrami–Childress (ABC) flow, an exact divergence-free solution of the Euler equations, with drifting phases. Channels are moved by RK2 integration and re-sampled as they stretch, with a surface-tension-like smoothing term. |

## Controls
The buttons in the bottom-right corner hide after 2.5 s of no activity; move the mouse or tap to bring them back.
- ⚡ strike · ⚙ controller · 🔈 sound · 🎤 mic · ⛶ fullscreen
- **Drag** to rotate · **scroll / pinch** to zoom · **tap** to strike
- **Looks:** Lightning · Liquid metal · Water
- **Sliders:** bolts, flow speed, swirl size, smoothness, crackle, breakdown exponent η, branching, charge regions, leader speed, peak current, continuing current, re-strikes, stroke slow-motion, lifetime, air/haze, auto-rotate, brightness, thickness, volume
- **Keys:** Space strike · H panel · F fullscreen · S sound · M mic · 1/2/3 looks

## Build
```bash
./build.sh   # Rust → lightning.wasm
```
