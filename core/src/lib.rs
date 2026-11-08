//! Lightning Machine — lightning in a glass lava-lamp chamber (Rust → WebAssembly).
//!
//! Units: metres, seconds, amperes, coulombs, volts, kelvin.
//!
//! Lava blobs — buoyant blobs heated at the floor and cooled at the ceiling
//!   (Newtonian heating/cooling, Boussinesq buoyancy a = g·(T − T_env)/T_env, linear
//!   Stokes drag). Their charge follows thermionic emission (Richardson–Dushman):
//!   hot rising blobs turn positive, cold sinking blobs stay negative.
//! Fluid — kinematic-simulation turbulence (Kraichnan/Fung): divergence-free random
//!   Fourier modes with a Kolmogorov k^{−5/3} spectrum (smoke-like folding), plus the
//!   Stokes flow dragged by the charge cells (regularised Stokeslets, Cortez 2001) and
//!   weak Rayleigh–Bénard rolls; sampled on a coarse grid, trilinearly interpolated.
//!   Small-scale mixing adds Brownian diffusion √(2D·dt).
//! Electrostatics — E = k Σ q (x − x_q)/(|x − x_q|² + a²)^{3/2}, k = 8.99×10⁹, q in C.
//! Leader — 3-D stochastic dielectric breakdown: candidate steps weighted by
//!   (d̂·Ê)^η × T_WKB(F)^w × e^{σN(0,1)}, sampled by the Born rule (P ∝ |ψ|² ∝ weight).
//! Quantum tunnelling — Fowler–Nordheim field emission with Murphy–Good barrier functions
//!   (Forbes 2006): ln T = −v(f)·bφ^{3/2}/F, J = (a/(φt²))F²·T, F = β|E|. J sets the
//!   stepping rate; T weights each candidate breakdown site.
//! Connections — leader tips attach to positive blobs or to any existing channel
//!   (spatial hash); nearby hot channels of different bolts spawn bridging leaders.
//! Return stroke — Heidler current (IEC 62305-1), MTLE propagation, CIGRE currents,
//!   re-strikes, continuing current; T = 4000 + 26000·(I/30 kA)^0.12.
//! Colour — lightning: air-plasma emission (N II/O II/N I/O I/H lines, Boltzmann ×
//!   Saha, recombination continuum) → CIE 1931 → sRGB. Lava: Planck black body
//!   (colour temperature).

#![allow(static_mut_refs)]

use std::f32::consts::PI;

const LUT_N: usize = 1024;
const LUT_TMIN: f32 = 1500.0;
const LUT_TMAX: f32 = 40000.0;
const BB_N: usize = 256;
const BB_TMIN: f32 = 800.0;
const BB_TMAX: f32 = 12000.0;
const SEG_FLOATS: usize = 8;
const MAX_SEGS: usize = 60000;
const MAX_BOLTS: usize = 10;
const MAX_BRIDGES: usize = 12;
const MAX_BLOBS: usize = 12;
const NODE_CAP: usize = 2400;
const STEP: f32 = 15.0;
const CELL: f32 = 48.0;
const COULOMB_K: f32 = 8.99e9;

const H_PLANCK: f64 = 6.626_070_15e-34;
const C_LIGHT: f64 = 2.997_924_58e8;
const K_B: f64 = 1.380_649e-23;
const K_B_EV: f64 = 8.617_333e-5;
const FN_A: f32 = 1.541_434e-6;
const FN_B: f32 = 6.830_890e9;
const FN_C: f32 = 1.439_965e-9;

const V_RS: f32 = 1.2e8;
const LAMBDA_MTLE: f32 = 2000.0;
const T_AMB: f32 = 300.0;

// ---------------------------------------------------------------- RNG (PCG32)
struct Rng(u64);
impl Rng {
    fn u32(&mut self) -> u32 {
        let old = self.0;
        self.0 = old.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let xs = (((old >> 18) ^ old) >> 27) as u32;
        xs.rotate_right((old >> 59) as u32)
    }
    fn f(&mut self) -> f32 {
        (self.u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
    fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }
    fn gauss(&mut self) -> f32 {
        let u1 = self.f().max(1e-7);
        let u2 = self.f();
        (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos()
    }
    fn gauss3(&mut self) -> V3 {
        [self.gauss(), self.gauss(), self.gauss()]
    }
    fn lognormal(&mut self, median: f32, s: f32) -> f32 {
        median * (s * self.gauss()).exp()
    }
}

type V3 = [f32; 3];
#[inline]
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn mul(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn len(a: V3) -> f32 {
    dot(a, a).sqrt()
}
#[inline]
fn norm(a: V3) -> V3 {
    mul(a, 1.0 / len(a).max(1e-9))
}

// ---------------------------------------------------------------- spectroscopy
fn cie_xyz(l: f64) -> (f64, f64, f64) {
    fn g(x: f64, mu: f64, s1: f64, s2: f64) -> f64 {
        let t = (x - mu) / if x < mu { s1 } else { s2 };
        (-0.5 * t * t).exp()
    }
    let x = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
    let y = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
    let z = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
    (x, y, z)
}
fn planck(lambda_m: f64, t: f64) -> f64 {
    let a = 2.0 * H_PLANCK * C_LIGHT * C_LIGHT / lambda_m.powi(5);
    a / (H_PLANCK * C_LIGHT / (lambda_m * K_B * t)).exp_m1()
}
fn xyz_to_rgb(x: f64, y: f64, z: f64) -> [f32; 3] {
    let r = (3.2404542 * x - 1.5371385 * y - 0.4985314 * z).max(0.0);
    let g = (-0.9692660 * x + 1.8760108 * y + 0.0415560 * z).max(0.0);
    let b = (0.0556434 * x - 0.2040259 * y + 1.0572252 * z).max(0.0);
    let m = r.max(g).max(b).max(1e-300);
    [(r / m) as f32, (g / m) as f32, (b / m) as f32]
}
/// Black-body chromaticity (colour temperature) and luminance.
fn blackbody(t: f64) -> ([f32; 3], f64) {
    let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
    let mut l = 360.0;
    while l <= 830.0 {
        let b = planck(l * 1e-9, t);
        let (cx, cy, cz) = cie_xyz(l);
        x += b * cx;
        y += b * cy;
        z += b * cz;
        l += 2.0;
    }
    (xyz_to_rgb(x, y, z), y)
}
fn saha_nitrogen(t: f64) -> f64 {
    let n_tot = 2.5e24;
    let s = 2.415e21 * t.powf(1.5) * 4.5 * (-14.534 / (K_B_EV * t)).exp() / n_tot;
    (-s + (s * s + 4.0 * s).sqrt()) / 2.0
}
/// Air-plasma emission colour at temperature T (lines + continuum).
fn lightning_color(t: f64) -> ([f32; 3], f64) {
    let kt = K_B_EV * t;
    let x_ion = saha_nitrogen(t);
    // (λ nm, upper level eV, relative gA × abundance, ion?)
    const LINES: [(f64, f64, f64, u8); 21] = [
        (399.5, 21.60, 0.30, 1),
        (404.1, 23.42, 0.20, 1),
        (444.7, 23.20, 0.30, 1),
        (463.0, 21.16, 0.70, 1),
        (480.3, 23.24, 0.40, 1),
        (500.5, 23.14, 1.00, 1),
        (567.9, 20.67, 0.65, 1),
        (594.2, 23.24, 0.30, 1),
        (648.2, 20.41, 0.15, 1),
        (434.9, 25.85, 0.15, 1),
        (441.5, 26.25, 0.15, 1),
        (464.9, 25.66, 0.15, 1),
        (656.3, 12.09, 0.012, 0),
        (486.1, 12.75, 0.004, 0),
        (434.0, 13.05, 0.002, 0),
        (746.8, 11.99, 0.60, 0),
        (821.6, 11.84, 0.50, 0),
        (777.4, 10.74, 1.00, 0),
        (844.6, 10.99, 0.50, 0),
        (715.6, 14.46, 0.30, 0),
        (615.8, 12.75, 0.40, 0),
    ];
    let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
    for &(lam, eu, g, ion) in LINES.iter() {
        let frac = if ion == 1 { x_ion } else { 1.0 - x_ion };
        let i = 3.0e12 * g * frac * (-eu / kt).exp();
        let (cx, cy, cz) = cie_xyz(lam);
        x += i * cx;
        y += i * cy;
        z += i * cz;
    }
    let mut lam = 380.0;
    while lam <= 780.0 {
        let b = planck(lam * 1e-9, t) * 1e-9 * 4.0 * x_ion * x_ion * 1.5;
        let (cx, cy, cz) = cie_xyz(lam);
        x += b * cx;
        y += b * cy;
        z += b * cz;
        lam += 4.0;
    }
    (xyz_to_rgb(x, y, z), y)
}

// ---------------------------------------------------------------- quantum tunnelling
/// Fowler–Nordheim with Murphy–Good barrier functions. Returns (ln T_WKB, J [A/m²]).
fn fowler_nordheim(f_field: f32, phi: f32) -> (f32, f32) {
    let ff = f_field.max(1.0);
    let f = (FN_C * ff / (phi * phi)).clamp(1e-6, 1.0);
    let v = 1.0 - f + (f / 6.0) * f.ln();
    let tf = 1.0 + f / 9.0 - (f / 18.0) * f.ln();
    let ln_t = -v * FN_B * phi.powf(1.5) / ff;
    (ln_t, FN_A / (phi * tf * tf) * ff * ff * ln_t.exp())
}

fn heidler(t: f32, i0: f32, tau1: f32, tau2: f32, eta: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    let x = (t / tau1).powi(10);
    i0 / eta * x / (1.0 + x) * (-t / tau2).exp()
}
fn t_of_current(i: f32) -> f32 {
    if i <= 1.0 {
        return T_AMB;
    }
    (4000.0 + 26000.0 * (i / 30_000.0).powf(0.12)).min(38_000.0)
}

// ---------------------------------------------------------------- model
#[derive(Clone, Copy)]
struct Node {
    p: V3,
    parent: i32,
    jit: V3,
    temp: f32,
    amp: f32,
    dist: f32,
    depth: u8,
    main: bool,
    alive: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Leader,
    Connected,
    Fizzle,
}

struct Tip {
    node: usize,
    dir: V3,
    steps: u32,
    depth: u8,
}

struct Bolt {
    uid: u32,
    nodes: Vec<Node>,
    tips: Vec<Tip>,
    phase: Phase,
    target: Option<V3>, // bridging leaders aim at a point on another channel
    bridge: bool,
    step_acc: f32,
    age: f32,
    life: f32,
    stroke_t: f32,
    i0: f32,
    tau1: f32,
    tau2: f32,
    eta_h: f32,
    t_peak: f32,
    i_cc: f32,
    compacted: bool,
}

#[derive(Clone, Copy)]
struct Blob {
    p: V3,
    v: V3,
    temp: f32, // K (lava colour temperature)
    q: f32,    // C
    a: f32,    // radius (m)
}

/// One Fourier mode of the kinematic-simulation turbulence field.
#[derive(Clone, Copy)]
struct Mode {
    k: V3,     // wavevector (rad/m)
    a: V3,     // cos amplitude, ⟂ k
    b: V3,     // sin amplitude, ⟂ k
    omega: f32, // unsteadiness frequency (rad/s)
}

#[derive(Clone, Copy)]
struct Link {
    a_uid: u32,
    a_idx: usize,
    b_uid: u32,
    b_idx: usize,
}

const P_BOLTS: usize = 0;
const P_BLOBS: usize = 1;
const P_HEAT: usize = 2;
const P_FLOW: usize = 3;
const P_ETA: usize = 4;
const P_QUANTUM: usize = 5;
const P_BETA_LOG: usize = 6;
const P_WORKFN: usize = 7;
const P_BRANCH: usize = 8;
const P_CONNECT: usize = 9;
const P_IPEAK: usize = 10;
const P_ICC: usize = 11;
const P_RESTRIKE: usize = 12;
const P_SLOWMO: usize = 13;
const P_LIFE: usize = 14;
const P_CRACKLE: usize = 15;
const P_TENSION: usize = 16;
const P_MIC: usize = 17;
const P_LEADER_SPEED: usize = 18;
const P_TURB: usize = 19; // rms turbulent velocity (m/s)
const P_EDDY: usize = 20; // largest eddy size (m)
const P_DIFFUSE: usize = 21; // small-scale (mist) diffusivity (m²/s)
const N_PARAMS: usize = 22;

struct Grid {
    dims: [usize; 3],
    head: Vec<i32>,
    next: Vec<i32>,
    items: Vec<(V3, u16, u32, f32)>, // position, bolt index, node index, temperature
}

struct Sim {
    rng: Rng,
    p: [f32; N_PARAMS],
    half: V3,
    time: f32,
    bolts: Vec<Bolt>,
    blobs: Vec<Blob>,
    links: Vec<Link>,
    next_uid: u32,
    spawn_t: f32,
    bridge_t: f32,
    strikes: u32,
    restrikes: u32,
    strike_pos: V3,
    fn_j: f32,
    tip_field: f32,
    grid: Grid,
    out: Vec<f32>,
    blob_out: Vec<f32>,
    info: [f32; 16],
    lut: Vec<f32>,
    bb_lut: Vec<f32>,
    kids: Vec<u16>,
    first_child: Vec<i32>,
    restrike_req: Vec<u32>,
    modes: Vec<Mode>,
    modes_key: f32,
    fgrid: Vec<V3>,
    fdims: [usize; 3],
    fcell: V3,
    flow_frame: u32,
}

static mut SIM: Option<Sim> = None;
fn sim() -> &'static mut Sim {
    unsafe { SIM.as_mut().expect("init() first") }
}

fn cell_of(p: V3, h: V3, dims: [usize; 3]) -> usize {
    let cx = (((p[0] + h[0]) / CELL).max(0.0) as usize).min(dims[0] - 1);
    let cy = (((p[1] + h[1]) / CELL).max(0.0) as usize).min(dims[1] - 1);
    let cz = (((p[2] + h[2]) / CELL).max(0.0) as usize).min(dims[2] - 1);
    cx + dims[0] * (cy + dims[1] * cz)
}

fn placeholder() -> Bolt {
    Bolt {
        uid: 0,
        nodes: Vec::new(),
        tips: Vec::new(),
        phase: Phase::Fizzle,
        target: None,
        bridge: false,
        step_acc: 0.0,
        age: 0.0,
        life: 0.0,
        stroke_t: 0.0,
        i0: 0.0,
        tau1: 1.0,
        tau2: 1.0,
        eta_h: 1.0,
        t_peak: 0.0,
        i_cc: 0.0,
        compacted: false,
    }
}

impl Sim {
    fn new(seed: u32) -> Sim {
        let mut p = [0.0; N_PARAMS];
        p[P_BOLTS] = 4.0;
        p[P_BLOBS] = 7.0;
        p[P_HEAT] = 1.0;
        p[P_FLOW] = 1.0;
        p[P_ETA] = 2.6;
        p[P_QUANTUM] = 0.25;
        p[P_BETA_LOG] = 4.4;
        p[P_WORKFN] = 4.5;
        p[P_BRANCH] = 0.35;
        p[P_CONNECT] = 170.0;
        p[P_IPEAK] = 31.0;
        p[P_ICC] = 2500.0;
        p[P_RESTRIKE] = 1.0;
        p[P_SLOWMO] = 0.0005;
        p[P_LIFE] = 11.0;
        p[P_CRACKLE] = 0.3;
        p[P_TENSION] = 0.3;
        p[P_LEADER_SPEED] = 170.0;
        p[P_TURB] = 35.0;
        p[P_EDDY] = 1400.0;
        p[P_DIFFUSE] = 40.0;
        p[P_FLOW] = 0.15;
        let mut s = Sim {
            rng: Rng(0x853c49e6748fea9b ^ ((seed as u64) << 21 | seed as u64)),
            p,
            half: [1600.0, 1000.0, 800.0],
            time: 0.0,
            bolts: Vec::new(),
            blobs: Vec::new(),
            links: Vec::new(),
            next_uid: 1,
            spawn_t: 0.0,
            bridge_t: 0.0,
            strikes: 0,
            restrikes: 0,
            strike_pos: [0.0; 3],
            fn_j: 0.0,
            tip_field: 0.0,
            grid: Grid { dims: [1, 1, 1], head: vec![-1], next: Vec::new(), items: Vec::new() },
            out: vec![0.0; MAX_SEGS * SEG_FLOATS],
            blob_out: vec![0.0; MAX_BLOBS * 8],
            info: [0.0; 16],
            lut: vec![0.0; LUT_N * 4],
            bb_lut: vec![0.0; BB_N * 4],
            kids: Vec::new(),
            first_child: Vec::new(),
            restrike_req: Vec::new(),
            modes: Vec::new(),
            modes_key: -1.0,
            fgrid: Vec::new(),
            fdims: [2, 2, 2],
            fcell: [1.0; 3],
            flow_frame: 0,
        };
        let yref = lightning_color(30000.0).1;
        for i in 0..LUT_N {
            let t = LUT_TMIN + (LUT_TMAX - LUT_TMIN) * i as f32 / (LUT_N - 1) as f32;
            let (c, y) = lightning_color(t as f64);
            s.lut[i * 4..i * 4 + 3].copy_from_slice(&c);
            // perceived brightness: Fechner's law over ~7 decades
            let f = (1.0 + (y / yref).max(1e-30).log10() / 7.0).max(0.0);
            s.lut[i * 4 + 3] = (f * f) as f32;
        }
        let yb = blackbody(2500.0).1;
        for i in 0..BB_N {
            let t = BB_TMIN + (BB_TMAX - BB_TMIN) * i as f32 / (BB_N - 1) as f32;
            let (c, y) = blackbody(t as f64);
            s.bb_lut[i * 4..i * 4 + 3].copy_from_slice(&c);
            // perceived brightness (Stevens' power law, exponent 1/3)
            s.bb_lut[i * 4 + 3] = ((y / yb) as f32).powf(1.0 / 3.0);
        }
        s
    }

    fn inside(&self, x: V3, margin: f32) -> bool {
        (0..3).all(|i| x[i].abs() < self.half[i] - margin)
    }

    // ------------------------------------------------------------ lava blobs
    fn ensure_blobs(&mut self) {
        let n = (self.p[P_BLOBS] as usize).clamp(2, MAX_BLOBS);
        let h = self.half;
        while self.blobs.len() < n {
            let neg = self.blobs.len() % 2 == 0;
            let hot = self.rng.f() < 0.5;
            let b = Blob {
                p: [self.rng.range(-0.8, 0.8) * h[0], self.rng.range(-0.8, 0.8) * h[1], self.rng.range(-0.7, 0.7) * h[2]],
                v: [0.0; 3],
                temp: if hot { 2500.0 } else { 1400.0 },
                q: if neg { -1.0 } else { 1.0 } * self.rng.range(8.0, 16.0),
                a: self.rng.range(0.10, 0.16) * h[1],
            };
            self.blobs.push(b);
        }
        self.blobs.truncate(n);
    }

    fn move_blobs(&mut self, dt: f32) {
        let h = self.half;
        let heat = self.p[P_HEAT] * (1.0 + self.p[P_MIC]);
        let n = self.blobs.len();
        let (t_env, t_hot, t_cold) = (1900.0f32, 2700.0f32, 1250.0f32);
        let g = 9.81f32;
        for i in 0..n {
            let mut acc = [0.0f32; 3];
            let b = self.blobs[i];
            // Boussinesq buoyancy (scaled to the chamber): a_y = g·(T − T_env)/T_env
            acc[1] += g * (b.temp - t_env) / t_env * 9.0 * heat;
            // soft contact between blobs
            for j in 0..n {
                if i == j {
                    continue;
                }
                let d = sub(b.p, self.blobs[j].p);
                let r = len(d);
                let rr = (b.a + self.blobs[j].a) * 1.1;
                if r < rr && r > 1e-3 {
                    acc = add(acc, mul(d, (rr - r) / r * 0.6));
                }
            }
            for k in 0..3 {
                let lim = h[k] - b.a;
                if b.p[k] > lim {
                    acc[k] -= (b.p[k] - lim) * 1.5;
                }
                if b.p[k] < -lim {
                    acc[k] += (-lim - b.p[k]) * 1.5;
                }
            }
            acc = add(acc, mul(self.rng.gauss3(), 6.0));
            let bm = &mut self.blobs[i];
            bm.v = add(bm.v, mul(sub(acc, mul(bm.v, 0.35)), dt)); // Stokes drag
            bm.p = add(bm.p, mul(bm.v, dt));
            // Newtonian heating at the floor, cooling at the ceiling
            let yrel = bm.p[1] / h[1];
            let (target, rate) = if yrel < -0.65 {
                (t_hot, 0.35 * heat)
            } else if yrel > 0.6 {
                (t_cold, 0.35 * heat)
            } else {
                (t_env, 0.01)
            };
            bm.temp += (target - bm.temp) * (rate * dt).min(1.0);
            // thermionic charging (Richardson–Dushman J = A·T²·e^{−W/kT}): hot blobs boil off
            // electrons and turn positive, cold blobs keep a negative charge
            let w_ev = 2.0f32; // effective work function of the lava surface (eV)
            let rd = |t: f32| t * t * (-w_ev / (8.617e-5 * t)).exp();
            let j_rel = rd(bm.temp) / rd(t_env);
            bm.q = 14.0 * (j_rel.ln() / 2.5).tanh();
            for k in 0..3 {
                bm.p[k] = bm.p[k].clamp(-h[k] + bm.a * 0.5, h[k] - bm.a * 0.5);
            }
        }
    }

    // ------------------------------------------------------------ fluid
    /// Kinematic-simulation turbulence (Kraichnan 1970; Fung, Hunt et al. 1992):
    /// u(x,t) = Σₙ aₙ cos(kₙ·x + ωₙt) + bₙ sin(kₙ·x + ωₙt), with aₙ, bₙ ⟂ kₙ so ∇·u = 0
    /// exactly. |kₙ| is log-spaced and the mode energies follow Kolmogorov's
    /// E(k) ∝ k^{−5/3}; ωₙ ∝ the eddy-turnover rate kₙ·uₙ. The result is the wispy,
    /// randomly folding motion of smoke or mist.
    fn ensure_modes(&mut self) {
        let key = self.p[P_EDDY] + self.p[P_TURB] * 1e-3;
        if (key - self.modes_key).abs() < 1e-6 && !self.modes.is_empty() {
            return;
        }
        self.modes_key = key;
        const N: usize = 20;
        let l_max = self.p[P_EDDY].max(200.0);
        let l_min = (3.0 * self.fcell[1].max(60.0)).min(l_max * 0.5);
        let (k0, k1) = (2.0 * PI / l_max, 2.0 * PI / l_min);
        let mut modes = Vec::with_capacity(N);
        let mut e_sum = 0.0;
        for n in 0..N {
            let kmag = k0 * (k1 / k0).powf(n as f32 / (N - 1) as f32);
            let dk = kmag * (k1 / k0).ln() / (N - 1) as f32;
            let e = kmag.powf(-5.0 / 3.0) * dk; // Kolmogorov spectrum
            e_sum += e;
            let khat = norm(self.rng.gauss3());
            let perp = |v: V3, kh: V3| norm(sub(v, mul(kh, dot(v, kh))));
            let a = perp(self.rng.gauss3(), khat);
            let b = perp(self.rng.gauss3(), khat);
            modes.push((mul(khat, kmag), a, b, e));
        }
        let u_rms = self.p[P_TURB];
        self.modes = modes
            .into_iter()
            .map(|(k, a, b, e)| {
                let amp = u_rms * (e / e_sum).sqrt();
                let kk = len(k);
                Mode { k, a: mul(a, amp), b: mul(b, amp), omega: 0.5 * kk * amp }
            })
            .collect();
    }

    /// Rebuild the coarse velocity grid: turbulence + blob Stokeslets + convection rolls.
    fn build_flow(&mut self) {
        let h = self.half;
        let cell = 150.0f32;
        let dims = [((2.0 * h[0] / cell).ceil() as usize + 1).max(2), ((2.0 * h[1] / cell).ceil() as usize + 1).max(2), ((2.0 * h[2] / cell).ceil() as usize + 1).max(2)];
        self.fdims = dims;
        self.fcell = [2.0 * h[0] / (dims[0] - 1) as f32, 2.0 * h[1] / (dims[1] - 1) as f32, 2.0 * h[2] / (dims[2] - 1) as f32];
        self.ensure_modes();
        let n = dims[0] * dims[1] * dims[2];
        let mut g = std::mem::take(&mut self.fgrid);
        g.clear();
        g.resize(n, [0.0; 3]);
        let t = self.time;
        let tscale = 1.0 + 1.5 * self.p[P_MIC];
        // separable phasors: e^{i(k·x+ωt)} = e^{i kx x}·e^{i ky y}·e^{i(kz z + ωt)}
        let mut px = vec![(0.0f32, 0.0f32); dims[0]];
        let mut py = vec![(0.0f32, 0.0f32); dims[1]];
        let mut pz = vec![(0.0f32, 0.0f32); dims[2]];
        for m in self.modes.iter() {
            for i in 0..dims[0] {
                let x = -h[0] + i as f32 * self.fcell[0];
                px[i] = ((m.k[0] * x).cos(), (m.k[0] * x).sin());
            }
            for j in 0..dims[1] {
                let y = -h[1] + j as f32 * self.fcell[1];
                py[j] = ((m.k[1] * y).cos(), (m.k[1] * y).sin());
            }
            for kz in 0..dims[2] {
                let z = -h[2] + kz as f32 * self.fcell[2];
                let ph = m.k[2] * z + m.omega * t * tscale;
                pz[kz] = (ph.cos(), ph.sin());
            }
            for kz in 0..dims[2] {
                let (zc, zs) = pz[kz];
                for j in 0..dims[1] {
                    let (yc, ys) = py[j];
                    let (yzc, yzs) = (yc * zc - ys * zs, yc * zs + ys * zc);
                    let row = dims[0] * (j + dims[1] * kz);
                    for i in 0..dims[0] {
                        let (xc, xs) = px[i];
                        let c = xc * yzc - xs * yzs;
                        let sn = xc * yzs + xs * yzc;
                        let u = &mut g[row + i];
                        u[0] += m.a[0] * c + m.b[0] * sn;
                        u[1] += m.a[1] * c + m.b[1] * sn;
                        u[2] += m.a[2] * c + m.b[2] * sn;
                    }
                }
            }
        }
        for kz in 0..dims[2] {
            for j in 0..dims[1] {
                for i in 0..dims[0] {
                    let x = [-h[0] + i as f32 * self.fcell[0], -h[1] + j as f32 * self.fcell[1], -h[2] + kz as f32 * self.fcell[2]];
                    let idx = i + dims[0] * (j + dims[1] * kz);
                    let mut u = mul(g[idx], tscale);
                    u = add(u, self.flow_extra(x));
                    // glass walls: no flow through the glass, and smoke that reaches the
                    // glass rolls back inward (wall-bounded recirculation)
                    let urms = self.p[P_TURB] * tscale;
                    for a in 0..3 {
                        let d = x[a].abs();
                        if d > h[a] * 0.7 {
                            let s = ((d - h[a] * 0.7) / (h[a] * 0.3)).clamp(0.0, 1.0);
                            let ramp = s * s * (3.0 - 2.0 * s);
                            if x[a] * u[a] > 0.0 {
                                u[a] *= 1.0 - ramp;
                            }
                            u[a] -= x[a].signum() * urms * 0.8 * ramp;
                        }
                    }
                    g[idx] = u;
                }
            }
        }
        self.fgrid = g;
    }

    /// Blob-driven Stokes flow and gentle convection rolls (lava-lamp component).
    fn flow_extra(&self, x: V3) -> V3 {
        let h = self.half;
        let mut u = [0.0f32; 3];
        for b in self.blobs.iter() {
            let d = sub(x, b.p);
            let r2 = dot(d, d);
            let e2 = b.a * b.a;
            let q = r2 + e2;
            let den = q * q.sqrt();
            let c1 = (r2 + 2.0 * e2) / den;
            let c2 = dot(b.v, d) / den;
            u = add(u, mul(add(mul(b.v, c1), mul(d, c2)), 0.75 * b.a));
        }
        let flow = self.p[P_FLOW] * (1.0 + 1.5 * self.p[P_MIC]);
        let xx = (x[0] + h[0]) / (2.0 * h[0]);
        let yy = (x[1] + h[1]) / (2.0 * h[1]);
        let zz = (x[2] + h[2]) / (2.0 * h[2]);
        let uu = 60.0 * flow;
        let ph = self.time * 0.05;
        let m1 = (2.0 * PI * zz + ph).cos();
        u[0] += uu * (PI * xx).sin() * (PI * yy).cos() * m1 * (h[0] / h[1]);
        u[1] += -uu * (PI * xx).cos() * (PI * yy).sin() * m1;
        u
    }

    /// Trilinear interpolation of the velocity grid.
    fn velocity(&self, x: V3) -> V3 {
        let h = self.half;
        let d = self.fdims;
        if self.fgrid.len() != d[0] * d[1] * d[2] {
            return [0.0; 3];
        }
        let mut i0 = [0usize; 3];
        let mut f = [0.0f32; 3];
        for a in 0..3 {
            let g = ((x[a] + h[a]) / self.fcell[a]).clamp(0.0, (d[a] - 1) as f32 - 1e-3);
            i0[a] = g as usize;
            f[a] = g - i0[a] as f32;
        }
        let idx = |i: usize, j: usize, k: usize| i + d[0] * (j + d[1] * k);
        let mut u = [0.0f32; 3];
        for dz in 0..2 {
            let wz = if dz == 0 { 1.0 - f[2] } else { f[2] };
            for dy in 0..2 {
                let wy = if dy == 0 { 1.0 - f[1] } else { f[1] };
                for dx in 0..2 {
                    let wx = if dx == 0 { 1.0 - f[0] } else { f[0] };
                    let v = self.fgrid[idx(i0[0] + dx, i0[1] + dy, i0[2] + dz)];
                    let w = wx * wy * wz;
                    u[0] += v[0] * w;
                    u[1] += v[1] * w;
                    u[2] += v[2] * w;
                }
            }
        }
        u
    }

    // ------------------------------------------------------------ electrostatics
    fn efield(&self, x: V3) -> V3 {
        let mut e = [0.0f32; 3];
        for b in self.blobs.iter() {
            let d = sub(x, b.p);
            let r2 = dot(d, d) + b.a * b.a;
            e = add(e, mul(d, COULOMB_K * b.q / (r2 * r2.sqrt())));
        }
        e
    }

    // ------------------------------------------------------------ spatial hash
    fn build_grid(&mut self) {
        let h = self.half;
        let dims = [((2.0 * h[0] / CELL) as usize + 2), ((2.0 * h[1] / CELL) as usize + 2), ((2.0 * h[2] / CELL) as usize + 2)];
        let nc = dims[0] * dims[1] * dims[2];
        let g = &mut self.grid;
        g.dims = dims;
        g.head.clear();
        g.head.resize(nc, -1);
        g.next.clear();
        g.items.clear();
        for (bi, b) in self.bolts.iter().enumerate() {
            for (ni, nd) in b.nodes.iter().enumerate() {
                if !nd.alive {
                    continue;
                }
                let c = cell_of(nd.p, h, dims);
                g.items.push((nd.p, bi as u16, ni as u32, nd.temp));
                g.next.push(g.head[c]);
                g.head[c] = (g.items.len() - 1) as i32;
            }
        }
    }

    /// Nearest grid item within radius r that belongs to a different bolt.
    fn query(&self, x: V3, r: f32, exclude_bolt: usize, min_temp: f32) -> Option<(usize, usize, V3)> {
        let h = self.half;
        let g = &self.grid;
        let c = [((x[0] + h[0]) / CELL) as i32, ((x[1] + h[1]) / CELL) as i32, ((x[2] + h[2]) / CELL) as i32];
        let reach = (r / CELL).ceil() as i32;
        let mut best: Option<(usize, usize, V3)> = None;
        let mut bd = r * r;
        for dz in -reach..=reach {
            for dy in -reach..=reach {
                for dx in -reach..=reach {
                    let (cx, cy, cz) = (c[0] + dx, c[1] + dy, c[2] + dz);
                    if cx < 0 || cy < 0 || cz < 0 || cx >= g.dims[0] as i32 || cy >= g.dims[1] as i32 || cz >= g.dims[2] as i32 {
                        continue;
                    }
                    let mut it = g.head[cx as usize + g.dims[0] * (cy as usize + g.dims[1] * cz as usize)];
                    while it >= 0 {
                        let (p, bi, ni, t) = g.items[it as usize];
                        if bi as usize != exclude_bolt && t >= min_temp {
                            let d2 = dot(sub(p, x), sub(p, x));
                            if d2 < bd {
                                bd = d2;
                                best = Some((bi as usize, ni as usize, p));
                            }
                        }
                        it = g.next[it as usize];
                    }
                }
            }
        }
        best
    }

    // ------------------------------------------------------------ bolts
    fn new_bolt(&mut self, start: V3, dir: V3, target: Option<V3>, bridge: bool) {
        let root = Node { p: start, parent: -1, jit: [0.0; 3], temp: 16000.0, amp: 0.0, dist: 0.0, depth: 0, main: false, alive: true };
        let life = self.p[P_LIFE] * self.rng.range(0.7, 1.3) * if bridge { 0.6 } else { 1.0 };
        let uid = self.next_uid;
        self.next_uid += 1;
        let mut b = placeholder();
        b.uid = uid;
        b.nodes = vec![root];
        b.tips = vec![Tip { node: 0, dir, steps: 0, depth: 0 }];
        b.phase = Phase::Leader;
        b.target = target;
        b.bridge = bridge;
        b.life = life;
        self.bolts.push(b);
    }

    fn spawn_main(&mut self) {
        let negs: Vec<usize> = (0..self.blobs.len()).filter(|&i| self.blobs[i].q < 0.0).collect();
        if negs.is_empty() {
            return;
        }
        let b = self.blobs[negs[(self.rng.f() * negs.len() as f32) as usize % negs.len()]];
        let d = norm(self.rng.gauss3());
        let start = add(b.p, mul(d, b.a * 1.05));
        let e = mul(self.efield(start), -1.0);
        self.new_bolt(start, norm(add(norm(e), d)), None, false);
    }

    fn spawn_bridge(&mut self) {
        let nb = self.bolts.len();
        if nb < 2 || self.bolts.iter().filter(|b| b.bridge).count() >= MAX_BRIDGES {
            return;
        }
        let r = self.p[P_CONNECT];
        for _ in 0..6 {
            let bi = (self.rng.f() * nb as f32) as usize % nb;
            let b = &self.bolts[bi];
            if b.phase != Phase::Connected || b.nodes.len() < 4 {
                continue;
            }
            let ni = (self.rng.f() * b.nodes.len() as f32) as usize % b.nodes.len();
            let nd = b.nodes[ni];
            if !nd.alive || nd.temp < 8000.0 {
                continue;
            }
            if let Some((_, _, q)) = self.query(nd.p, r, bi, 8000.0) {
                if len(sub(q, nd.p)) > STEP * 2.0 {
                    let dir = norm(sub(q, nd.p));
                    self.new_bolt(nd.p, dir, Some(q), true);
                    return;
                }
            }
        }
    }

    fn leader_step(&mut self, bi: usize, b: &mut Bolt) {
        let eta = self.p[P_ETA];
        let qw = self.p[P_QUANTUM];
        let beta = 10f32.powf(self.p[P_BETA_LOG]);
        let phi = self.p[P_WORKFN];
        let branch = self.p[P_BRANCH];
        let capture = STEP * 1.3;
        let mut new_tips = Vec::new();
        let mut connected: Option<(usize, Option<(usize, usize)>)> = None;
        let tips = std::mem::take(&mut b.tips);
        for tip in tips.into_iter() {
            if b.nodes.len() >= NODE_CAP / 2 {
                break;
            }
            let p = b.nodes[tip.node].p;
            let e = self.efield(p);
            let emag = len(e);
            let mut ehat = mul(e, -1.0 / emag.max(1e-9)); // negative leader → along −E
            if let Some(t) = b.target {
                ehat = norm(add(mul(norm(sub(t, p)), 1.6), mul(ehat, 0.4)));
            }
            const K: usize = 10;
            let mut cand = [[0.0f32; 3]; K];
            let mut lw = [0.0f32; K];
            let mut mx = f32::MIN;
            for k in 0..K {
                let d = norm(add(add(tip.dir, mul(ehat, 0.7)), mul(self.rng.gauss3(), 0.75)));
                let c = dot(d, ehat).max(0.02);
                // local field at the candidate site → WKB tunnelling probability
                let fq = len(self.efield(add(p, mul(d, STEP)))) * beta;
                let (ln_t, _) = fowler_nordheim(fq, phi);
                lw[k] = eta * c.ln() + qw * ln_t + 0.5 * self.rng.gauss();
                cand[k] = d;
                mx = mx.max(lw[k]);
            }
            // Born-rule sampling: P ∝ |ψ|² ∝ exp(lw)
            let mut tot = 0.0;
            for w in lw.iter_mut() {
                *w = (*w - mx).exp();
                tot += *w;
            }
            let mut r = self.rng.f() * tot;
            let mut pick = K - 1;
            for k in 0..K {
                r -= lw[k];
                if r <= 0.0 {
                    pick = k;
                    break;
                }
            }
            let d = cand[pick];
            self.tip_field = emag;
            self.fn_j = fowler_nordheim(emag * beta, phi).1;
            let l = STEP * self.rng.range(0.7, 1.3);
            let q = add(p, mul(d, l));
            let depth = tip.depth;
            b.nodes.push(Node { p: q, parent: tip.node as i32, jit: mul(self.rng.gauss3(), 0.3), temp: 20000.0, amp: 0.0, dist: 0.0, depth, main: false, alive: true });
            let ni = b.nodes.len() - 1;
            // attachment: a positive blob, an existing channel of another bolt, or the bridge target
            if self.blobs.iter().any(|bl| bl.q > 0.0 && len(sub(q, bl.p)) < bl.a * 1.05) {
                connected = Some((ni, None));
                break;
            }
            if let Some((obi, oni, _)) = self.query(q, capture, bi, 2500.0) {
                connected = Some((ni, Some((obi, oni))));
                break;
            }
            if let Some(t) = b.target {
                if len(sub(q, t)) < capture {
                    connected = Some((ni, None));
                    break;
                }
            }
            if !self.inside(q, 5.0) || tip.steps > 700 {
                continue;
            }
            new_tips.push(Tip { node: ni, dir: d, steps: tip.steps + 1, depth });
            if depth < 4 && self.rng.f() < branch * if b.bridge { 0.02 } else { 0.06 } {
                let bd = norm(add(d, mul(self.rng.gauss3(), 0.9)));
                new_tips.push(Tip { node: ni, dir: bd, steps: tip.steps + 1, depth: depth + 1 });
            }
        }
        if let Some((att, other)) = connected {
            if let Some((obi, oni)) = other {
                let ouid = self.bolts.get(obi).map(|x| x.uid).unwrap_or(0);
                self.links.push(Link { a_uid: b.uid, a_idx: att, b_uid: ouid, b_idx: oni });
                self.restrike_req.push(ouid); // current flows into the other channel too
            }
            self.connect(b, att);
        } else {
            b.tips = new_tips;
            if b.tips.is_empty() {
                b.phase = Phase::Fizzle;
                b.life = b.age + 0.6;
            }
        }
    }

    fn connect(&mut self, b: &mut Bolt, att: usize) {
        b.tips.clear();
        b.phase = Phase::Connected;
        let mut c = att as i32;
        let mut d = 0.0;
        let mut prev: Option<V3> = None;
        while c >= 0 {
            let n = &mut b.nodes[c as usize];
            if let Some(pp) = prev {
                d += len(sub(n.p, pp));
            }
            n.main = true;
            n.amp = 1.0;
            n.dist = d;
            n.depth = 0;
            prev = Some(n.p);
            c = n.parent;
        }
        // breadth-first from the root so parents are processed before children
        let n = b.nodes.len();
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); n];
        let mut queue = Vec::with_capacity(n);
        for i in 0..n {
            let pr = b.nodes[i].parent;
            if pr >= 0 {
                children[pr as usize].push(i);
            } else {
                queue.push(i);
            }
        }
        let mut qi = 0;
        while qi < queue.len() {
            let pi = queue[qi];
            qi += 1;
            for &i in children[pi].iter() {
                queue.push(i);
                if b.nodes[i].main {
                    continue;
                }
                let par = b.nodes[pi];
                let l = len(sub(b.nodes[i].p, par.p));
                b.nodes[i].dist = par.dist + l;
                b.nodes[i].amp = if par.main { 0.3 } else { par.amp * (-l / 350.0).exp() };
                b.nodes[i].depth = b.nodes[i].depth.max(1);
            }
        }
        self.begin_stroke(b, true);
        self.strike_pos = b.nodes[att].p;
    }

    fn begin_stroke(&mut self, b: &mut Bolt, first: bool) {
        let scale = if b.bridge { 0.5 } else { 1.0 };
        if first {
            // CIGRE first stroke: median 31 kA, σ_ln 0.48; IEC 1/200 µs
            b.i0 = self.rng.lognormal(self.p[P_IPEAK], 0.48) * 1e3 * scale;
            b.tau1 = 1.82e-6;
            b.tau2 = 285e-6;
            b.eta_h = 0.986;
            self.strikes += 1;
        } else {
            // subsequent strokes: median 12 kA, σ_ln 0.53; IEC 0.25/100 µs
            b.i0 = self.rng.lognormal(self.p[P_IPEAK] * 12.0 / 31.0, 0.53) * 1e3 * scale;
            b.tau1 = 0.454e-6;
            b.tau2 = 143e-6;
            b.eta_h = 0.993;
            self.restrikes += 1;
        }
        b.t_peak = b.tau1 * (10.0 * b.tau2 / b.tau1).powf(1.0 / 11.0);
        b.stroke_t = 0.0;
    }

    fn update_bolt(&mut self, bi: usize, b: &mut Bolt, dt: f32) {
        b.age += dt;
        let ou_k = (-dt / 0.08f32).exp();
        let ou_s = (1.0 - ou_k * ou_k).sqrt() * 0.45;
        let diff = (2.0 * self.p[P_DIFFUSE] * dt).sqrt();
        for nd in b.nodes.iter_mut() {
            if !nd.alive {
                continue;
            }
            let v1 = self.velocity(nd.p);
            let v2 = self.velocity(add(nd.p, mul(v1, dt * 0.5)));
            // advection + small-scale turbulent diffusion (Brownian step √(2D·dt))
            nd.p = add(add(nd.p, mul(v2, dt)), mul(self.rng.gauss3(), diff));
            for j in 0..3 {
                nd.p[j] = nd.p[j].clamp(-self.half[j] + 2.0, self.half[j] - 2.0);
                nd.jit[j] = nd.jit[j] * ou_k + ou_s * self.rng.gauss();
            }
        }
        if b.phase == Phase::Leader {
            // stepping rate ∝ (J_FN / J_ref)^0.15
            let beta = 10f32.powf(self.p[P_BETA_LOG]);
            let jref = fowler_nordheim(1.0e5 * beta, self.p[P_WORKFN]).1;
            let fnm = if self.fn_j > 0.0 && jref > 0.0 { (self.fn_j / jref).powf(0.15).clamp(0.3, 3.0) } else { 1.0 };
            let speed = self.p[P_LEADER_SPEED] * fnm * (1.0 + 2.0 * self.p[P_MIC]) * if b.bridge { 1.6 } else { 1.0 };
            b.step_acc += dt * speed;
            let mut n = 0;
            while b.step_acc >= 1.0 && b.phase == Phase::Leader && n < 14 {
                b.step_acc -= 1.0;
                n += 1;
                self.leader_step(bi, b);
            }
        }
        let sim_dt = dt * self.p[P_SLOWMO];
        match b.phase {
            Phase::Leader | Phase::Fizzle => {
                let k = (-dt / 0.06f32).exp();
                for nd in b.nodes.iter_mut() {
                    nd.temp = 4200.0 + (nd.temp - 4200.0) * k;
                    if b.phase == Phase::Fizzle {
                        nd.temp *= (-dt / 0.25f32).exp();
                    }
                }
            }
            Phase::Connected => {
                let rate = self.p[P_RESTRIKE] * (1.0 + 3.0 * self.p[P_MIC]);
                if b.stroke_t > 400e-6 && self.rng.f() < rate * dt && b.age < b.life * 0.8 {
                    self.begin_stroke(b, false);
                }
                let t0 = b.stroke_t;
                let t1 = t0 + sim_dt;
                b.stroke_t = t1;
                let lf = (1.0 - b.age / b.life).clamp(0.0, 1.0);
                b.i_cc = self.p[P_ICC] * lf.powf(1.5) * if b.bridge { 0.5 } else { 1.0 };
                let kc = (-sim_dt / 80e-6f32).exp();
                for nd in b.nodes.iter_mut() {
                    if !nd.alive {
                        continue;
                    }
                    let mut i = 0.0;
                    if nd.amp > 0.0 {
                        // MTLE: i(z,t) = i(0, t − z/v)·e^{−z/λ}, max over the frame window
                        let delay = nd.dist / V_RS;
                        let (a, bb) = (t0 - delay, t1 - delay);
                        let mut im = heidler(a, b.i0, b.tau1, b.tau2, b.eta_h).max(heidler(bb, b.i0, b.tau1, b.tau2, b.eta_h));
                        if a < b.t_peak && bb > b.t_peak {
                            im = im.max(heidler(b.t_peak, b.i0, b.tau1, b.tau2, b.eta_h));
                        }
                        i = im * nd.amp * (-nd.dist / LAMBDA_MTLE).exp();
                    }
                    let cc = if nd.main { b.i_cc * (-nd.dist / LAMBDA_MTLE).exp() } else { 0.0 };
                    let floor = t_of_current(cc);
                    let target = t_of_current(i).max(floor);
                    let cooled = floor + (nd.temp - floor).max(0.0) * kc;
                    nd.temp = if nd.temp < floor { floor } else { cooled.max(target) };
                    if !nd.main && nd.temp < floor + 1.0 {
                        nd.temp = (nd.temp * (-dt / 0.3f32).exp()).max(T_AMB);
                    }
                }
            }
        }
        self.resample(b, dt);
    }

    fn resample(&mut self, b: &mut Bolt, dt: f32) {
        let n = b.nodes.len();
        self.kids.clear();
        self.kids.resize(n, 0);
        self.first_child.clear();
        self.first_child.resize(n, -1);
        for i in 0..n {
            if b.nodes[i].alive && b.nodes[i].parent >= 0 {
                let p = b.nodes[i].parent as usize;
                self.kids[p] = self.kids[p].saturating_add(1);
                if self.first_child[p] < 0 {
                    self.first_child[p] = i as i32;
                }
            }
        }
        let tip_nodes: Vec<usize> = b.tips.iter().map(|t| t.node).collect();
        let k = (self.p[P_TENSION] * dt * 12.0).min(0.5);
        if k > 0.0 {
            for i in 0..n {
                if !b.nodes[i].alive || b.nodes[i].parent < 0 || self.kids[i] != 1 {
                    continue;
                }
                let a = b.nodes[b.nodes[i].parent as usize].p;
                let c = b.nodes[self.first_child[i] as usize].p;
                let m = mul(add(a, c), 0.5);
                let p = b.nodes[i].p;
                b.nodes[i].p = add(p, mul(sub(m, p), k));
            }
        }
        for i in 0..n {
            let nd = b.nodes[i];
            if nd.alive && !nd.main && self.kids[i] == 0 && nd.temp < 1200.0 && b.phase != Phase::Leader && !tip_nodes.contains(&i) {
                b.nodes[i].alive = false;
            }
        }
        for i in 0..n {
            if !b.nodes[i].alive || b.nodes[i].parent < 0 {
                continue;
            }
            let pi = b.nodes[i].parent as usize;
            let a = b.nodes[pi];
            let c = b.nodes[i];
            let d = len(sub(c.p, a.p));
            if d > STEP * 1.7 && b.nodes.len() < NODE_CAP {
                let mut m = c;
                m.p = mul(add(a.p, c.p), 0.5);
                m.parent = pi as i32;
                m.jit = mul(self.rng.gauss3(), 0.3);
                m.temp = 0.5 * (a.temp + c.temp);
                m.dist = 0.5 * (a.dist + c.dist);
                m.amp = 0.5 * (a.amp + c.amp);
                m.main = a.main && c.main;
                b.nodes.push(m);
                b.nodes[i].parent = (b.nodes.len() - 1) as i32;
            } else if d < STEP * 0.35 && self.kids[i] == 1 && !tip_nodes.contains(&i) {
                let ch = self.first_child[i] as usize;
                if b.nodes[ch].alive && b.nodes[ch].parent == i as i32 {
                    b.nodes[ch].parent = pi as i32;
                    b.nodes[i].alive = false;
                }
            }
        }
        if b.nodes.len() >= NODE_CAP && b.life > b.age + 1.5 {
            b.life = b.age + 1.5;
        }
        let dead = b.nodes.iter().filter(|x| !x.alive).count();
        if dead > 300 && dead * 3 > b.nodes.len() {
            let mut remap = vec![-1i32; b.nodes.len()];
            let mut out = Vec::with_capacity(b.nodes.len() - dead);
            for (i, nd) in b.nodes.iter().enumerate() {
                if nd.alive {
                    remap[i] = out.len() as i32;
                    out.push(*nd);
                }
            }
            for nd in out.iter_mut() {
                if nd.parent >= 0 {
                    nd.parent = remap[nd.parent as usize];
                }
            }
            for t in b.tips.iter_mut() {
                t.node = remap[t.node].max(0) as usize;
            }
            b.nodes = out;
            b.compacted = true;
        }
    }

    fn step(&mut self, dt: f32) -> u32 {
        let dt = dt.clamp(0.0, 0.05);
        self.time += dt;
        self.strikes = 0;
        self.restrikes = 0;
        self.ensure_blobs();
        self.move_blobs(dt);
        // eddies evolve slowly: refresh the velocity grid every other frame
        self.flow_frame = self.flow_frame.wrapping_add(1);
        if self.flow_frame % 2 == 0 || self.fgrid.is_empty() {
            self.build_flow();
        }
        self.build_grid();
        let want = (self.p[P_BOLTS] as usize).clamp(0, MAX_BOLTS);
        let mains = self.bolts.iter().filter(|b| !b.bridge).count();
        self.spawn_t -= dt;
        if mains < want && self.spawn_t <= 0.0 {
            self.spawn_main();
            self.spawn_t = self.rng.range(0.2, 0.7) / (1.0 + 2.0 * self.p[P_MIC]);
        }
        self.bridge_t -= dt;
        if self.bridge_t <= 0.0 {
            self.spawn_bridge();
            self.bridge_t = self.rng.range(0.15, 0.45);
        }
        for i in 0..self.bolts.len() {
            let mut b = std::mem::replace(&mut self.bolts[i], placeholder());
            self.update_bolt(i, &mut b, dt);
            self.bolts[i] = b;
        }
        // re-strikes in channels that were hit by another leader
        let req = std::mem::take(&mut self.restrike_req);
        for uid in req {
            if let Some(pos) = self.bolts.iter().position(|b| b.uid == uid) {
                let mut b = std::mem::replace(&mut self.bolts[pos], placeholder());
                if b.phase == Phase::Connected {
                    self.begin_stroke(&mut b, false);
                }
                self.bolts[pos] = b;
            }
        }
        // drop links that touch compacted or finished bolts
        self.bolts.retain(|b| b.age < b.life);
        let alive: Vec<(u32, bool)> = self.bolts.iter().map(|b| (b.uid, b.compacted)).collect();
        self.links.retain(|l| {
            let a = alive.iter().find(|x| x.0 == l.a_uid);
            let c = alive.iter().find(|x| x.0 == l.b_uid);
            matches!((a, c), (Some(a), Some(c)) if !a.1 && !c.1)
        });
        for b in self.bolts.iter_mut() {
            b.compacted = false;
        }
        self.emit()
    }

    fn emit(&mut self) -> u32 {
        let crackle = self.p[P_CRACKLE];
        let mut k = 0usize;
        let mut act = 0.0f32;
        let mut c = [0.0f32; 3];
        let mut tmax = 0.0f32;
        for b in self.bolts.iter() {
            let n = b.nodes.len();
            let mut has_child = vec![false; n];
            for nd in b.nodes.iter() {
                if nd.alive && nd.parent >= 0 {
                    has_child[nd.parent as usize] = true;
                }
            }
            for (i, nd) in b.nodes.iter().enumerate() {
                if !nd.alive || nd.parent < 0 || k >= MAX_SEGS {
                    continue;
                }
                let par = &b.nodes[nd.parent as usize];
                if !par.alive || len(sub(nd.p, par.p)) > STEP * 3.5 {
                    continue;
                }
                let t = nd.temp.min(par.temp.max(nd.temp * 0.8));
                if t < LUT_TMIN {
                    continue;
                }
                let a = add(par.p, mul(par.jit, STEP * crackle));
                let e = add(nd.p, mul(nd.jit, STEP * crackle));
                let w = if nd.main { 1.0 } else { 0.6f32.powi(nd.depth.max(1) as i32) } * if b.bridge { 0.8 } else { 1.0 };
                let o = k * SEG_FLOATS;
                self.out[o..o + 3].copy_from_slice(&a);
                self.out[o + 3..o + 6].copy_from_slice(&e);
                self.out[o + 6] = t;
                self.out[o + 7] = if has_child[i] { w } else { -w };
                let li = (((t - LUT_TMIN) / (LUT_TMAX - LUT_TMIN)) * (LUT_N - 1) as f32).clamp(0.0, (LUT_N - 1) as f32) as usize;
                let lum = self.lut[li * 4 + 3] * w * STEP;
                act += lum;
                c = add(c, mul(e, lum));
                tmax = tmax.max(t);
                k += 1;
            }
        }
        // links: junctions where one channel attached to another
        for l in self.links.iter() {
            if k >= MAX_SEGS {
                break;
            }
            let a = self.bolts.iter().find(|b| b.uid == l.a_uid);
            let bb = self.bolts.iter().find(|b| b.uid == l.b_uid);
            if let (Some(a), Some(bb)) = (a, bb) {
                if l.a_idx >= a.nodes.len() || l.b_idx >= bb.nodes.len() {
                    continue;
                }
                let (na, nb) = (a.nodes[l.a_idx], bb.nodes[l.b_idx]);
                if !na.alive || !nb.alive || len(sub(na.p, nb.p)) > STEP * 4.0 {
                    continue;
                }
                let t = na.temp.min(nb.temp);
                if t < LUT_TMIN {
                    continue;
                }
                let o = k * SEG_FLOATS;
                self.out[o..o + 3].copy_from_slice(&na.p);
                self.out[o + 3..o + 6].copy_from_slice(&nb.p);
                self.out[o + 6] = t;
                self.out[o + 7] = 0.9;
                k += 1;
            }
        }
        if act > 0.0 {
            c = mul(c, 1.0 / act);
        }
        for (i, bl) in self.blobs.iter().enumerate() {
            let o = i * 8;
            self.blob_out[o..o + 3].copy_from_slice(&bl.p);
            self.blob_out[o + 3] = bl.a;
            self.blob_out[o + 4] = bl.temp;
            self.blob_out[o + 5] = bl.q.signum();
            self.blob_out[o + 6] = len(bl.v);
        }
        self.info[0] = self.strikes as f32;
        self.info[1] = self.restrikes as f32;
        self.info[2] = act / 2000.0;
        self.info[3] = c[0];
        self.info[4] = c[1];
        self.info[5] = c[2];
        self.info[6] = tmax;
        self.info[7] = self.bolts.len() as f32;
        self.info[8] = self.strike_pos[0];
        self.info[9] = self.strike_pos[1];
        self.info[10] = self.strike_pos[2];
        self.info[11] = self.blobs.len() as f32;
        self.info[12] = self.tip_field;
        self.info[13] = self.fn_j;
        self.info[14] = self.links.len() as f32;
        k as u32
    }
}

// ---------------------------------------------------------------- exports
#[no_mangle]
pub extern "C" fn init(seed: u32) {
    let keep = unsafe { SIM.as_ref().map(|s| (s.p, s.half)) };
    let mut s = Sim::new(seed);
    if let Some((p, h)) = keep {
        s.p = p;
        s.half = h;
    }
    unsafe { SIM = Some(s) }
}
/// Chamber half-extents (m). Contents are rescaled when the window changes shape.
#[no_mangle]
pub extern "C" fn set_box(hx: f32, hy: f32, hz: f32) {
    let s = sim();
    let nh = [hx.max(100.0), hy.max(100.0), hz.max(100.0)];
    if (0..3).any(|i| (nh[i] - s.half[i]).abs() > 0.5) {
        let sc = [nh[0] / s.half[0], nh[1] / s.half[1], nh[2] / s.half[2]];
        for b in s.bolts.iter_mut() {
            for n in b.nodes.iter_mut() {
                for i in 0..3 {
                    n.p[i] *= sc[i];
                }
            }
        }
        for bl in s.blobs.iter_mut() {
            for i in 0..3 {
                bl.p[i] *= sc[i];
            }
        }
        s.half = nh;
        s.fgrid.clear();
    }
}
#[no_mangle]
pub extern "C" fn strike() {
    let s = sim();
    if s.bolts.iter().filter(|b| !b.bridge).count() >= MAX_BOLTS {
        if let Some(i) = s.bolts.iter().position(|b| !b.bridge) {
            s.bolts.remove(i);
        }
    }
    s.spawn_main();
}
#[no_mangle]
pub extern "C" fn set_param(id: u32, v: f32) {
    if (id as usize) < N_PARAMS {
        sim().p[id as usize] = v;
    }
}
#[no_mangle]
pub extern "C" fn step(dt: f32) -> u32 {
    sim().step(dt)
}
#[no_mangle]
pub extern "C" fn seg_ptr() -> *const f32 {
    sim().out.as_ptr()
}
#[no_mangle]
pub extern "C" fn blob_ptr() -> *const f32 {
    sim().blob_out.as_ptr()
}
#[no_mangle]
pub extern "C" fn info_ptr() -> *const f32 {
    sim().info.as_ptr()
}
#[no_mangle]
pub extern "C" fn lut_ptr() -> *const f32 {
    sim().lut.as_ptr()
}
#[no_mangle]
pub extern "C" fn lut_len() -> u32 {
    LUT_N as u32
}
#[no_mangle]
pub extern "C" fn lut_tmin() -> f32 {
    LUT_TMIN
}
#[no_mangle]
pub extern "C" fn lut_tmax() -> f32 {
    LUT_TMAX
}
#[no_mangle]
pub extern "C" fn bb_ptr() -> *const f32 {
    sim().bb_lut.as_ptr()
}
#[no_mangle]
pub extern "C" fn bb_len() -> u32 {
    BB_N as u32
}
#[no_mangle]
pub extern "C" fn bb_tmin() -> f32 {
    BB_TMIN
}
#[no_mangle]
pub extern "C" fn bb_tmax() -> f32 {
    BB_TMAX
}
