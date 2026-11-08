//! Lightning Machine — Tesla-coil arc core (Rust → WebAssembly).
//!
//! Every arc is re-grown from scratch each time the coil "fires" (interrupter pulse),
//! so there is no simulation lag: what you see is always the current discharge.
//!
//!  * Growth follows the electric field of a charged terminal (repelling, ∝ r̂/r for a
//!    2-D line charge) and of the strike target (attracting), plus Gaussian angular noise
//!    for the jagged streamer path, with random branching (stochastic streamer model).
//!  * Fine structure: Gaussian midpoint displacement on every step.
//!  * Brightness decays with the channel's cooling time constant between pulses.
//!  * Colour: Planck black body integrated against the CIE 1931 colour-matching functions
//!    (Wyman–Sloan–Shirley Gaussian fit) → XYZ → linear sRGB, as a lookup table.

#![allow(static_mut_refs)]

use std::f32::consts::PI;

const LUT_N: usize = 512;
const LUT_TMIN: f32 = 800.0;
const LUT_TMAX: f32 = 40000.0;
const MAX_SLOTS: usize = 40;
const SEG_FLOATS: usize = 8;
const MAX_SEGS: usize = 60000;

const H_PLANCK: f64 = 6.626_070_15e-34;
const C_LIGHT: f64 = 2.997_924_58e8;
const K_B: f64 = 1.380_649e-23;

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
    /// Standard normal (Box–Muller).
    fn gauss(&mut self) -> f32 {
        let u1 = self.f().max(1e-7);
        let u2 = self.f();
        (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos()
    }
}

// ---------------------------------------------------------------- colour science
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
    let r = (3.2404542 * x - 1.5371385 * y - 0.4985314 * z).max(0.0);
    let g = (-0.9692660 * x + 1.8760108 * y + 0.0415560 * z).max(0.0);
    let b = (0.0556434 * x - 0.2040259 * y + 1.0572252 * z).max(0.0);
    let m = r.max(g).max(b).max(1e-30);
    [(r / m) as f32, (g / m) as f32, (b / m) as f32]
}

// ---------------------------------------------------------------- arcs
#[derive(Clone, Copy)]
struct Seg {
    a: [f32; 2],
    b: [f32; 2],
    t: f32, // temperature (K)
    w: f32, // relative width (negative = channel terminus, round cap)
}

#[derive(Clone)]
struct Slot {
    segs: Vec<Seg>,
    age: f32,
    timer: f32,
    theta: f32,  // direction the streamer is aimed at (drifts → arcs sweep around)
    omega: f32,  // angular drift speed
    orb: usize,  // which terminal it leaves from
    kind: u8,    // 0 free streamer / wall strike, 1 orb-to-orb, 2 pointer
}

const P_MODE: usize = 0; // 0 wander, 1 follow pointer, 2 two orbs
const P_ARCS: usize = 1;
const P_REACH: usize = 2;
const P_BRANCH: usize = 3;
const P_SPEED: usize = 4;
const P_TEMP: usize = 5;
const P_RATE: usize = 6;
const P_MIC: usize = 7;
const P_JAG: usize = 8;
const P_GLOW: usize = 9; // cooling time constant (ms)
const N_PARAMS: usize = 10;

struct Sim {
    w: f32,
    h: f32,
    rng: Rng,
    p: [f32; N_PARAMS],
    time: f32,
    orbs: [[f32; 2]; 2],
    orb_v: [[f32; 2]; 2],
    pointer: [f32; 2],
    pointer_down: bool,
    pointer_seen: bool,
    slots: Vec<Slot>,
    pslot: Slot,
    out: Vec<f32>,
    info: [f32; 16],
    lut: Vec<f32>,
    stack: Vec<([f32; 2], [f32; 2], f32, u32, f32, [f32; 2], f32)>,
    fired: u32,
}

static mut SIM: Option<Sim> = None;
fn sim() -> &'static mut Sim {
    unsafe { SIM.as_mut().expect("init() first") }
}

fn norm2(v: [f32; 2]) -> [f32; 2] {
    let l = (v[0] * v[0] + v[1] * v[1]).sqrt().max(1e-6);
    [v[0] / l, v[1] / l]
}
fn rot(v: [f32; 2], a: f32) -> [f32; 2] {
    let (s, c) = a.sin_cos();
    [v[0] * c - v[1] * s, v[0] * s + v[1] * c]
}

impl Sim {
    fn new(seed: u32) -> Sim {
        let mut p = [0.0; N_PARAMS];
        p[P_MODE] = 0.0;
        p[P_ARCS] = 10.0;
        p[P_REACH] = 0.55;
        p[P_BRANCH] = 0.5;
        p[P_SPEED] = 1.0;
        p[P_TEMP] = 26000.0;
        p[P_RATE] = 60.0;
        p[P_JAG] = 0.55;
        p[P_GLOW] = 40.0;
        let mut s = Sim {
            w: 1280.0,
            h: 720.0,
            rng: Rng(0x853c49e6748fea9b ^ ((seed as u64) << 21 | seed as u64)),
            p,
            time: 0.0,
            orbs: [[640.0, 360.0], [900.0, 300.0]],
            orb_v: [[0.0; 2]; 2],
            pointer: [640.0, 360.0],
            pointer_down: false,
            pointer_seen: false,
            slots: Vec::new(),
            pslot: Slot { segs: Vec::new(), age: 9.0, timer: 0.0, theta: 0.0, omega: 0.0, orb: 0, kind: 2 },
            out: vec![0.0; MAX_SEGS * SEG_FLOATS],
            info: [0.0; 16],
            lut: vec![0.0; LUT_N * 3],
            stack: Vec::new(),
            fired: 0,
        };
        for i in 0..LUT_N {
            let t = LUT_TMIN + (LUT_TMAX - LUT_TMIN) * i as f32 / (LUT_N - 1) as f32;
            s.lut[i * 3..i * 3 + 3].copy_from_slice(&blackbody_rgb(t as f64));
        }
        for k in 0..MAX_SLOTS {
            let theta = s.rng.range(0.0, 2.0 * PI);
            let omega = s.rng.gauss() * 0.8;
            s.slots.push(Slot { segs: Vec::new(), age: 9.0, timer: s.rng.f() * 0.05, theta, omega, orb: k % 2, kind: 0 });
        }
        s
    }

    fn scale(&self) -> f32 {
        self.w.min(self.h)
    }
    fn orb_radius(&self) -> f32 {
        self.scale() * 0.028
    }

    fn move_orbs(&mut self, dt: f32) {
        let t = self.time * self.p[P_SPEED];
        let (w, h) = (self.w, self.h);
        let mode = self.p[P_MODE] as i32;
        // Smooth Lissajous-like roaming across the whole screen.
        let path = |ph: f32| -> [f32; 2] {
            [
                w * (0.5 + 0.36 * (0.31 * t + ph).sin() + 0.08 * (0.83 * t + 2.0 * ph).sin()),
                h * (0.5 + 0.34 * (0.23 * t + 1.7 * ph).sin() + 0.08 * (0.71 * t + 0.5 * ph).cos()),
            ]
        };
        let mut goal = [path(0.0), path(2.4)];
        if mode == 1 && self.pointer_seen {
            goal[0] = self.pointer;
        }
        // critically damped follow (fast, no overshoot) → no perceptible lag
        let k = if mode == 1 { 28.0 } else { 6.0 };
        for i in 0..2 {
            let x = self.orbs[i];
            let v = self.orb_v[i];
            let ax = k * k * (goal[i][0] - x[0]) - 2.0 * k * v[0];
            let ay = k * k * (goal[i][1] - x[1]) - 2.0 * k * v[1];
            self.orb_v[i] = [v[0] + ax * dt, v[1] + ay * dt];
            self.orbs[i] = [x[0] + self.orb_v[i][0] * dt, x[1] + self.orb_v[i][1] * dt];
        }
    }

    /// Grow one discharge (with branches) from `start` aimed at `target`.
    fn grow(&mut self, start: [f32; 2], target: [f32; 2], attract: f32, segs: &mut Vec<Seg>, temp: f32) {
        segs.clear();
        let sc = self.scale();
        let step = sc * 0.014;
        let jag = self.p[P_JAG];
        let branch = self.p[P_BRANCH];
        let src = start;
        let d0 = [target[0] - start[0], target[1] - start[1]];
        let dist = (d0[0] * d0[0] + d0[1] * d0[1]).sqrt();
        let budget = dist * self.rng.range(1.15, 1.45) + step * 2.0;
        self.stack.clear();
        self.stack.push((start, norm2(d0), budget, 0, temp, target, attract));
        let margin = step * 3.0;
        while let Some((mut p, mut dir, mut left, depth, t0, tgt, att)) = self.stack.pop() {
            let total = left.max(1.0);
            let wbase = 0.62f32.powi(depth as i32);
            let mut n = 0;
            while left > 0.0 && segs.len() < 4000 {
                // field direction: repelled from the terminal (2-D line charge ∝ r̂/r),
                // attracted to the target; Gaussian angular noise gives the zig-zag.
                let rs = [p[0] - src[0], p[1] - src[1]];
                let rs2 = (rs[0] * rs[0] + rs[1] * rs[1]).max(step * step);
                let rt = [tgt[0] - p[0], tgt[1] - p[1]];
                let rtl = (rt[0] * rt[0] + rt[1] * rt[1]).sqrt();
                if depth == 0 && rtl < step * 1.2 {
                    // reached the target: final segment
                    let t = t0;
                    segs.push(Seg { a: p, b: tgt, t, w: -wbase });
                    left = 0.0;
                    let _ = left;
                    break;
                }
                let rtn = [rt[0] / rtl.max(1e-6), rt[1] / rtl.max(1e-6)];
                let e_src = [rs[0] / rs2 * sc * 0.25, rs[1] / rs2 * sc * 0.25];
                let guide = norm2([rtn[0] * att + e_src[0] + dir[0] * 0.6, rtn[1] * att + e_src[1] + dir[1] * 0.6]);
                let ndir = rot(guide, self.rng.gauss() * jag);
                let len = step * self.rng.range(0.6, 1.4);
                let q = [p[0] + ndir[0] * len, p[1] + ndir[1] * len];
                let prog = 1.0 - left / total;
                let t = (t0 * (1.0 - 0.35 * prog)).max(3000.0);
                let last = left - len <= 0.0
                    || q[0] < -margin
                    || q[1] < -margin
                    || q[0] > self.w + margin
                    || q[1] > self.h + margin;
                // Gaussian midpoint displacement for fine structure
                let perp = [-ndir[1], ndir[0]];
                let off = self.rng.gauss() * len * 0.22;
                let m = [(p[0] + q[0]) * 0.5 + perp[0] * off, (p[1] + q[1]) * 0.5 + perp[1] * off];
                let w = wbase * (1.0 - 0.5 * prog);
                segs.push(Seg { a: p, b: m, t, w });
                segs.push(Seg { a: m, b: q, t, w: if last { -w } else { w } });
                p = q;
                dir = ndir;
                left -= len;
                n += 1;
                if last {
                    break;
                }
                // branching (streamers fork more near the terminal)
                if depth < 3 && n > 1 && self.rng.f() < branch * 0.10 * (1.0 - 0.25 * depth as f32) {
                    let ang = self.rng.range(0.35, 1.0) * if self.rng.f() < 0.5 { -1.0 } else { 1.0 };
                    let bdir = rot(dir, ang);
                    let blen = left * self.rng.range(0.15, 0.55);
                    let btgt = [p[0] + bdir[0] * blen * 2.0, p[1] + bdir[1] * blen * 2.0];
                    self.stack.push((p, bdir, blen, depth + 1, t * 0.85, btgt, 0.35));
                }
            }
        }
    }

    fn fire_slot(&mut self, k: usize) {
        let mode = self.p[P_MODE] as i32;
        let mic = self.p[P_MIC];
        let diag = (self.w * self.w + self.h * self.h).sqrt();
        let reach = self.p[P_REACH] * diag * (1.0 + 0.9 * mic) * self.rng.range(0.55, 1.05);
        let r0 = self.orb_radius();
        let mut slot = std::mem::replace(&mut self.slots[k], Slot { segs: Vec::new(), age: 0.0, timer: 0.0, theta: 0.0, omega: 0.0, orb: 0, kind: 0 });
        let orb = if mode == 2 { slot.orb } else { 0 };
        let c = self.orbs[orb];
        let other = self.orbs[1 - orb];
        // two-orb mode: some arcs jump between the terminals when close enough
        let od = ((other[0] - c[0]).powi(2) + (other[1] - c[1]).powi(2)).sqrt();
        let (target, attract, kind);
        if mode == 2 && k % 3 == 0 && od < reach * 1.3 {
            target = [other[0] + self.rng.gauss() * r0 * 0.5, other[1] + self.rng.gauss() * r0 * 0.5];
            attract = 1.6;
            kind = 1;
        } else {
            let dir = [slot.theta.cos(), slot.theta.sin()];
            let mut t = [c[0] + dir[0] * reach, c[1] + dir[1] * reach];
            // clamp to the screen edges → the arc strikes the "wall" (grounded frame)
            let hit_wall = t[0] < 0.0 || t[1] < 0.0 || t[0] > self.w || t[1] > self.h;
            t[0] = t[0].clamp(0.0, self.w);
            t[1] = t[1].clamp(0.0, self.h);
            target = t;
            attract = if hit_wall { 1.3 } else { 0.7 };
            kind = 0;
        }
        let d = norm2([target[0] - c[0], target[1] - c[1]]);
        let start = [c[0] + d[0] * r0 * 0.9, c[1] + d[1] * r0 * 0.9];
        let temp = self.p[P_TEMP] * self.rng.range(0.85, 1.1);
        let mut segs = std::mem::take(&mut slot.segs);
        self.grow(start, target, attract, &mut segs, temp);
        slot.segs = segs;
        slot.age = 0.0;
        slot.kind = kind;
        self.slots[k] = slot;
        self.fired += 1;
    }

    fn step(&mut self, dt: f32) -> u32 {
        let dt = dt.clamp(0.0, 0.1);
        self.time += dt;
        self.move_orbs(dt);
        let mic = self.p[P_MIC];
        let n_arcs = ((self.p[P_ARCS] * (1.0 + 1.2 * mic)) as usize).clamp(1, MAX_SLOTS);
        let rate = (self.p[P_RATE] * (1.0 + 1.5 * mic)).clamp(1.0, 240.0);
        let speed = self.p[P_SPEED];
        for k in 0..MAX_SLOTS {
            let s = &mut self.slots[k];
            s.age += dt;
            // aim drifts → arcs crawl and sweep around the terminal
            s.omega += self.rng.gauss() * 0.6 * dt.sqrt();
            s.omega = s.omega.clamp(-2.5, 2.5);
            s.theta += s.omega * speed * dt;
            if k >= n_arcs {
                continue;
            }
            s.timer -= dt;
            if s.timer <= 0.0 {
                // interrupter pulse with jitter
                let jitter = self.rng.range(0.5, 1.5);
                self.slots[k].timer = jitter / rate;
                self.fire_slot(k);
            }
        }
        // pointer arc: touching / clicking pulls a hot arc to the finger
        let mode = self.p[P_MODE] as i32;
        self.pslot.age += dt;
        if self.pointer_down && mode != 1 {
            self.pslot.timer -= dt;
            if self.pslot.timer <= 0.0 {
                self.pslot.timer = self.rng.range(0.5, 1.5) / rate.max(30.0);
                let o = if mode == 2 {
                    let d0 = (self.orbs[0][0] - self.pointer[0]).hypot(self.orbs[0][1] - self.pointer[1]);
                    let d1 = (self.orbs[1][0] - self.pointer[0]).hypot(self.orbs[1][1] - self.pointer[1]);
                    if d1 < d0 { 1 } else { 0 }
                } else {
                    0
                };
                let c = self.orbs[o];
                let tg = self.pointer;
                let d = norm2([tg[0] - c[0], tg[1] - c[1]]);
                let r0 = self.orb_radius();
                let start = [c[0] + d[0] * r0 * 0.9, c[1] + d[1] * r0 * 0.9];
                let mut segs = std::mem::take(&mut self.pslot.segs);
                let temp = self.p[P_TEMP] * 1.15;
                self.grow(start, tg, 1.8, &mut segs, temp);
                self.pslot.segs = segs;
                self.pslot.age = 0.0;
                self.fired += 1;
            }
        }
        self.emit()
    }

    fn emit(&mut self) -> u32 {
        let tau = (self.p[P_GLOW] * 1e-3).max(0.003);
        let mut k = 0usize;
        let mut act = 0.0f32;
        let (mut cx, mut cy) = (0.0f32, 0.0f32);
        let n_slots = self.slots.len();
        for si in 0..=n_slots {
            let slot = if si < n_slots { &self.slots[si] } else { &self.pslot };
            let i = (-slot.age / tau).exp();
            if i < 0.01 {
                continue;
            }
            for s in slot.segs.iter() {
                if k >= MAX_SEGS {
                    break;
                }
                let o = k * SEG_FLOATS;
                let out = &mut self.out[o..o + SEG_FLOATS];
                out[0] = s.a[0];
                out[1] = s.a[1];
                out[2] = s.b[0];
                out[3] = s.b[1];
                out[4] = s.t;
                out[5] = s.w;
                out[6] = i;
                out[7] = 0.0;
                let len = (s.b[0] - s.a[0]).hypot(s.b[1] - s.a[1]);
                let rad = (s.t / 10_000.0).powi(4) * s.w.abs() * len * i;
                act += rad;
                cx += rad * s.b[0];
                cy += rad * s.b[1];
                k += 1;
            }
        }
        if act > 0.0 {
            cx /= act;
            cy /= act;
        }
        let r0 = self.orb_radius();
        let sc = self.scale();
        let info = &mut self.info;
        info[0] = self.orbs[0][0];
        info[1] = self.orbs[0][1];
        info[2] = self.orbs[1][0];
        info[3] = self.orbs[1][1];
        info[4] = r0;
        info[5] = if self.p[P_MODE] as i32 == 2 { 2.0 } else { 1.0 };
        info[6] = act / (sc * 50.0); // normalised activity (for sound / room light)
        info[7] = cx;
        info[8] = cy;
        info[9] = self.fired as f32;
        self.fired = 0;
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
pub extern "C" fn set_view(w: f32, h: f32) {
    let s = sim();
    if s.w != w || s.h != h {
        let (sx, sy) = (w / s.w, h / s.h);
        for o in s.orbs.iter_mut() {
            o[0] *= sx;
            o[1] *= sy;
        }
        s.w = w.max(1.0);
        s.h = h.max(1.0);
    }
}
#[no_mangle]
pub extern "C" fn set_pointer(x: f32, y: f32, down: u32) {
    let s = sim();
    s.pointer = [x, y];
    s.pointer_down = down != 0;
    s.pointer_seen = true;
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
