//! Lightning Machine — 3-D liquid lightning core (Rust → WebAssembly).
//!
//! Units: metres, seconds, amperes, kelvin.
//!
//! Electrostatics — charge pockets are Plummer-softened (Gaussian-like) point charges;
//!   E(x) = k Σ q (x − x_q) / (|x − x_q|² + a²)^{3/2}.
//! Leader — 3-D stochastic dielectric-breakdown growth: from each tip K candidate
//!   directions are drawn; one is chosen with probability ∝ max(0, d̂·Ê)^η · e^{σN(0,1)}
//!   (continuum form of the Niemeyer–Pietronero–Wiesmann model). Negative leaders
//!   propagate along −E toward positive charge; tips fork stochastically.
//! Return stroke — Heidler current (IEC 62305-1 waveforms), MTLE propagation along the
//!   channel at v = 1.2×10⁸ m/s with λ = 2 km, CIGRE log-normal peak currents,
//!   subsequent strokes, continuing current.
//! Channel temperature — weak power law T = 4000 + 26000·(I/30 kA)^0.12 with exponential
//!   cooling toward the continuing-current equilibrium.
//! Colour — emission spectrum of air plasma: N II, N I, O I, Hα, Hβ lines weighted by
//!   Boltzmann excitation e^{−E_u/kT} and the Saha ionisation balance of nitrogen, plus a
//!   recombination/bremsstrahlung continuum ∝ n_e² ∝ x² times the Planck function;
//!   integrated against the CIE 1931 colour-matching functions → linear sRGB.
//! Fluid — Arnold–Beltrami–Childress flow, an exact incompressible Euler solution
//!   (∇·u = 0), with drifting phases so the strands fold chaotically; RK2 advection,
//!   resampling and a curvature (surface-tension-like) term.

#![allow(static_mut_refs)]

use std::f32::consts::PI;

const LUT_N: usize = 1024;
const LUT_TMIN: f32 = 1500.0;
const LUT_TMAX: f32 = 40000.0;
const SEG_FLOATS: usize = 8;
const MAX_SEGS: usize = 50000;
const MAX_BOLTS: usize = 12;
const NODE_CAP: usize = 2600;
const HALF: f32 = 1000.0; // half size of the simulation box (m)
const STEP: f32 = 24.0; // leader step length (m)

const H_PLANCK: f64 = 6.626_070_15e-34;
const C_LIGHT: f64 = 2.997_924_58e8;
const K_B: f64 = 1.380_649e-23;
const K_B_EV: f64 = 8.617_333e-5;

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
    fn gauss3(&mut self) -> [f32; 3] {
        [self.gauss(), self.gauss(), self.gauss()]
    }
    fn lognormal(&mut self, median: f32, s: f32) -> f32 {
        median * (s * self.gauss()).exp()
    }
}

// ---------------------------------------------------------------- vectors
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

/// Saha equation for nitrogen N ⇌ N⁺ + e⁻ → ionisation fraction x.
fn saha_nitrogen(t: f64) -> f64 {
    let n_tot = 2.5e24; // channel number density after expansion (~0.1 atm)
    let chi = 14.534; // eV
    let g_ratio = 2.0 * 9.0 / 4.0;
    let s = 2.415e21 * t.powf(1.5) * g_ratio * (-chi / (K_B_EV * t)).exp() / n_tot;
    // x² / (1 − x) = s
    (-s + (s * s + 4.0 * s).sqrt()) / 2.0
}

/// Visible emission of lightning channel air plasma at temperature T.
/// Returns (linear sRGB chromaticity with max = 1, luminance Y in arbitrary units).
fn lightning_color(t: f64) -> ([f32; 3], f64) {
    let kt = K_B_EV * t;
    let x_ion = saha_nitrogen(t);
    // (λ nm, upper level energy eV, relative gA·abundance, 1 = ion line / 0 = neutral)
    const LINES: [(f64, f64, f64, u8); 21] = [
        (399.5, 21.60, 0.30, 1), // N II
        (404.1, 23.42, 0.20, 1), // N II
        (444.7, 23.20, 0.30, 1), // N II
        (463.0, 21.16, 0.70, 1), // N II
        (480.3, 23.24, 0.40, 1), // N II
        (500.5, 23.14, 1.00, 1), // N II (the blue-green lightning line)
        (567.9, 20.67, 0.65, 1), // N II
        (594.2, 23.24, 0.30, 1), // N II
        (648.2, 20.41, 0.15, 1), // N II
        (434.9, 25.85, 0.15, 1), // O II
        (441.5, 26.25, 0.15, 1), // O II
        (464.9, 25.66, 0.15, 1), // O II
        (656.3, 12.09, 0.012, 0), // H α (H ≈ 1.5 % of channel atoms, from water vapour)
        (486.1, 12.75, 0.004, 0), // H β
        (434.0, 13.05, 0.002, 0), // H γ
        (746.8, 11.99, 0.60, 0), // N I
        (821.6, 11.84, 0.50, 0), // N I
        (777.4, 10.74, 1.00, 0), // O I
        (844.6, 10.99, 0.50, 0), // O I
        (715.6, 14.46, 0.30, 0), // O I
        (615.8, 12.75, 0.40, 0), // O I
    ];
    let l0 = 3.0e12;
    let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
    for &(lam, eu, g, ion) in LINES.iter() {
        let frac = if ion == 1 { x_ion } else { 1.0 - x_ion };
        let i = l0 * g * frac * (-eu / kt).exp();
        let (cx, cy, cz) = cie_xyz(lam);
        x += i * cx;
        y += i * cy;
        z += i * cz;
    }
    // continuum: free–free + free–bound ∝ n_e n_i ∝ x², spectral shape ~ Planck
    let mut lam = 380.0;
    while lam <= 780.0 {
        let b = planck(lam * 1e-9, t) * 1e-9 * 4.0 * x_ion * x_ion * 1.5;
        let (cx, cy, cz) = cie_xyz(lam);
        x += b * cx;
        y += b * cy;
        z += b * cz;
        lam += 4.0;
    }
    let r = (3.2404542 * x - 1.5371385 * y - 0.4985314 * z).max(0.0);
    let gg = (-0.9692660 * x + 1.8760108 * y + 0.0415560 * z).max(0.0);
    let bb = (0.0556434 * x - 0.2040259 * y + 1.0572252 * z).max(0.0);
    let m = r.max(gg).max(bb).max(1e-300);
    ([(r / m) as f32, (gg / m) as f32, (bb / m) as f32], y)
}

// ---------------------------------------------------------------- model
#[derive(Clone, Copy)]
struct Node {
    p: V3,
    parent: i32,
    jit: V3,
    temp: f32,
    amp: f32,  // fraction of stroke current carried
    dist: f32, // path length from the attachment point (m)
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
    nodes: Vec<Node>,
    tips: Vec<Tip>,
    phase: Phase,
    step_acc: f32,
    age: f32,
    life: f32,
    stroke_t: f32, // simulated time since the current stroke started (s)
    i0: f32,
    tau1: f32,
    tau2: f32,
    eta_h: f32,
    t_peak: f32,
    strokes: u32,
    i_cc: f32,
}

#[derive(Clone, Copy)]
struct Pocket {
    p: V3,
    q: f32, // relative charge (sign matters)
    a: f32, // softening radius (m)
}

const P_BOLTS: usize = 0;
const P_FLOW: usize = 1;
const P_SWIRL: usize = 2;
const P_CRACKLE: usize = 3;
const P_BRANCH: usize = 4;
const P_ETA: usize = 5;
const P_LIFE: usize = 6;
const P_MIC: usize = 7;
const P_TENSION: usize = 8;
const P_RESTRIKE: usize = 9;
const P_IPEAK: usize = 10; // median first-stroke peak current (kA)
const P_ICC: usize = 11; // continuing current (A)
const P_SLOWMO: usize = 12; // simulated seconds per real second during strokes
const P_LEADER_SPEED: usize = 13; // leader steps per real second
const P_POCKETS: usize = 14;
const N_PARAMS: usize = 15;

struct Sim {
    rng: Rng,
    p: [f32; N_PARAMS],
    time: f32,
    phase3: V3,
    bolts: Vec<Bolt>,
    pockets: Vec<Pocket>,
    spawn_t: f32,
    strikes: u32,
    restrikes: u32,
    strike_pos: V3,
    out: Vec<f32>,
    info: [f32; 16],
    lut: Vec<f32>,
    kids: Vec<u16>,
    first_child: Vec<i32>,
}

static mut SIM: Option<Sim> = None;
fn sim() -> &'static mut Sim {
    unsafe { SIM.as_mut().expect("init() first") }
}

fn heidler(t: f32, i0: f32, tau1: f32, tau2: f32, eta: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    let x = (t / tau1).powi(10);
    i0 / eta * x / (1.0 + x) * (-t / tau2).exp()
}

fn t_of_current(i: f32) -> f32 {
    // Weak power law: spectroscopy (Orville 1968) finds peak channel temperatures of
    // ~28–31 kK for strokes of very different current, so T depends only weakly on I.
    if i <= 1.0 {
        return T_AMB;
    }
    (4000.0 + 26000.0 * (i / 30_000.0).powf(0.12)).min(38_000.0)
}

impl Sim {
    fn new(seed: u32) -> Sim {
        let mut p = [0.0; N_PARAMS];
        p[P_BOLTS] = 5.0;
        p[P_FLOW] = 1.0;
        p[P_SWIRL] = 1.0;
        p[P_CRACKLE] = 0.5;
        p[P_BRANCH] = 0.6;
        p[P_ETA] = 3.0;
        p[P_LIFE] = 10.0;
        p[P_TENSION] = 0.3;
        p[P_RESTRIKE] = 1.0;
        p[P_IPEAK] = 31.0;
        p[P_ICC] = 2500.0;
        p[P_SLOWMO] = 0.0005;
        p[P_LEADER_SPEED] = 160.0;
        p[P_POCKETS] = 2.0;
        let mut s = Sim {
            rng: Rng(0x853c49e6748fea9b ^ ((seed as u64) << 21 | seed as u64)),
            p,
            time: 0.0,
            phase3: [0.0; 3],
            bolts: Vec::new(),
            pockets: Vec::new(),
            spawn_t: 0.0,
            strikes: 0,
            restrikes: 0,
            strike_pos: [0.0; 3],
            out: vec![0.0; MAX_SEGS * SEG_FLOATS],
            info: [0.0; 16],
            lut: vec![0.0; LUT_N * 4],
            kids: Vec::new(),
            first_child: Vec::new(),
        };
        let yref = lightning_color(30000.0).1;
        for i in 0..LUT_N {
            let t = LUT_TMIN + (LUT_TMAX - LUT_TMIN) * i as f32 / (LUT_N - 1) as f32;
            let (c, y) = lightning_color(t as f64);
            s.lut[i * 4..i * 4 + 3].copy_from_slice(&c);
            // perceived brightness: Fechner's law (logarithmic) over ~7 decades of luminance,
            // squared to keep strong contrast between the flash and the glowing channel
            let f = (1.0 + (y / yref).max(1e-30).log10() / 7.0).max(0.0);
            s.lut[i * 4 + 3] = (f * f) as f32;
        }
        s
    }

    // ------------------------------------------------------------ fluid (ABC flow)
    fn velocity(&self, x: V3) -> V3 {
        let k = PI / HALF * self.p[P_SWIRL];
        let (a, b, c) = (1.0f32, 0.816_496_6f32, 0.577_350_3f32); // A=1, B=√(2/3), C=√(1/3)
        let ph = self.phase3;
        let (px, py, pz) = (x[0] * k + ph[0], x[1] * k + ph[1], x[2] * k + ph[2]);
        let mut u = [a * pz.sin() + c * py.cos(), b * px.sin() + a * pz.cos(), c * py.sin() + b * px.cos()];
        let speed = 0.10 * HALF * self.p[P_FLOW] * (1.0 + 1.5 * self.p[P_MIC]);
        u = mul(u, speed);
        // soft walls: suppress outward motion near the box faces so strands slide along them
        for i in 0..3 {
            let d = x[i].abs();
            if x[i] * u[i] > 0.0 && d > HALF * 0.8 {
                let s = ((HALF - d) / (HALF * 0.2)).clamp(0.0, 1.0);
                u[i] *= s * s * (3.0 - 2.0 * s);
            }
        }
        u
    }

    // ------------------------------------------------------------ electrostatics
    fn efield(&self, x: V3) -> V3 {
        let mut e = [0.0f32; 3];
        for pk in self.pockets.iter() {
            let d = sub(x, pk.p);
            let r2 = dot(d, d) + pk.a * pk.a;
            let k = pk.q / (r2 * r2.sqrt());
            e = add(e, mul(d, k));
        }
        e
    }

    /// Thundercloud tripole: main negative layer in the middle, upper positive layer,
    /// weaker lower positive charge region (LPCR). Each "set" adds one of each.
    fn layer_y(kind: usize) -> f32 {
        match kind {
            0 => -0.05 * HALF, // main negative
            1 => 0.70 * HALF,  // upper positive
            _ => -0.72 * HALF, // lower positive
        }
    }
    fn ensure_pockets(&mut self) {
        let n = (self.p[P_POCKETS] as usize).clamp(1, 6);
        while self.pockets.len() < 3 * n {
            let kind = self.pockets.len() % 3;
            let p = [self.rng.range(-0.75, 0.75) * HALF, Sim::layer_y(kind) + self.rng.gauss() * 0.08 * HALF, self.rng.range(-0.75, 0.75) * HALF];
            let (q, a) = match kind {
                0 => (-1.0, self.rng.range(140.0, 220.0)),
                1 => (1.0, self.rng.range(160.0, 240.0)),
                _ => (0.45, self.rng.range(90.0, 140.0)),
            };
            self.pockets.push(Pocket { p, q: q * self.rng.range(0.8, 1.2) * 1e6, a });
        }
        self.pockets.truncate(3 * n);
    }

    fn move_pockets(&mut self, dt: f32) {
        for i in 0..self.pockets.len() {
            let v = self.velocity(self.pockets[i].p);
            let wander = mul(self.rng.gauss3(), 30.0 * dt.sqrt());
            let ly = Sim::layer_y(i % 3);
            let pk = &mut self.pockets[i];
            // charge regions drift horizontally with the air; gravity-driven charge
            // separation keeps each layer at its height
            pk.p = add(add(pk.p, mul([v[0], v[1] * 0.2, v[2]], dt * 0.5)), wander);
            pk.p[1] += (ly - pk.p[1]) * (dt * 0.5).min(1.0);
            for j in 0..3 {
                pk.p[j] = pk.p[j].clamp(-0.85 * HALF, 0.85 * HALF);
            }
        }
    }

    // ------------------------------------------------------------ bolts
    fn spawn_bolt(&mut self) {
        if self.bolts.len() >= MAX_BOLTS || self.pockets.len() < 2 {
            return;
        }
        // pick a negative pocket and the nearest positive pocket
        let negs: Vec<usize> = (0..self.pockets.len()).filter(|&i| self.pockets[i].q < 0.0).collect();
        let src = negs[(self.rng.f() * negs.len() as f32) as usize % negs.len()];
        // target: a positive pocket chosen with probability ∝ distance (long channels)
        let mut dst = usize::MAX;
        let mut wsum = 0.0;
        let mut ws = Vec::new();
        for (i, pk) in self.pockets.iter().enumerate() {
            if pk.q > 0.0 {
                let d = len(sub(pk.p, self.pockets[src].p));
                let w = d * d;
                ws.push((i, w));
                wsum += w;
            }
        }
        let mut r = self.rng.f() * wsum;
        for &(i, w) in ws.iter() {
            dst = i;
            r -= w;
            if r <= 0.0 {
                break;
            }
        }
        if dst == usize::MAX {
            return;
        }
        let start = add(self.pockets[src].p, mul(self.rng.gauss3(), self.pockets[src].a * 0.4));
        let dir = norm(sub(self.pockets[dst].p, start));
        let root = Node { p: start, parent: -1, jit: [0.0; 3], temp: 16000.0, amp: 0.0, dist: 0.0, depth: 0, main: false, alive: true };
        let life = self.p[P_LIFE] * self.rng.range(0.7, 1.3);
        self.bolts.push(Bolt {
            nodes: vec![root],
            tips: vec![Tip { node: 0, dir, steps: 0, depth: 0 }],
            phase: Phase::Leader,
            step_acc: 0.0,
            age: 0.0,
            life,
            stroke_t: 0.0,
            i0: 0.0,
            tau1: 1.82e-6,
            tau2: 285e-6,
            eta_h: 0.986,
            t_peak: 3.5e-6,
            strokes: 0,
            i_cc: 0.0,
        });
    }

    /// One stepped-leader step for every active tip (3-D stochastic DBM).
    fn leader_step(&mut self, b: &mut Bolt) {
        let eta = self.p[P_ETA];
        let branch = self.p[P_BRANCH];
        let mut new_tips = Vec::new();
        let mut connected: Option<usize> = None;
        let tips = std::mem::take(&mut b.tips);
        for tip in tips.into_iter() {
            if b.nodes.len() >= NODE_CAP / 2 {
                break;
            }
            let p = b.nodes[tip.node].p;
            // negative leader advances along −E (toward positive charge)
            let e = mul(self.efield(p), -1.0);
            let ehat = norm(e);
            const K: usize = 10;
            let mut cand = [[0.0f32; 3]; K];
            let mut w = [0.0f32; K];
            let mut wsum = 0.0;
            for k in 0..K {
                let d = norm(add(add(mul(tip.dir, 1.0), mul(ehat, 0.6)), mul(self.rng.gauss3(), 0.75)));
                let c = dot(d, ehat).max(0.02);
                let wk = c.powf(eta) * (0.5 * self.rng.gauss()).exp();
                cand[k] = d;
                w[k] = wk;
                wsum += wk;
            }
            let mut r = self.rng.f() * wsum;
            let mut pick = K - 1;
            for k in 0..K {
                r -= w[k];
                if r <= 0.0 {
                    pick = k;
                    break;
                }
            }
            let d = cand[pick];
            let l = STEP * self.rng.range(0.7, 1.3);
            let q = add(p, mul(d, l));
            let depth = tip.depth;
            b.nodes.push(Node { p: q, parent: tip.node as i32, jit: mul(self.rng.gauss3(), 0.3), temp: 20000.0, amp: 0.0, dist: 0.0, depth, main: false, alive: true });
            let ni = b.nodes.len() - 1;
            // attachment: the leader reaches any positive charge region
            if self.pockets.iter().any(|pk| pk.q > 0.0 && len(sub(q, pk.p)) < pk.a * 0.9) {
                connected = Some(ni);
                break;
            }
            let outside = q.iter().any(|v| v.abs() > HALF * 1.05);
            if outside || tip.steps > 400 {
                continue; // tip dies
            }
            new_tips.push(Tip { node: ni, dir: d, steps: tip.steps + 1, depth });
            // stochastic fork: the new branch is one order higher (thinner, less current)
            if depth < 4 && self.rng.f() < branch * 0.06 {
                let bd = norm(add(d, mul(self.rng.gauss3(), 0.9)));
                new_tips.push(Tip { node: ni, dir: bd, steps: tip.steps + 1, depth: depth + 1 });
            }
        }
        if let Some(att) = connected {
            self.connect(b, att);
        } else {
            b.tips = new_tips;
            if b.tips.is_empty() {
                b.phase = Phase::Fizzle; // leader died in the air: no return stroke
                b.life = b.age + 0.6;
            }
        }
    }

    fn connect(&mut self, b: &mut Bolt, att: usize) {
        b.tips.clear();
        b.phase = Phase::Connected;
        // main channel = path from the attachment point back to the root
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
        // side branches: walk the tree outward from the root (breadth-first) so every
        // parent is processed before its children; branch current decays along the branch
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
        if first {
            // CIGRE: first negative stroke median 31 kA, σ_ln 0.48; IEC 1/200 µs
            b.i0 = self.rng.lognormal(self.p[P_IPEAK], 0.48) * 1e3;
            b.tau1 = 1.82e-6;
            b.tau2 = 285e-6;
            b.eta_h = 0.986;
            self.strikes += 1;
        } else {
            // subsequent: median 12 kA, σ_ln 0.53; IEC 0.25/100 µs
            b.i0 = self.rng.lognormal(self.p[P_IPEAK] * 12.0 / 31.0, 0.53) * 1e3;
            b.tau1 = 0.454e-6;
            b.tau2 = 143e-6;
            b.eta_h = 0.993;
            self.restrikes += 1;
        }
        b.t_peak = b.tau1 * (10.0 * b.tau2 / b.tau1).powf(1.0 / 11.0);
        b.stroke_t = 0.0;
        b.strokes += 1;
    }

    fn update_bolt(&mut self, b: &mut Bolt, dt: f32) {
        b.age += dt;
        let ou_k = (-dt / 0.08f32).exp();
        let ou_s = (1.0 - ou_k * ou_k).sqrt() * 0.45;
        // --- liquid motion (RK2 through the ABC flow)
        for nd in b.nodes.iter_mut() {
            if !nd.alive {
                continue;
            }
            let v1 = self.velocity(nd.p);
            let v2 = self.velocity(add(nd.p, mul(v1, dt * 0.5)));
            nd.p = add(nd.p, mul(v2, dt));
            for j in 0..3 {
                nd.jit[j] = nd.jit[j] * ou_k + ou_s * self.rng.gauss();
            }
        }
        // --- leader growth
        if b.phase == Phase::Leader {
            b.step_acc += dt * self.p[P_LEADER_SPEED] * (1.0 + 2.0 * self.p[P_MIC]);
            let mut n = 0;
            while b.step_acc >= 1.0 && b.phase == Phase::Leader && n < 12 {
                b.step_acc -= 1.0;
                n += 1;
                self.leader_step(b);
            }
        }
        // --- electrical state → temperature
        let sim_dt = dt * self.p[P_SLOWMO];
        match b.phase {
            Phase::Leader | Phase::Fizzle => {
                // leader channel: hot stepping tips, faint channel behind
                let k = (-dt / 0.06f32).exp();
                for nd in b.nodes.iter_mut() {
                    nd.temp = 4200.0 + (nd.temp - 4200.0) * k;
                    if b.phase == Phase::Fizzle {
                        nd.temp *= (-dt / 0.25f32).exp();
                    }
                }
            }
            Phase::Connected => {
                // restrikes (dart leader + subsequent return stroke)
                let rate = self.p[P_RESTRIKE] * (1.0 + 3.0 * self.p[P_MIC]);
                if b.stroke_t > 400e-6 && self.rng.f() < rate * dt && b.age < b.life * 0.8 {
                    self.begin_stroke(b, false);
                }
                let t0 = b.stroke_t;
                let t1 = t0 + sim_dt;
                b.stroke_t = t1;
                // continuing current decays over the bolt's life
                let lf = (1.0 - b.age / b.life).clamp(0.0, 1.0);
                b.i_cc = self.p[P_ICC] * lf.powf(1.5);
                let tau_cool = 80e-6;
                let kc = (-sim_dt / tau_cool).exp();
                for nd in b.nodes.iter_mut() {
                    if !nd.alive {
                        continue;
                    }
                    let mut i = 0.0;
                    if nd.amp > 0.0 {
                        // MTLE: i(z,t) = i(0, t − z/v)·e^{−z/λ}; max over the frame window
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
        // surface tension
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
        // prune cold dead-end branches (they stop conducting and fade)
        for i in 0..n {
            let nd = b.nodes[i];
            if nd.alive && !nd.main && self.kids[i] == 0 && nd.temp < 1200.0 && b.phase != Phase::Leader && !tip_nodes.contains(&i) {
                b.nodes[i].alive = false;
            }
        }
        // split stretched links / merge compressed ones
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
            b.life = b.age + 1.5; // over-stretched: let it cool down and go
        }
        // compact
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
        }
    }

    fn step(&mut self, dt: f32) -> u32 {
        let dt = dt.clamp(0.0, 0.05);
        self.time += dt;
        self.strikes = 0;
        self.restrikes = 0;
        // ABC phases drift → time-dependent chaotic folding
        let fl = self.p[P_FLOW];
        self.phase3[0] += dt * 0.11 * fl;
        self.phase3[1] -= dt * 0.07 * fl;
        self.phase3[2] += dt * 0.05 * fl;
        self.ensure_pockets();
        self.move_pockets(dt);
        let want = (self.p[P_BOLTS] as usize).clamp(0, MAX_BOLTS);
        self.spawn_t -= dt;
        if self.bolts.len() < want && self.spawn_t <= 0.0 {
            self.spawn_bolt();
            self.spawn_t = self.rng.range(0.2, 0.8) / (1.0 + 2.0 * self.p[P_MIC]);
        }
        let mut bolts = std::mem::take(&mut self.bolts);
        for b in bolts.iter_mut() {
            self.update_bolt(b, dt);
        }
        bolts.retain(|b| b.age < b.life);
        self.bolts = bolts;
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
            let jp = |nd: &Node| add(nd.p, mul(nd.jit, STEP * crackle));
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
                let a = jp(par);
                let e = jp(nd);
                let w = if nd.main { 1.0 } else { 0.6f32.powi(nd.depth.max(1) as i32) };
                let o = k * SEG_FLOATS;
                let out = &mut self.out[o..o + SEG_FLOATS];
                out[0] = a[0];
                out[1] = a[1];
                out[2] = a[2];
                out[3] = e[0];
                out[4] = e[1];
                out[5] = e[2];
                out[6] = t;
                out[7] = if has_child[i] { w } else { -w };
                let li = (((t - LUT_TMIN) / (LUT_TMAX - LUT_TMIN)) * (LUT_N - 1) as f32) as usize;
                let lum = self.lut[li.min(LUT_N - 1) * 4 + 3] * w * STEP;
                act += lum;
                c = add(c, mul(e, lum));
                tmax = tmax.max(t);
                k += 1;
            }
        }
        if act > 0.0 {
            c = mul(c, 1.0 / act);
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
        self.info[11] = HALF;
        k as u32
    }
}

// ---------------------------------------------------------------- exports
#[no_mangle]
pub extern "C" fn init(seed: u32) {
    let keep = unsafe { SIM.as_ref().map(|s| s.p) };
    let mut s = Sim::new(seed);
    if let Some(p) = keep {
        s.p = p;
    }
    unsafe { SIM = Some(s) }
}
#[no_mangle]
pub extern "C" fn strike() {
    let s = sim();
    if s.bolts.len() >= MAX_BOLTS {
        s.bolts.remove(0);
    }
    s.spawn_bolt();
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
pub extern "C" fn info_ptr() -> *const f32 {
    sim().info.as_ptr()
}
/// LUT: LUT_N × [r, g, b (chromaticity, max 1), perceived brightness (1 at 30 000 K)]
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
