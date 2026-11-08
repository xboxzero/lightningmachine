//! Lightning Machine — physics core (Rust → WebAssembly).
//!
//! Models implemented (all in SI units unless stated):
//!  * Electrostatics: Poisson equation ∇²φ = -ρ/ε₀ on a 3-D lattice solved with
//!    red-black successive over-relaxation (SOR). The cloud base carries a Gaussian
//!    potential profile, the ground is φ = 0, a lower positive charge region is a
//!    Gaussian space-charge source term, the leader channel is an equipotential conductor.
//!  * Stepped leader growth: Dielectric Breakdown Model (Niemeyer–Pietronero–Wiesmann 1984),
//!    P(i) ∝ |∇φ|^η, with log-normal (Gaussian in log space) space-charge fluctuations.
//!  * Quantum tunnelling: Fowler–Nordheim field emission with Murphy–Good barrier
//!    functions (Forbes 2006 approximation). The WKB transmission coefficient of the
//!    triangular/image-rounded barrier weights each candidate breakdown site (Born rule
//!    sampling of |ψ|² ∝ T_WKB) and the emitted current density sets the stepping rate.
//!  * Return stroke: Heidler current function (IEC 62305-1 parameters) propagated with
//!    the MTLE engineering model (Nucci/Rachidi), peak currents drawn from the CIGRE
//!    log-normal distributions, multiple strokes, dart leaders and continuing current.
//!  * Channel temperature: Joule heating, T ∝ √I (so radiance σT⁴ ∝ I²), Newtonian cooling.
//!  * Colour: Planck's law integrated against the CIE 1931 2° colour-matching functions
//!    (Wyman–Sloan–Shirley multi-lobe Gaussian fit) → XYZ → linear sRGB (D65).
//!  * Thunder: Few's blast-wave theory (relaxation radius R₀ = √(E_l/πp₀), N-wave of
//!    fundamental f = 0.63 c/R₀), weak-shock lengthening, finite line-source directivity
//!    (sinc array factor), 1/r spreading, ground image source, VBAP surround panning
//!    and Woodworth interaural time differences.

#![allow(static_mut_refs)]
#![allow(clippy::missing_safety_doc)]

use std::f32::consts::PI;

const MAX_NODES: usize = 16000;
const SEG_FLOATS: usize = 8;
const LUT_N: usize = 512;
pub const LUT_TMIN: f32 = 800.0;
pub const LUT_TMAX: f32 = 40000.0;

// Physical constants
const H_PLANCK: f64 = 6.626_070_15e-34;
const C_LIGHT: f64 = 2.997_924_58e8;
const K_B: f64 = 1.380_649e-23;
const C_SOUND: f32 = 343.0;
const P_ATM: f32 = 101_325.0;
// Fowler–Nordheim constants (Forbes)
const FN_A: f32 = 1.541_434e-6; // A eV V^-2
const FN_B: f32 = 6.830_890e9; // eV^-3/2 V m^-1
const FN_C: f32 = 1.439_965e-9; // eV² V^-1 m

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
    /// Standard normal via Box–Muller.
    fn gauss(&mut self) -> f32 {
        let u1 = self.f().max(1e-7);
        let u2 = self.f();
        (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos()
    }
    fn lognormal(&mut self, median: f32, sigma_ln: f32) -> f32 {
        median * (sigma_ln * self.gauss()).exp()
    }
    fn exponential(&mut self, mean: f32) -> f32 {
        -mean * (1.0 - self.f()).max(1e-7).ln()
    }
}

#[derive(Clone, Copy, Default)]
struct Node {
    cell: u32,
    parent: i32,
    pos: [f32; 3], // grid units, Gaussian-jittered
    mid: [f32; 3], // Gaussian midpoint displacement towards parent
    temp: f32,     // K
    amp: f32,      // fraction of return-stroke current carried
    dist: f32,     // path length (m) from ground attachment along the channel
    bdist: f32,    // length (m) along the side branch
    main: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle = 0,
    Leader = 1,
    Return = 2,
    Inter = 3,
    Dart = 4,
    Fade = 5,
}

/// Tunable parameters (indices are the `set_param` ids used by JS).
const P_ETA: usize = 0;
const P_QUANTUM: usize = 1;
const P_BETA_LOG: usize = 2;
const P_WORKFN: usize = 3;
const P_NOISE: usize = 4;
const P_IPEAK: usize = 5;
const P_LEADER_SLOWMO: usize = 6;
const P_STROKE_SLOWMO: usize = 7;
const P_ACTIVITY: usize = 8;
const P_V0_MV: usize = 9;
const P_TOWER: usize = 10;
const P_MIC_LEVEL: usize = 11;
const P_MIC_PITCH: usize = 12;
const P_MIC_STEER: usize = 13;
const P_SWEEPS: usize = 14;
const P_AUTO: usize = 15;
const P_AFTERGLOW_MS: usize = 16;
const P_STROKES_MEAN: usize = 17;
const P_WIND: usize = 18; // mean wind at 1 km height (m/s, visual drift of the channel)
const P_GUST: usize = 19; // rms turbulent gusts (m/s)
const N_PARAMS: usize = 20;

struct Sim {
    nx: usize,
    ny: usize,
    nz: usize,
    dx: f32, // metres per cell
    phi: Vec<f32>,
    mask: Vec<u8>, // 0 free, 1 channel (cloud potential), 2 grounded conductor
    src: Vec<f32>, // Poisson source h²ρ/ε₀ (normalised)
    stamp: Vec<u32>,
    stamp_id: u32,
    top: Vec<f32>, // cloud-base potential profile (nx*nz)
    nodes: Vec<Node>,
    cand_cell: Vec<u32>,
    cand_par: Vec<u32>,
    cand_logw: Vec<f32>,
    cand_field: Vec<f32>,
    rng: Rng,
    p: [f32; N_PARAMS],
    phase: Phase,
    t: f32,       // phase-local simulated time (s)
    timer: f32,   // real seconds until the next automatic flash
    step_acc: f32,
    ground_node: i32,
    stroke: u32,
    n_strokes: u32,
    i0: f32,      // current stroke peak (A)
    tau1: f32,
    tau2: f32,
    eta_h: f32,
    t_peak: f32,
    inter_dur: f32,
    cc_amp: f32,  // continuing current (A)
    cc_dur: f32,
    dart_front: f32,
    main_len: f32,
    // diagnostics
    tip_field: f32,
    fn_j: f32,
    tip_h: f32,
    low_h: f32,
    storm_cx: f32,
    storm_cz: f32,
    tower: [f32; 3], // x, z (cells), height (cells); h=0 → none
    // outputs
    segs: Vec<f32>,
    has_child: Vec<bool>,
    light: [f32; 8],
    stats: [f32; 24],
    lut: Vec<f32>,
    // thunder
    listener: [f32; 5], // x,y,z (m), forward x,z
    thunder_pending: u32,
    thunder_i0: f32,
    thunder: Vec<f32>,
    thunder_offset: f32,
    snap: Vec<f32>, // emitter snapshot: [ax,ay,az,bx,by,bz,amp,dist] (metres)
    flash_id: u32,
    gusts: Vec<[f32; 10]>, // turbulence modes: k(3), a(3), b(3), ω
    wind_t: f32,
}

static mut SIM: Option<Sim> = None;

fn sim() -> &'static mut Sim {
    unsafe { SIM.as_mut().expect("init() first") }
}

// ---------------------------------------------------------------- colour science
/// CIE 1931 2° colour matching functions, multi-lobe Gaussian fit
/// (Wyman, Sloan & Shirley, JCGT 2013). λ in nm.
fn cie_xyz(l: f64) -> (f64, f64, f64) {
    fn g(x: f64, mu: f64, s1: f64, s2: f64) -> f64 {
        let t = (x - mu) / if x < mu { s1 } else { s2 };
        (-0.5 * t * t).exp()
    }
    let x = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7)
        - 0.065 * g(l, 501.1, 20.4, 26.2);
    let y = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
    let z = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
    (x, y, z)
}

/// Planck spectral radiance B(λ,T) [W·sr⁻¹·m⁻³].
fn planck(lambda_m: f64, t: f64) -> f64 {
    let a = 2.0 * H_PLANCK * C_LIGHT * C_LIGHT / lambda_m.powi(5);
    let e = H_PLANCK * C_LIGHT / (lambda_m * K_B * t);
    a / (e.exp_m1())
}

/// Linear-sRGB chromaticity of a black body at temperature T (max component = 1).
fn blackbody_rgb(t: f64) -> [f32; 3] {
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
    // XYZ → linear sRGB (IEC 61966-2-1, D65)
    let r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    let g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
    let bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
    let (r, g, bl) = (r.max(0.0), g.max(0.0), bl.max(0.0));
    let m = r.max(g).max(bl).max(1e-30);
    [(r / m) as f32, (g / m) as f32, (bl / m) as f32]
}

// ---------------------------------------------------------------- tunnelling
/// Fowler–Nordheim with Murphy–Good barrier functions (Forbes 2006).
/// Returns (ln T_WKB, J [A/m²]) for local field F [V/m] and work function φ [eV].
fn fowler_nordheim(f_field: f32, phi_w: f32) -> (f32, f32) {
    let f_field = f_field.max(1.0);
    let f = (FN_C * f_field / (phi_w * phi_w)).clamp(1e-6, 1.0); // scaled barrier field
    let v = 1.0 - f + (f / 6.0) * f.ln();
    let tf = 1.0 + f / 9.0 - (f / 18.0) * f.ln();
    let ln_t = -v * FN_B * phi_w.powf(1.5) / f_field;
    let j = FN_A / (phi_w * tf * tf) * f_field * f_field * ln_t.exp();
    (ln_t, j)
}

// ---------------------------------------------------------------- return stroke
fn heidler(t: f32, i0: f32, tau1: f32, tau2: f32, eta: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    let x = (t / tau1).powi(10);
    i0 / eta * x / (1.0 + x) * (-t / tau2).exp()
}

const V_RS: f32 = 1.2e8; // return stroke speed (m/s), ~0.4c
const LAMBDA_MTLE: f32 = 2000.0; // MTLE current decay height (m)
const V_DART: f32 = 1.5e7;

impl Sim {
    fn new(nx: usize, ny: usize, nz: usize, seed: u32) -> Sim {
        let n = nx * ny * nz;
        let mut p = [0.0f32; N_PARAMS];
        p[P_ETA] = 3.0;
        p[P_QUANTUM] = 0.08;
        p[P_BETA_LOG] = 4.3;
        p[P_WORKFN] = 4.5;
        p[P_NOISE] = 0.55;
        p[P_IPEAK] = 31.0;
        p[P_LEADER_SLOWMO] = 0.004;
        p[P_STROKE_SLOWMO] = 0.25;
        p[P_ACTIVITY] = 8.0;
        p[P_V0_MV] = 50.0;
        p[P_TOWER] = 1.0;
        p[P_MIC_STEER] = 1.0;
        p[P_SWEEPS] = 6.0;
        p[P_AUTO] = 1.0;
        p[P_AFTERGLOW_MS] = 25.0;
        p[P_STROKES_MEAN] = 3.5;
        p[P_WIND] = 25.0;
        p[P_GUST] = 18.0;
        let mut s = Sim {
            nx,
            ny,
            nz,
            dx: 3000.0 / ny as f32,
            phi: vec![0.0; n],
            mask: vec![0; n],
            src: vec![0.0; n],
            stamp: vec![0; n],
            stamp_id: 1,
            top: vec![0.0; nx * nz],
            nodes: Vec::with_capacity(MAX_NODES),
            cand_cell: Vec::new(),
            cand_par: Vec::new(),
            cand_logw: Vec::new(),
            cand_field: Vec::new(),
            rng: Rng(0x853c49e6748fea9b ^ ((seed as u64) << 17 | seed as u64)),
            p,
            phase: Phase::Idle,
            t: 0.0,
            timer: 0.6,
            step_acc: 0.0,
            ground_node: -1,
            stroke: 0,
            n_strokes: 1,
            i0: 0.0,
            tau1: 1.82e-6,
            tau2: 285e-6,
            eta_h: 0.986,
            t_peak: 3.5e-6,
            inter_dur: 0.04,
            cc_amp: 0.0,
            cc_dur: 0.0,
            dart_front: 0.0,
            main_len: 0.0,
            tip_field: 0.0,
            fn_j: 0.0,
            tip_h: 0.0,
            low_h: 3000.0,
            storm_cx: nx as f32 * 0.5,
            storm_cz: nz as f32 * 0.5,
            tower: [0.0; 3],
            segs: vec![0.0; MAX_NODES * 2 * SEG_FLOATS],
            has_child: Vec::new(),
            light: [0.0; 8],
            stats: [0.0; 24],
            lut: vec![0.0; LUT_N * 3],
            listener: [0.0, 300.0, 4500.0, 0.0, -1.0],
            thunder_pending: 0,
            thunder_i0: 0.0,
            thunder: Vec::new(),
            thunder_offset: 0.0,
            snap: Vec::new(),
            flash_id: 0,
            gusts: Vec::new(),
            wind_t: 0.0,
        };
        for i in 0..LUT_N {
            let t = LUT_TMIN + (LUT_TMAX - LUT_TMIN) * i as f32 / (LUT_N - 1) as f32;
            let c = blackbody_rgb(t as f64);
            s.lut[i * 3..i * 3 + 3].copy_from_slice(&c);
        }
        s
    }

    #[inline]
    fn idx(&self, x: usize, y: usize, z: usize) -> usize {
        x + self.nx * (y + self.ny * z)
    }
    #[inline]
    fn coords(&self, i: usize) -> (usize, usize, usize) {
        (i % self.nx, (i / self.nx) % self.ny, i / (self.nx * self.ny))
    }

    fn world(&self, g: [f32; 3]) -> [f32; 3] {
        [
            (g[0] - self.nx as f32 * 0.5) * self.dx,
            g[1] * self.dx,
            (g[2] - self.nz as f32 * 0.5) * self.dx,
        ]
    }

    // ------------------------------------------------------------ electrostatics
    fn setup_field(&mut self) {
        let (nx, ny, nz) = (self.nx, self.ny, self.nz);
        self.mask.iter_mut().for_each(|m| *m = 0);
        self.src.iter_mut().for_each(|m| *m = 0.0);
        // Cloud base: Gaussian charge-centre potential profile.
        let sig = nx as f32 * 0.32;
        for z in 0..nz {
            for x in 0..nx {
                let dxs = x as f32 - self.storm_cx;
                let dzs = z as f32 - self.storm_cz;
                self.top[x + nx * z] =
                    0.30 + 0.70 * (-(dxs * dxs + dzs * dzs) / (2.0 * sig * sig)).exp();
            }
        }
        // Lower positive charge region: Gaussian space charge under the charge centre.
        let (lx, ly, lz) = (
            self.storm_cx + self.rng.gauss() * 3.0,
            ny as f32 * 0.80,
            self.storm_cz + self.rng.gauss() * 3.0,
        );
        let ls = nx as f32 * 0.08;
        let q = -0.004; // sign: positive charge lowers the potential of the negative leader's surroundings
        for z in 1..nz - 1 {
            for y in 1..ny - 1 {
                for x in 1..nx - 1 {
                    let r2 = (x as f32 - lx).powi(2) + (y as f32 - ly).powi(2) + (z as f32 - lz).powi(2);
                    let i = self.idx(x, y, z);
                    self.src[i] = q * (-r2 / (2.0 * ls * ls)).exp();
                }
            }
        }
        // Initial guess: linear between ground (0) and cloud base.
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let i = self.idx(x, y, z);
                    self.phi[i] = self.top[x + nx * z] * y as f32 / (ny - 1) as f32;
                }
            }
        }
        // Grounded tower.
        self.tower = [0.0; 3];
        if self.p[P_TOWER] > 0.5 {
            let tx = (self.storm_cx + (self.rng.f() - 0.5) * nx as f32 * 0.5).clamp(4.0, nx as f32 - 5.0) as usize;
            let tz = (self.storm_cz + (self.rng.f() - 0.5) * nz as f32 * 0.5).clamp(4.0, nz as f32 - 5.0) as usize;
            let th = ((300.0 / self.dx) as usize).max(3);
            for y in 1..=th {
                let i = self.idx(tx, y, tz);
                self.mask[i] = 2;
                self.phi[i] = 0.0;
            }
            self.tower = [tx as f32, tz as f32, th as f32];
        }
        self.sor(40, 1.9, None);
    }

    /// Red-black SOR for ∇²φ = -src. `bbox` restricts to a sub-box (local relaxation).
    fn sor(&mut self, sweeps: usize, omega: f32, bbox: Option<[usize; 6]>) {
        let (nx, ny, nz) = (self.nx, self.ny, self.nz);
        let sy = nx;
        let sz = nx * ny;
        let [x0, x1, y0, y1, z0, z1] = bbox.unwrap_or([1, nx - 1, 1, ny - 1, 1, nz - 1]);
        let phi = self.phi.as_mut_ptr();
        let mask = &self.mask;
        let src = &self.src;
        for _ in 0..sweeps {
            for color in 0..2usize {
                for z in z0..z1 {
                    for y in y0..y1 {
                        let row = sy * y + sz * z;
                        let mut x = x0 + ((x0 + y + z + color) & 1);
                        while x < x1 {
                            let i = row + x;
                            unsafe {
                                if *mask.get_unchecked(i) == 0 {
                                    let s = *phi.add(i - 1)
                                        + *phi.add(i + 1)
                                        + *phi.add(i - sy)
                                        + *phi.add(i + sy)
                                        + *phi.add(i - sz)
                                        + *phi.add(i + sz);
                                    let gs = (s + *src.get_unchecked(i)) * (1.0 / 6.0);
                                    let old = *phi.add(i);
                                    *phi.add(i) = old + omega * (gs - old);
                                }
                            }
                            x += 2;
                        }
                    }
                }
            }
            if bbox.is_none() {
                // Neumann (zero normal field) side walls; Dirichlet ground & cloud base.
                for z in 0..nz {
                    for y in 1..ny - 1 {
                        let r = sy * y + sz * z;
                        unsafe {
                            *phi.add(r) = *phi.add(r + 1);
                            *phi.add(r + nx - 1) = *phi.add(r + nx - 2);
                        }
                    }
                }
                for y in 1..ny - 1 {
                    for x in 0..nx {
                        let a = x + sy * y;
                        let b = x + sy * y + sz * (nz - 1);
                        unsafe {
                            *phi.add(a) = *phi.add(a + sz);
                            *phi.add(b) = *phi.add(b - sz);
                        }
                    }
                }
                for z in 0..nz {
                    for x in 0..nx {
                        unsafe {
                            *phi.add(x + sz * z) = 0.0;
                            *phi.add(x + sy * (ny - 1) + sz * z) = self.top[x + nx * z];
                        }
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------ flash lifecycle
    fn start_flash(&mut self) {
        self.flash_id += 1;
        self.nodes.clear();
        let nx = self.nx as f32;
        let nz = self.nz as f32;
        self.storm_cx = (nx * 0.5 + self.rng.gauss() * nx * 0.12).clamp(6.0, nx - 7.0);
        self.storm_cz = (nz * 0.5 + self.rng.gauss() * nz * 0.12).clamp(6.0, nz - 7.0);
        self.setup_field();
        let rx = self.storm_cx as usize;
        let rz = self.storm_cz as usize;
        let ry = self.ny - 2;
        let c = self.idx(rx, ry, rz);
        self.mask[c] = 1;
        self.phi[c] = 1.0;
        self.nodes.push(Node {
            cell: c as u32,
            parent: -1,
            pos: [rx as f32 + 0.5, ry as f32 + 0.5, rz as f32 + 0.5],
            mid: [rx as f32 + 0.5, ry as f32 + 0.5, rz as f32 + 0.5],
            temp: 9000.0,
            ..Default::default()
        });
        self.sor(4, 1.85, None);
        self.phase = Phase::Leader;
        self.low_h = self.ny as f32 * self.dx;
        self.t = 0.0;
        self.step_acc = 0.0;
        self.ground_node = -1;
        self.stroke = 0;
        // Number of strokes per flash: 1 + Poisson(mean-1)
        let lam = (self.p[P_STROKES_MEAN] - 1.0).max(0.0);
        let mut k = 0u32;
        let l = (-lam).exp();
        let mut pp = 1.0f32;
        loop {
            pp *= self.rng.f();
            if pp <= l || k > 12 {
                break;
            }
            k += 1;
        }
        self.n_strokes = 1 + k;
    }

    /// One DBM growth step; returns true on ground attachment.
    fn grow_once(&mut self, eta: f32, steer: [f32; 2], steer_k: f32) -> bool {
        let (nx, ny, nz) = (self.nx, self.ny, self.nz);
        self.stamp_id = self.stamp_id.wrapping_add(1).max(1);
        let sid = self.stamp_id;
        self.cand_cell.clear();
        self.cand_par.clear();
        self.cand_field.clear();
        self.cand_logw.clear();
        let v0 = self.p[P_V0_MV] * 1e6;
        let beta = 10f32.powf(self.p[P_BETA_LOG]);
        let phi_w = self.p[P_WORKFN];
        let q = self.p[P_QUANTUM];
        let sigma = self.p[P_NOISE];
        let mut best_f = 0.0f32;
        for ni in 0..self.nodes.len() {
            let cell = self.nodes[ni].cell;
            if cell == u32::MAX {
                continue;
            }
            let (x, y, z) = self.coords(cell as usize);
            for dz in -1i32..=1 {
                for dy in -1i32..=1 {
                    for dxx in -1i32..=1 {
                        if dxx == 0 && dy == 0 && dz == 0 {
                            continue;
                        }
                        let cx = x as i32 + dxx;
                        let cy = y as i32 + dy;
                        let cz = z as i32 + dz;
                        if cx < 1 || cy < 1 || cz < 1 || cx > nx as i32 - 2 || cy > ny as i32 - 2 || cz > nz as i32 - 2 {
                            continue;
                        }
                        let ci = cx as usize + nx * (cy as usize + ny * cz as usize);
                        if self.mask[ci] != 0 || self.stamp[ci] == sid {
                            continue;
                        }
                        self.stamp[ci] = sid;
                        let d = ((dxx * dxx + dy * dy + dz * dz) as f32).sqrt();
                        let e = ((1.0 - self.phi[ci]) / d).max(1e-6); // normalised |∇φ|
                        self.cand_cell.push(ci as u32);
                        self.cand_par.push(ni as u32);
                        self.cand_field.push(e);
                        best_f = best_f.max(e);
                        let dir = [dxx as f32 / d, dy as f32 / d, dz as f32 / d];
                        // log-weight = DBM term + WKB tunnelling + Gaussian space-charge noise + steering field
                        let f_local = e * v0 / self.dx * beta;
                        let (ln_t, _) = fowler_nordheim(f_local, phi_w);
                        let lw = eta * e.ln()
                            + q * ln_t
                            + sigma * self.rng.gauss()
                            + steer_k * (dir[0] * steer[0] + dir[2] * steer[1]);
                        self.cand_logw.push(lw);
                    }
                }
            }
        }
        if self.cand_cell.is_empty() || self.nodes.len() >= MAX_NODES - 2 {
            return true;
        }
        // Born-rule sampling: P ∝ exp(lw) (softmax with max subtraction for stability)
        let mx = self.cand_logw.iter().cloned().fold(f32::MIN, f32::max);
        let mut total = 0.0f32;
        for w in self.cand_logw.iter_mut() {
            *w = (*w - mx).exp();
            total += *w;
        }
        let mut r = self.rng.f() * total;
        let mut pick = self.cand_logw.len() - 1;
        for (k, w) in self.cand_logw.iter().enumerate() {
            r -= *w;
            if r <= 0.0 {
                pick = k;
                break;
            }
        }
        let ci = self.cand_cell[pick] as usize;
        let par = self.cand_par[pick] as usize;
        // diagnostics: Fowler–Nordheim at the strongest-field site
        let f_tip = best_f * v0 / self.dx * beta;
        self.tip_field = best_f * v0 / self.dx;
        self.fn_j = fowler_nordheim(f_tip, phi_w).1;

        self.mask[ci] = 1;
        self.phi[ci] = 1.0;
        let (x, y, z) = self.coords(ci);
        let j = 0.28;
        let pos = [
            x as f32 + 0.5 + self.rng.gauss() * j,
            y as f32 + 0.5 + self.rng.gauss() * j,
            z as f32 + 0.5 + self.rng.gauss() * j,
        ];
        let pp = self.nodes[par].pos;
        let mid = [
            (pos[0] + pp[0]) * 0.5 + self.rng.gauss() * 0.22,
            (pos[1] + pp[1]) * 0.5 + self.rng.gauss() * 0.22,
            (pos[2] + pp[2]) * 0.5 + self.rng.gauss() * 0.22,
        ];
        self.nodes.push(Node {
            cell: ci as u32,
            parent: par as i32,
            pos,
            mid,
            temp: 12000.0 + 4000.0 * self.rng.f(),
            ..Default::default()
        });
        self.tip_h = self.tip_h.min(y as f32 * self.dx);
        self.low_h = self.low_h.min(y as f32 * self.dx);
        // local relaxation around the new conductor cell
        let r = 4usize;
        let bb = [
            x.saturating_sub(r).max(1),
            (x + r + 1).min(nx - 1),
            y.saturating_sub(r).max(1),
            (y + r + 1).min(ny - 1),
            z.saturating_sub(r).max(1),
            (z + r + 1).min(nz - 1),
        ];
        self.sor(3, 1.6, Some(bb));

        // Attachment: ground below, or grounded structure within striking distance (upward connecting leader).
        let me = self.nodes.len() - 1;
        if y <= 1 {
            let gp = [pos[0], 0.0, pos[2]];
            self.push_attach(me, gp);
            return true;
        }
        if self.tower[2] > 0.0 {
            let (tx, tz, th) = (self.tower[0] + 0.5, self.tower[1] + 0.5, self.tower[2] + 1.0);
            let ddx = pos[0] - tx;
            let ddz = pos[2] - tz;
            let ddy = (pos[1] - th).max(0.0);
            if (y as f32) <= th + 1.5 && (ddx * ddx + ddz * ddz).sqrt() < 2.2
                || (ddx * ddx + ddz * ddz + ddy * ddy).sqrt() < 2.6
            {
                self.push_attach(me, [tx, th, tz]);
                return true;
            }
        }
        false
    }

    fn push_attach(&mut self, from: usize, gp: [f32; 3]) {
        let pp = self.nodes[from].pos;
        let mid = [
            (gp[0] + pp[0]) * 0.5 + self.rng.gauss() * 0.15,
            (gp[1] + pp[1]) * 0.5,
            (gp[2] + pp[2]) * 0.5 + self.rng.gauss() * 0.15,
        ];
        self.nodes.push(Node {
            cell: u32::MAX,
            parent: from as i32,
            pos: gp,
            mid,
            temp: 15000.0,
            ..Default::default()
        });
        self.ground_node = (self.nodes.len() - 1) as i32;
    }

    fn seg_len_m(&self, a: usize) -> f32 {
        let n = &self.nodes[a];
        if n.parent < 0 {
            return 0.0;
        }
        let p = &self.nodes[n.parent as usize];
        let l1 = dist3(n.pos, n.mid);
        let l2 = dist3(n.mid, p.pos);
        (l1 + l2) * self.dx
    }

    fn prepare_return_stroke(&mut self) {
        let n = self.nodes.len();
        for nd in self.nodes.iter_mut() {
            nd.main = false;
            nd.dist = 0.0;
            nd.bdist = 0.0;
            nd.amp = 0.0;
        }
        // Walk from the ground attachment back to the cloud: main channel.
        let mut path = Vec::new();
        let mut c = self.ground_node;
        while c >= 0 {
            path.push(c as usize);
            c = self.nodes[c as usize].parent;
        }
        let mut d = 0.0;
        for k in 0..path.len() {
            let i = path[k];
            self.nodes[i].main = true;
            self.nodes[i].dist = d;
            self.nodes[i].amp = 1.0;
            if k + 1 < path.len() {
                d += self.seg_len_m(i);
            }
        }
        self.main_len = d;
        // Side branches (nodes are stored parent-before-child).
        for i in 0..n {
            if self.nodes[i].main {
                continue;
            }
            let par = self.nodes[i].parent;
            if par < 0 {
                continue;
            }
            let l = self.seg_len_m(i);
            let p = self.nodes[par as usize];
            let bd = if p.main { l } else { p.bdist + l };
            self.nodes[i].dist = p.dist + l;
            self.nodes[i].bdist = bd;
            self.nodes[i].amp = 0.22 * (-bd / 450.0).exp();
        }
    }

    fn begin_stroke(&mut self) {
        let first = self.stroke == 0;
        if first {
            // CIGRE: first negative stroke median 31 kA, σ_ln = 0.48 ; IEC 62305 1/200 µs
            self.i0 = self.rng.lognormal(self.p[P_IPEAK], 0.48) * 1e3;
            self.tau1 = 1.82e-6;
            self.tau2 = 285e-6;
            self.eta_h = 0.986;
        } else {
            // subsequent strokes: median 12 kA, σ_ln = 0.53 ; IEC 0.25/100 µs
            self.i0 = self.rng.lognormal(self.p[P_IPEAK] * 12.0 / 31.0, 0.53) * 1e3;
            self.tau1 = 0.454e-6;
            self.tau2 = 143e-6;
            self.eta_h = 0.993;
        }
        self.t_peak = self.tau1 * (10.0 * self.tau2 / self.tau1).powf(1.0 / 11.0);
        self.phase = Phase::Return;
        self.t = 0.0;
        self.thunder_pending = 1;
        self.thunder_i0 = self.i0;
    }

    fn t_target(i: f32) -> f32 {
        // Joule heating equilibrium: T ∝ √I  ⇒  radiance σT⁴ ∝ I².  30 kA → ~30 000 K
        (300.0 + 29_700.0 * (i.abs() / 30_000.0).sqrt()).min(38_000.0)
    }

    fn cool(&mut self, dt: f32, tau: f32) {
        let k = (-dt / tau).exp();
        for nd in self.nodes.iter_mut() {
            nd.temp = 300.0 + (nd.temp - 300.0) * k;
        }
    }

    fn step(&mut self, dt_real: f32) -> u32 {
        let dt_real = dt_real.clamp(0.0, 0.1);
        let mic = self.p[P_MIC_LEVEL];
        match self.phase {
            Phase::Idle => {
                let ss = dt_real * self.p[P_STROKE_SLOWMO];
                self.cool(ss, self.p[P_AFTERGLOW_MS] * 1e-3);
                if self.p[P_AUTO] > 0.5 {
                    self.timer -= dt_real * (1.0 + 6.0 * mic);
                    if self.timer <= 0.0 {
                        self.start_flash();
                    }
                }
            }
            Phase::Leader => {
                let sim_dt = dt_real * self.p[P_LEADER_SLOWMO];
                self.t += sim_dt;
                // Stepping rate from Fowler–Nordheim emission at the tip (relative to a
                // reference current density) and microphone energy.
                let beta = 10f32.powf(self.p[P_BETA_LOG]);
                let jref = fowler_nordheim(0.25 * self.p[P_V0_MV] * 1e6 / self.dx * beta, self.p[P_WORKFN]).1;
                let fnm = if self.fn_j > 0.0 && jref > 0.0 {
                    (self.fn_j / jref).powf(0.12).clamp(0.4, 3.0)
                } else {
                    1.0
                };
                let rate = 50_000.0 * fnm * (1.0 + 3.0 * mic); // steps per simulated second
                self.step_acc += sim_dt * rate;
                let eta = self.p[P_ETA] * (1.25 - 0.5 * self.p[P_MIC_PITCH] * mic.min(1.0) * 2.0).max(0.3);
                let a = self.p[P_MIC_PITCH] * 2.0 * PI;
                let steer = [a.cos(), a.sin()];
                let sk = self.p[P_MIC_STEER] * mic * 4.0;
                let mut grown = 0;
                let mut hit = false;
                self.tip_h = f32::MAX;
                while self.step_acc >= 1.0 && grown < 48 {
                    self.step_acc -= 1.0;
                    grown += 1;
                    if self.grow_once(eta, steer, sk) {
                        hit = true;
                        break;
                    }
                    if grown % 4 == 0 {
                        let sw = self.p[P_SWEEPS] as usize;
                        self.sor(sw.max(1) / 2 + 1, 1.85, None);
                    }
                }
                if grown > 0 {
                    let sw = self.p[P_SWEEPS] as usize;
                    self.sor(sw.max(1), 1.85, None);
                }
                self.cool(sim_dt, 0.6e-3);
                if hit {
                    if self.ground_node >= 0 {
                        self.prepare_return_stroke();
                        self.begin_stroke();
                    } else {
                        self.phase = Phase::Fade;
                        self.t = 0.0;
                        self.cc_dur = 0.0;
                    }
                }
            }
            Phase::Return => {
                let sim_dt = dt_real * self.p[P_STROKE_SLOWMO];
                let t0 = self.t;
                let t1 = self.t + sim_dt;
                self.t = t1;
                let tau = self.p[P_AFTERGLOW_MS] * 1e-3;
                let k = (-sim_dt / tau).exp();
                let (i0, ta1, ta2, eh, tp) = (self.i0, self.tau1, self.tau2, self.eta_h, self.t_peak);
                for nd in self.nodes.iter_mut() {
                    if nd.amp <= 0.0 {
                        nd.temp = 300.0 + (nd.temp - 300.0) * k;
                        continue;
                    }
                    // MTLE: i(z,t) = i(0, t - z/v) · exp(-z/λ)
                    let delay = nd.dist / V_RS;
                    let a = t0 - delay;
                    let b = t1 - delay;
                    let mut imax = heidler(a, i0, ta1, ta2, eh).max(heidler(b, i0, ta1, ta2, eh));
                    if a < tp && b > tp {
                        imax = imax.max(heidler(tp, i0, ta1, ta2, eh));
                    }
                    let i = imax * nd.amp * (-nd.dist / LAMBDA_MTLE).exp();
                    let tt = Sim::t_target(i);
                    let cooled = 300.0 + (nd.temp - 300.0) * k;
                    nd.temp = cooled.max(tt);
                }
                if self.t > 2.0e-3 {
                    self.stroke += 1;
                    self.t = 0.0;
                    if self.stroke < self.n_strokes {
                        self.phase = Phase::Inter;
                        // inter-stroke interval: log-normal, median ≈ 45 ms
                        self.inter_dur = self.rng.lognormal(0.045, 0.6).clamp(0.008, 0.25);
                    } else {
                        self.phase = Phase::Fade;
                        // ~30-50% of flashes carry continuing current (≈100 A for ≈100 ms)
                        if self.rng.f() < 0.4 {
                            self.cc_amp = self.rng.lognormal(140.0, 0.5);
                            self.cc_dur = self.rng.lognormal(0.12, 0.5);
                        } else {
                            self.cc_dur = 0.0;
                        }
                    }
                }
            }
            Phase::Inter => {
                let sim_dt = dt_real * self.p[P_STROKE_SLOWMO];
                self.t += sim_dt;
                self.cool(sim_dt, self.p[P_AFTERGLOW_MS] * 1e-3);
                if self.t >= self.inter_dur {
                    self.phase = Phase::Dart;
                    self.t = 0.0;
                    self.dart_front = self.main_len;
                }
            }
            Phase::Dart => {
                // Dart leaders are ~10× slower than return strokes; show them on the leader clock
                let sim_dt = dt_real * self.p[P_LEADER_SLOWMO] * 6.0;
                self.t += sim_dt;
                let prev = self.dart_front;
                self.dart_front = (self.main_len - V_DART * self.t).max(0.0);
                let front = self.dart_front;
                self.cool(sim_dt, 0.4e-3);
                for nd in self.nodes.iter_mut() {
                    if nd.main && nd.dist <= prev + 30.0 && nd.dist >= front - 30.0 {
                        nd.temp = nd.temp.max(14000.0);
                    }
                }
                if front <= 0.0 {
                    self.begin_stroke();
                }
            }
            Phase::Fade => {
                let sim_dt = dt_real * self.p[P_STROKE_SLOWMO];
                self.t += sim_dt;
                let tau = self.p[P_AFTERGLOW_MS] * 1e-3;
                let k = (-sim_dt / tau).exp();
                let cc = if self.t < self.cc_dur { self.cc_amp } else { 0.0 };
                let mut tmax = 0.0f32;
                for nd in self.nodes.iter_mut() {
                    let cooled = 300.0 + (nd.temp - 300.0) * k;
                    let tt = if nd.main && cc > 0.0 { Sim::t_target(cc * (-nd.dist / LAMBDA_MTLE).exp()) } else { 0.0 };
                    nd.temp = cooled.max(tt);
                    tmax = tmax.max(nd.temp);
                }
                if tmax < 900.0 && self.t >= self.cc_dur {
                    self.phase = Phase::Idle;
                    let per_min = self.p[P_ACTIVITY].max(0.1);
                    self.timer = self.rng.exponential(60.0 / per_min).clamp(0.4, 60.0);
                }
            }
        }
        self.wind_drift(dt_real);
        self.emit()
    }

    /// Wind drift of the hot channel between strokes ("ribbon lightning"). Mean wind follows
    /// the logarithmic boundary-layer profile u(z) = u_ref·ln(z/z₀)/ln(z_ref/z₀), its direction
    /// veers slowly; gusts are a kinematic-simulation field (divergence-free Fourier modes,
    /// Kolmogorov E(k) ∝ k^{−5/3}) so the channel curls like smoke as it drifts.
    fn wind_drift(&mut self, dt: f32) {
        if self.nodes.is_empty() || self.phase == Phase::Leader || self.phase == Phase::Idle {
            return;
        }
        if self.gusts.is_empty() {
            let n = 10;
            let (l_max, l_min) = (2500.0f32, 120.0f32);
            let mut e_sum = 0.0;
            let mut tmp = Vec::new();
            for i in 0..n {
                let kmag = 2.0 * PI / l_max * (l_max / l_min).powf(i as f32 / (n - 1) as f32);
                let e = kmag.powf(-5.0 / 3.0) * kmag;
                e_sum += e;
                let kh = unit3([self.rng.gauss(), self.rng.gauss(), self.rng.gauss()]);
                let perp = |v: [f32; 3]| { let d = dot3(v, kh); unit3(sub3(v, scale3(kh, d))) };
                let a = perp([self.rng.gauss(), self.rng.gauss(), self.rng.gauss()]);
                let b = perp([self.rng.gauss(), self.rng.gauss(), self.rng.gauss()]);
                tmp.push((scale3(kh, kmag), a, b, e));
            }
            for (k, a, b, e) in tmp {
                let amp = (e / e_sum).sqrt();
                let om = 0.5 * norm3(k) * self.p[P_GUST].max(1.0) * amp;
                self.gusts.push([k[0], k[1], k[2], a[0] * amp, a[1] * amp, a[2] * amp, b[0] * amp, b[1] * amp, b[2] * amp, om]);
            }
        }
        self.wind_t += dt;
        let t = self.wind_t;
        let dir = 0.6 + 0.4 * (t * 0.03).sin();
        let (wx, wz) = (dir.cos(), dir.sin());
        let u_ref = self.p[P_WIND];
        let gust = self.p[P_GUST];
        let z0 = 0.1f32;
        let lnref = (1000.0f32 / z0).ln();
        let dx = self.dx;
        let vel = |p: [f32; 3], gusts: &Vec<[f32; 10]>| -> [f32; 3] {
            let z = (p[1] * dx).max(1.0);
            let um = u_ref * (z / z0).ln() / lnref;
            let mut v = [um * wx, 0.0, um * wz];
            let x = [p[0] * dx, p[1] * dx, p[2] * dx];
            for m in gusts.iter() {
                let ph = m[0] * x[0] + m[1] * x[1] + m[2] * x[2] + m[9] * t;
                let (c, s) = (ph.cos(), ph.sin());
                v[0] += gust * (m[3] * c + m[6] * s);
                v[1] += gust * (m[4] * c + m[7] * s);
                v[2] += gust * (m[5] * c + m[8] * s);
            }
            v
        };
        let gusts = std::mem::take(&mut self.gusts);
        let ground = self.ground_node;
        for (i, nd) in self.nodes.iter_mut().enumerate() {
            // the attachment point stays on the ground/tower; the channel above it drifts
            if i as i32 == ground {
                continue;
            }
            let lift = (nd.pos[1] / 3.0).clamp(0.0, 1.0); // pinned near the ground
            let v = vel(nd.pos, &gusts);
            let vm = vel(nd.mid, &gusts);
            for j in 0..3 {
                nd.pos[j] += v[j] * dt / dx * lift;
                nd.mid[j] += vm[j] * dt / dx * lift;
            }
        }
        self.gusts = gusts;
    }

    /// Writes render instances: [x0,y0,z0, x1,y1,z1, T, width] per segment.
    fn emit(&mut self) -> u32 {
        let mut k = 0usize;
        let mut lsum = 0.0f32;
        let mut c = [0.0f32; 3];
        let mut tmax = 0.0f32;
        let mut col = [0.0f32; 3];
        let mut has_child = std::mem::take(&mut self.has_child);
        has_child.clear();
        has_child.resize(self.nodes.len(), false);
        for nd in self.nodes.iter() {
            if nd.parent >= 0 {
                has_child[nd.parent as usize] = true;
            }
        }
        for i in 0..self.nodes.len() {
            let n = self.nodes[i];
            if n.parent < 0 || n.temp < 900.0 {
                continue;
            }
            let p = self.nodes[n.parent as usize];
            let a = self.world(p.pos);
            let m = self.world(n.mid);
            let b = self.world(n.pos);
            let tseg = 0.5 * (n.temp + p.temp.min(n.temp * 1.2));
            let w = if n.main && self.phase != Phase::Leader { 1.0 } else { 0.55 + 0.45 * n.amp.min(1.0) };
            for (si, (s, e)) in [(a, m), (m, b)].into_iter().enumerate() {
                let o = k * SEG_FLOATS;
                self.segs[o..o + 3].copy_from_slice(&s);
                self.segs[o + 3..o + 6].copy_from_slice(&e);
                self.segs[o + 6] = tseg;
                // negative width marks a channel terminus (leader tip / ground attachment): round end-cap
                self.segs[o + 7] = if si == 1 && !has_child[i] { -w } else { w };
                k += 1;
            }
            let rad = (tseg / 10_000.0).powi(4) * w * self.dx;
            lsum += rad;
            for j in 0..3 {
                c[j] += rad * m[j];
            }
            let li = (((tseg - LUT_TMIN) / (LUT_TMAX - LUT_TMIN)) * (LUT_N - 1) as f32).clamp(0.0, (LUT_N - 1) as f32) as usize;
            for j in 0..3 {
                col[j] += rad * self.lut[li * 3 + j];
            }
            tmax = tmax.max(tseg);
        }
        self.has_child = has_child;
        if lsum > 0.0 {
            for j in 0..3 {
                c[j] /= lsum;
                col[j] /= lsum;
            }
        }
        self.light = [lsum, c[0], c[1], c[2], col[0], col[1], col[2], tmax];
        // stats
        let gp = if self.ground_node >= 0 { self.world(self.nodes[self.ground_node as usize].pos) } else { [0.0; 3] };
        let tw = self.world([self.tower[0] + 0.5, 0.0, self.tower[1] + 0.5]);
        let st = &mut self.stats;
        st[0] = self.phase as u32 as f32;
        st[1] = self.stroke as f32;
        st[2] = self.n_strokes as f32;
        st[3] = self.i0 / 1e3;
        st[4] = tmax;
        st[5] = self.tip_field;
        st[6] = self.low_h;
        st[7] = self.fn_j;
        st[8] = self.nodes.len() as f32;
        st[9] = gp[0];
        st[10] = gp[1];
        st[11] = gp[2];
        st[12] = self.t;
        st[13] = self.main_len;
        st[14] = self.dx;
        st[15] = tw[0];
        st[16] = tw[2];
        st[17] = self.tower[2] * self.dx;
        st[18] = self.flash_id as f32;
        st[19] = self.nx as f32 * self.dx;
        st[20] = self.ny as f32 * self.dx;
        st[21] = self.nz as f32 * self.dx;
        st[22] = self.timer;
        st[23] = self.ground_node as f32;
        k as u32
    }

    // ------------------------------------------------------------ thunder acoustics
    /// Copies the current-carrying channel geometry so thunder can be synthesised elsewhere
    /// (e.g. in a Web Worker running its own instance of this module).
    fn build_snapshot(&mut self) -> u32 {
        self.snap.clear();
        for i in 0..self.nodes.len() {
            let nd = self.nodes[i];
            if nd.parent < 0 || nd.amp <= 0.03 {
                continue;
            }
            let a = self.world(self.nodes[nd.parent as usize].pos);
            let b = self.world(nd.pos);
            self.snap.extend_from_slice(&[a[0], a[1], a[2], b[0], b[1], b[2], nd.amp, nd.dist]);
        }
        (self.snap.len() / 8) as u32
    }

    fn thunder_gen(&mut self, channels: usize, sr: f32) -> u32 {
        let lp = [self.listener[0], self.listener[1], self.listener[2]];
        let stems = channels == 12;
        // start the clip at the first arrival (nearest channel point) instead of carrying
        // seconds of leading silence; the offset is reported for sample-exact scheduling
        let (mut rnear, mut rfar) = (f32::MAX, 0.0f32);
        for k in 0..self.snap.len() / 8 {
            for e in [0usize, 3] {
                let q = [self.snap[k * 8 + e], self.snap[k * 8 + e + 1], self.snap[k * 8 + e + 2]];
                let r = norm3(sub3(q, lp));
                rnear = rnear.min(r);
                rfar = rfar.max(r);
            }
        }
        if rnear == f32::MAX {
            rnear = 0.0;
        }
        let offset = (rnear / C_SOUND - 0.05).max(0.0);
        self.thunder_offset = offset;
        let dur = ((rfar.max(rnear) - rnear) / C_SOUND + 4.0).min(26.0);
        let frames = (dur * sr) as usize;
        self.thunder.clear();
        self.thunder.resize(frames * channels, 0.0);
        let mut fw = [self.listener[3], self.listener[4]];
        let fl = (fw[0] * fw[0] + fw[1] * fw[1]).sqrt().max(1e-6);
        fw = [fw[0] / fl, fw[1] / fl];
        let right = [-fw[1], fw[0]];
        let i_norm = self.thunder_i0 / 30_000.0;
        // speaker ring for VBAP (azimuth degrees, channel index), Web Audio 5.1 order: L R C LFE SL SR
        let ring51: [(f32, usize); 5] = [(-110.0, 4), (-30.0, 0), (0.0, 2), (30.0, 1), (110.0, 5)];
        let mut rmin = f32::MAX;
        let snap = std::mem::take(&mut self.snap);
        let ns = snap.len() / 8;
        let total_len: f32 = (0..ns).map(|k| dist3([snap[k * 8], snap[k * 8 + 1], snap[k * 8 + 2]], [snap[k * 8 + 3], snap[k * 8 + 4], snap[k * 8 + 5]])).sum();
        let micro = (total_len / 2500.0).max(8.0);
        for k in 0..ns {
            let e = &snap[k * 8..k * 8 + 8];
            let a = [e[0], e[1], e[2]];
            let b = [e[3], e[4], e[5]];
            let (nd_amp, nd_dist) = (e[6], e[7]);
            let seg = sub3(b, a);
            let len = norm3(seg).max(1e-3);
            let dir0 = scale3(seg, 1.0 / len);
            let nm = (len / micro).ceil().max(1.0) as usize;
            let l = len / nm as f32;
            let amp = nd_amp * (-nd_dist / LAMBDA_MTLE).exp();
            // Few (1969): energy per unit length; first strokes ~ 2 MJ/m on the main channel
            let e_l = 2.0e6 * i_norm * i_norm * amp * amp;
            if e_l < 1e2 {
                continue;
            }
            let r0 = (e_l / (PI * P_ATM)).sqrt();
            let tau0 = r0 / (0.63 * C_SOUND);
            for m in 0..nm {
                let f = (m as f32 + self.rng.f()) / nm as f32;
                let mut pos = add3(a, scale3(seg, f));
                for j in 0..3 {
                    pos[j] += self.rng.gauss() * 2.5;
                }
                // micro-tortuosity: Gaussian angular deviation (~16°)
                let mut dir = dir0;
                for j in 0..3 {
                    dir[j] += self.rng.gauss() * 0.28;
                }
                let dn = norm3(dir).max(1e-6);
                dir = scale3(dir, 1.0 / dn);
                for img in 0..2 {
                    let src = if img == 0 { pos } else { [pos[0], -pos[1], pos[2]] };
                    let rel = sub3(src, lp);
                    let r = norm3(rel).max(1.0);
                    rmin = rmin.min(r);
                    let rh = scale3(rel, 1.0 / r);
                    // weak-shock N-wave lengthening
                    let tau = tau0 * (1.0 + (r / (10.0 * r0)).max(1.0).ln()).sqrt();
                    let lam = C_SOUND * tau;
                    let cos_t = dot3(dir, rh);
                    let x = PI * l * cos_t / lam;
                    let dfac = if x.abs() < 1e-4 { 1.0 } else { (x.sin() / x).abs() };
                    let refl = if img == 0 { 1.0 } else { 0.6 };
                    // geometric spreading + broadband atmospheric absorption
                    let amp_s = e_l.sqrt() * l / r * dfac * refl * (-r / 12_000.0).exp();
                    if amp_s < 1e-6 {
                        continue;
                    }
                    // absorption-smoothed shock rise time grows with range
                    // (classical + molecular-relaxation absorption removes the highs with range:
                    // near strikes crack, distant ones rumble)
                    let rise = (0.0004 + r * 1.0e-6) * sr;
                    // panning
                    let az = (dot3(rh, [right[0], 0.0, right[1]])).atan2(rh[0] * fw[0] + rh[2] * fw[1]);
                    let t_arr = r / C_SOUND - offset;
                    let mut gains = [0.0f32; 12];
                    let mut delays = [0.0f32; 12];
                    if stems {
                        // world-fixed directional stems: ring of 8 at 10° elevation, ring of 4 at
                        // 55°; pairwise constant-power panning in azimuth and between rings
                        let az = rh[0].atan2(-rh[2]).rem_euclid(2.0 * PI);
                        let el = rh[1].clamp(-1.0, 1.0).asin().to_degrees();
                        let w_hi = ((el - 10.0) / 45.0).clamp(0.0, 1.0);
                        let (gl, gh) = ((1.0 - w_hi).sqrt(), w_hi.sqrt());
                        let sec = az / (PI / 4.0);
                        let i0 = sec.floor() as usize % 8;
                        let f = sec - sec.floor();
                        gains[i0] += (f * PI / 2.0).cos() * gl;
                        gains[(i0 + 1) % 8] += (f * PI / 2.0).sin() * gl;
                        let sh = ((az - PI / 4.0).rem_euclid(2.0 * PI)) / (PI / 2.0);
                        let j0 = sh.floor() as usize % 4;
                        let fh = sh - sh.floor();
                        gains[8 + j0] += (fh * PI / 2.0).cos() * gh;
                        gains[8 + (j0 + 1) % 4] += (fh * PI / 2.0).sin() * gh;
                    } else if channels >= 6 {
                        let azd = az.to_degrees();
                        for q in 0..5 {
                            let (a1, c1) = ring51[q];
                            let (mut a2, c2) = ring51[(q + 1) % 5];
                            let mut th = azd;
                            if q == 4 {
                                a2 += 360.0;
                                if th < a1 {
                                    th += 360.0;
                                }
                            }
                            if th >= a1 && th <= a2 {
                                let s = ((a2 - a1).to_radians()).sin();
                                let g1 = ((a2 - th).to_radians()).sin() / s;
                                let g2 = ((th - a1).to_radians()).sin() / s;
                                let nrm = (g1 * g1 + g2 * g2).sqrt().max(1e-6);
                                gains[c1] = g1 / nrm;
                                gains[c2] = g2 / nrm;
                                break;
                            }
                        }
                    } else {
                        let mut a = az;
                        if a > PI / 2.0 {
                            a = PI - a;
                        } else if a < -PI / 2.0 {
                            a = -PI - a;
                        }
                        let pan = (a / (PI / 2.0)).clamp(-1.0, 1.0);
                        let th = (pan + 1.0) * PI / 4.0;
                        let behind = if az.abs() > PI / 2.0 { 0.8 } else { 1.0 };
                        gains[0] = th.cos() * behind;
                        gains[1] = th.sin() * behind;
                        // Woodworth ITD
                        let aa = a.abs();
                        let itd = 0.0875 / C_SOUND * (aa.sin() + aa);
                        if a > 0.0 {
                            delays[0] = itd;
                        } else {
                            delays[1] = itd;
                        }
                    }
                    let n = (tau * sr).max(4.0) as usize;
                    for ch in 0..channels.min(12) {
                        let g = gains[ch] * amp_s;
                        if g == 0.0 {
                            continue;
                        }
                        let s0 = ((t_arr + delays[ch]).max(0.0) * sr) as usize;
                        if s0 + n >= frames {
                            continue;
                        }
                        let buf = &mut self.thunder[ch * frames + s0..ch * frames + s0 + n];
                        let inv = 1.0 / n as f32;
                        let ri = (rise as usize).min(n / 2);
                        // N-wave: p(t) = g·(1 - 2t/τ), shock fronts smoothed over the rise time
                        let step = -2.0 * g * inv;
                        let mut v = g;
                        v += step * ri as f32;
                        for smp in buf[ri..n - ri].iter_mut() {
                            *smp += v;
                            v += step;
                        }
                        for kk in (0..ri).chain(n - ri..n) {
                            let xk = kk as f32;
                            let env = smoothstep(0.0, rise, xk) * smoothstep(0.0, rise, n as f32 - xk);
                            buf[kk] += g * (1.0 - 2.0 * xk * inv) * env;
                        }
                    }
                }
            }
        }
        // LFE: bass-managed mono sum of the five main channels, 2-pole low-pass at 120 Hz
        if channels == 6 {
            for i in 0..frames {
                let t = &self.thunder;
                let m = t[i] + t[frames + i] + t[2 * frames + i] + t[4 * frames + i] + t[5 * frames + i];
                self.thunder[3 * frames + i] = 0.35 * m;
            }
            let a = 1.0 - (-2.0 * PI * 120.0 / sr).exp();
            let mut y1 = 0.0f32;
            let mut y2 = 0.0f32;
            for s in self.thunder[3 * frames..4 * frames].iter_mut() {
                y1 += a * (*s - y1);
                y2 += a * (y1 - y2);
                *s = y2;
            }
        }
        // Remove DC drift per channel with a gentle high-pass (20 Hz)
        let hp = (-2.0 * PI * 20.0 / sr).exp();
        for ch in 0..channels {
            let mut px = 0.0f32;
            let mut py = 0.0f32;
            for s in self.thunder[ch * frames..(ch + 1) * frames].iter_mut() {
                let y = hp * (py + *s - px);
                px = *s;
                py = y;
                *s = y;
            }
        }
        // Loudness ∝ 1/r of the nearest channel segment, then normalise.
        let peak = self.thunder.iter().fold(0.0f32, |m, v| m.max(v.abs())).max(1e-9);
        let target = (1800.0 / rmin.max(1.0)).clamp(0.12, 0.98) * (0.6 + 0.4 * i_norm.min(2.0) / 2.0 * 2.0).min(1.0);
        let g = target / peak;
        self.thunder.iter_mut().for_each(|v| *v *= g);
        self.snap = snap;
        // trim trailing silence (keep planar layout with the new stride)
        let mut last = 0usize;
        for ch in 0..channels {
            for i in (last..frames).rev() {
                if self.thunder[ch * frames + i].abs() > 1e-4 {
                    last = i;
                    break;
                }
            }
        }
        let n = (last + (0.5 * sr) as usize).min(frames);
        for ch in 1..channels {
            self.thunder.copy_within(ch * frames..ch * frames + n, ch * n);
        }
        self.thunder.truncate(n * channels);
        n as u32
    }
}

#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    if e1 <= e0 {
        return 1.0;
    }
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn sub3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale3(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn unit3(a: [f32; 3]) -> [f32; 3] {
    scale3(a, 1.0 / norm3(a).max(1e-9))
}
fn norm3(a: [f32; 3]) -> f32 {
    dot3(a, a).sqrt()
}
fn dist3(a: [f32; 3], b: [f32; 3]) -> f32 {
    norm3(sub3(a, b))
}

// ---------------------------------------------------------------- exports
#[no_mangle]
pub extern "C" fn init(nx: u32, ny: u32, nz: u32, seed: u32) {
    let keep = unsafe { SIM.as_ref().map(|s| s.p) };
    let mut s = Sim::new(nx.max(16) as usize, ny.max(24) as usize, nz.max(16) as usize, seed);
    if let Some(p) = keep {
        s.p = p;
    }
    unsafe {
        SIM = Some(s);
    }
}
#[no_mangle]
pub extern "C" fn set_param(id: u32, v: f32) {
    if (id as usize) < N_PARAMS {
        sim().p[id as usize] = v;
    }
}
#[no_mangle]
pub extern "C" fn get_param(id: u32) -> f32 {
    if (id as usize) < N_PARAMS { sim().p[id as usize] } else { 0.0 }
}
#[no_mangle]
pub extern "C" fn step(dt: f32) -> u32 {
    sim().step(dt)
}
/// Start a new flash immediately (or skip the wait).
#[no_mangle]
pub extern "C" fn trigger() {
    let s = sim();
    if s.phase == Phase::Idle || s.phase == Phase::Fade {
        s.start_flash();
    }
}
#[no_mangle]
pub extern "C" fn set_listener(x: f32, y: f32, z: f32, fx: f32, fz: f32) {
    sim().listener = [x, y, z, fx, fz];
}
#[no_mangle]
pub extern "C" fn thunder_pending() -> u32 {
    let s = sim();
    let v = s.thunder_pending;
    s.thunder_pending = 0;
    v
}
/// Snapshot the current stroke's channel for off-thread synthesis; returns emitter count.
#[no_mangle]
pub extern "C" fn thunder_snapshot() -> u32 {
    sim().build_snapshot()
}
#[no_mangle]
pub extern "C" fn snap_ptr() -> *const f32 {
    sim().snap.as_ptr()
}
#[no_mangle]
pub extern "C" fn thunder_i0() -> f32 {
    sim().thunder_i0
}
/// (worker side) reserve room for `count` emitters and return where to write them.
#[no_mangle]
pub extern "C" fn thunder_load(count: u32, i0: f32) -> *mut f32 {
    let s = sim();
    s.snap.clear();
    s.snap.resize(count as usize * 8, 0.0);
    s.thunder_i0 = i0;
    s.snap.as_mut_ptr()
}
/// Synthesise thunder from the snapshot; returns frames per channel (planar output).
#[no_mangle]
pub extern "C" fn thunder_gen(channels: u32, sample_rate: f32) -> u32 {
    sim().thunder_gen(channels.clamp(1, 12) as usize, sample_rate)
}
/// Seconds between the stroke and the first sample of the last synthesised thunder clip.
#[no_mangle]
pub extern "C" fn thunder_offset() -> f32 {
    sim().thunder_offset
}
#[no_mangle]
pub extern "C" fn thunder_ptr() -> *const f32 {
    sim().thunder.as_ptr()
}
#[no_mangle]
pub extern "C" fn seg_ptr() -> *const f32 {
    sim().segs.as_ptr()
}
#[no_mangle]
pub extern "C" fn light_ptr() -> *const f32 {
    sim().light.as_ptr()
}
#[no_mangle]
pub extern "C" fn stats_ptr() -> *const f32 {
    sim().stats.as_ptr()
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
/// Blackbody chromaticity (linear sRGB) for arbitrary T, written to the 3-float scratch.
#[no_mangle]
pub extern "C" fn blackbody(t: f32) -> *const f32 {
    static mut OUT: [f32; 3] = [0.0; 3];
    unsafe {
        OUT = blackbody_rgb(t as f64);
        OUT.as_ptr()
    }
}
