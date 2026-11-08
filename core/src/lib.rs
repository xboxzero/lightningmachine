//! Lightning Machine — liquid lightning core (Rust → WebAssembly).
//!
//! Lightning bolts are born as jagged, branching channels (field-guided stochastic
//! growth with Gaussian angular noise) and then *flow*: every channel node is advected
//! through an incompressible 2-D fluid, so bolts fold, swirl and stretch like water or
//! liquid metal while they glow and cool.
//!
//!  * Fluid: point-vortex dynamics with Lamb–Oseen (Gaussian-core) vortices,
//!    v_θ = Γ/(2πr)·(1 − e^{−r²/r_c²}). Vortices move under each other's induced
//!    velocity (Biot–Savart). Walls are enforced with the method of images, so the
//!    flow runs along the screen edges and the lightning circulates around the screen.
//!    The field is divergence-free, so the "liquid" is incompressible like water.
//!  * Advection: midpoint (RK2) integration; channels are resampled as they stretch or
//!    compress, and a curvature (Laplacian) term acts like surface tension.
//!  * Crackle: Ornstein–Uhlenbeck (Gaussian) jitter on top of the flowing shape.
//!  * Light: return-stroke flash, re-strikes, then cooling; colour = Planck black body
//!    integrated against the CIE 1931 colour-matching functions → linear sRGB.

#![allow(static_mut_refs)]

use std::f32::consts::PI;

const LUT_N: usize = 512;
const LUT_TMIN: f32 = 800.0;
const LUT_TMAX: f32 = 40000.0;
const SEG_FLOATS: usize = 8;
const MAX_SEGS: usize = 40000;
const MAX_BOLTS: usize = 16;
const MAX_VORT: usize = 24;
const NODE_CAP: usize = 2400;

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

// ---------------------------------------------------------------- data
#[derive(Clone, Copy)]
struct Node {
    p: [f32; 2],
    parent: i32,
    jit: [f32; 2], // Ornstein–Uhlenbeck crackle offset (units of step)
    w: f32,        // relative width (branch order)
    depth: u8,
    alive: bool,
}

struct Bolt {
    nodes: Vec<Node>,
    age: f32,
    life: f32,
    pulse: f32,
    temp: f32,
}

#[derive(Clone, Copy)]
struct Vortex {
    p: [f32; 2],
    gamma: f32, // circulation (px²/s at speed 1)
    rc: f32,    // core radius (px)
}

const P_BOLTS: usize = 0;
const P_FLOW: usize = 1;
const P_VORT: usize = 2;
const P_CRACKLE: usize = 3;
const P_BRANCH: usize = 4;
const P_TEMP: usize = 5;
const P_LIFE: usize = 6;
const P_MIC: usize = 7;
const P_TENSION: usize = 8;
const P_RESTRIKE: usize = 9;
const N_PARAMS: usize = 10;

struct Sim {
    w: f32,
    h: f32,
    rng: Rng,
    p: [f32; N_PARAMS],
    time: f32,
    bolts: Vec<Bolt>,
    vort: Vec<Vortex>,
    pointer: [f32; 2],
    pointer_prev: [f32; 2],
    pointer_vel: [f32; 2],
    pointer_down: bool,
    spawn_t: f32,
    strikes: u32,
    restrikes: u32,
    out: Vec<f32>,
    info: [f32; 16],
    lut: Vec<f32>,
    kids: Vec<u16>,
    first_child: Vec<i32>,
    src: Vec<[f32; 4]>, // flattened vortices + wall images: x, y, Γ, r_c²
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
        p[P_BOLTS] = 5.0;
        p[P_FLOW] = 1.0;
        p[P_VORT] = 8.0;
        p[P_CRACKLE] = 0.6;
        p[P_BRANCH] = 0.6;
        p[P_TEMP] = 30000.0;
        p[P_LIFE] = 9.0;
        p[P_TENSION] = 0.3;
        p[P_RESTRIKE] = 0.6;
        let mut s = Sim {
            w: 1280.0,
            h: 720.0,
            rng: Rng(0x853c49e6748fea9b ^ ((seed as u64) << 21 | seed as u64)),
            p,
            time: 0.0,
            bolts: Vec::new(),
            vort: Vec::new(),
            pointer: [0.0; 2],
            pointer_prev: [0.0; 2],
            pointer_vel: [0.0; 2],
            pointer_down: false,
            spawn_t: 0.0,
            strikes: 0,
            restrikes: 0,
            out: vec![0.0; MAX_SEGS * SEG_FLOATS],
            info: [0.0; 16],
            lut: vec![0.0; LUT_N * 3],
            kids: Vec::new(),
            first_child: Vec::new(),
            src: Vec::new(),
        };
        for i in 0..LUT_N {
            let t = LUT_TMIN + (LUT_TMAX - LUT_TMIN) * i as f32 / (LUT_N - 1) as f32;
            s.lut[i * 3..i * 3 + 3].copy_from_slice(&blackbody_rgb(t as f64));
        }
        s
    }

    fn scale(&self) -> f32 {
        self.w.min(self.h)
    }
    fn step_len(&self) -> f32 {
        self.scale() * 0.019
    }

    // ------------------------------------------------------------ fluid
    fn ensure_vortices(&mut self) {
        let want = (self.p[P_VORT] as usize).clamp(1, MAX_VORT);
        let sc = self.scale();
        while self.vort.len() < want {
            let sign = if self.vort.len() % 2 == 0 { 1.0 } else { -1.0 };
            let v = Vortex {
                p: [self.rng.range(0.1, 0.9) * self.w, self.rng.range(0.1, 0.9) * self.h],
                gamma: sign * self.rng.range(0.6, 1.2) * sc * sc * 0.55,
                rc: sc * self.rng.range(0.07, 0.14),
            };
            self.vort.push(v);
        }
        self.vort.truncate(want);
    }

    /// Lamb–Oseen vortex velocity at offset d from its centre (core radius² rc2).
    #[inline]
    fn lamb_oseen(d: [f32; 2], gamma: f32, rc2: f32) -> [f32; 2] {
        let r2 = d[0] * d[0] + d[1] * d[1] + 1e-3;
        // outside ~3 core radii the Gaussian core term is < 1.3e-4: treat as a point vortex
        let core = if r2 > 9.0 * rc2 { 1.0 } else { 1.0 - (-r2 / rc2).exp() };
        let k = gamma / (2.0 * PI * r2) * core;
        [-d[1] * k, d[0] * k]
    }

    /// Flatten vortices and their first-order wall images (opposite circulation) once
    /// per step; the images make the normal velocity vanish at the screen edges.
    fn build_sources(&mut self) {
        let (w, h) = (self.w, self.h);
        self.src.clear();
        for vt in self.vort.iter() {
            let rc2 = vt.rc * vt.rc;
            self.src.push([vt.p[0], vt.p[1], vt.gamma, rc2]);
            for img in [[-vt.p[0], vt.p[1]], [2.0 * w - vt.p[0], vt.p[1]], [vt.p[0], -vt.p[1]], [vt.p[0], 2.0 * h - vt.p[1]]] {
                self.src.push([img[0], img[1], -vt.gamma, rc2]);
            }
        }
    }

    /// Velocity of the incompressible flow at point x. `skip` = vortex index to exclude
    /// (a vortex is not advected by itself, only by the others and by its images).
    fn velocity(&self, x: [f32; 2], skip: usize) -> [f32; 2] {
        let mut v = [0.0f32; 2];
        for (j, s) in self.src.iter().enumerate() {
            if j == skip.wrapping_mul(5) {
                continue;
            }
            let u = Sim::lamb_oseen([x[0] - s[0], x[1] - s[1]], s[2], s[3]);
            v[0] += u[0];
            v[1] += u[1];
        }
        // finger stirring: Gaussian momentum blob following the pointer
        if self.pointer_down {
            let d = [x[0] - self.pointer[0], x[1] - self.pointer[1]];
            let r = self.scale() * 0.12;
            let g = (-(d[0] * d[0] + d[1] * d[1]) / (r * r)).exp();
            v[0] += self.pointer_vel[0] * g;
            v[1] += self.pointer_vel[1] * g;
        }
        v
    }

    fn move_vortices(&mut self, dt: f32) {
        let n = self.vort.len();
        let flow = self.p[P_FLOW] * (1.0 + 1.5 * self.p[P_MIC]);
        self.build_sources();
        let mut vel = vec![[0.0f32; 2]; n];
        for i in 0..n {
            vel[i] = self.velocity(self.vort[i].p, i);
        }
        let (w, h) = (self.w, self.h);
        let m = self.scale() * 0.06;
        for i in 0..n {
            let wander = [self.rng.gauss() * self.scale() * 0.02, self.rng.gauss() * self.scale() * 0.02];
            let v = &mut self.vort[i];
            v.p[0] += (vel[i][0] * 0.6 + wander[0]) * dt * flow;
            v.p[1] += (vel[i][1] * 0.6 + wander[1]) * dt * flow;
            v.p[0] = v.p[0].clamp(m, w - m);
            v.p[1] = v.p[1].clamp(m, h - m);
        }
    }

    // ------------------------------------------------------------ bolts
    fn edge_point(&mut self) -> [f32; 2] {
        let (w, h) = (self.w, self.h);
        match (self.rng.f() * 4.0) as u32 {
            0 => [self.rng.f() * w, 0.0],
            1 => [w, self.rng.f() * h],
            2 => [self.rng.f() * w, h],
            _ => [0.0, self.rng.f() * h],
        }
    }

    fn spawn_bolt(&mut self, from: Option<[f32; 2]>) {
        if self.bolts.len() >= MAX_BOLTS {
            return;
        }
        let (w, h) = (self.w, self.h);
        let start = from.unwrap_or_else(|| {
            if self.rng.f() < 0.6 {
                self.edge_point()
            } else {
                [self.rng.range(0.15, 0.85) * w, self.rng.range(0.15, 0.85) * h]
            }
        });
        // aim across the screen, roughly through the centre region
        let mid = [self.rng.range(0.25, 0.75) * w, self.rng.range(0.25, 0.75) * h];
        let d = norm2([mid[0] - start[0], mid[1] - start[1]]);
        let len = (w * w + h * h).sqrt() * self.rng.range(0.55, 0.95);
        let target = [start[0] + d[0] * len, start[1] + d[1] * len];
        let mut nodes = Vec::with_capacity(600);
        nodes.push(Node { p: start, parent: -1, jit: [0.0; 2], w: 1.0, depth: 0, alive: true });
        let step = self.step_len();
        let branch = self.p[P_BRANCH];
        // stack: (parent index, direction, remaining length, depth, target, attraction)
        let mut stack = vec![(0usize, d, len, 0u8, target, 1.0f32)];
        while let Some((mut par, mut dir, mut left, depth, tgt, att)) = stack.pop() {
            let wd = 0.6f32.powi(depth as i32);
            let mut n = 0;
            while left > 0.0 && nodes.len() < NODE_CAP / 2 {
                let p = nodes[par].p;
                let tv = norm2([tgt[0] - p[0], tgt[1] - p[1]]);
                let guide = norm2([tv[0] * att + dir[0] * 0.8, tv[1] * att + dir[1] * 0.8]);
                let nd = rot(guide, self.rng.gauss() * 0.55);
                let l = step * self.rng.range(0.7, 1.3);
                let q = [p[0] + nd[0] * l, p[1] + nd[1] * l];
                nodes.push(Node { p: q, parent: par as i32, jit: [self.rng.gauss() * 0.3, self.rng.gauss() * 0.3], w: wd, depth, alive: true });
                par = nodes.len() - 1;
                dir = nd;
                left -= l;
                n += 1;
                if q[0] < -step * 4.0 || q[1] < -step * 4.0 || q[0] > w + step * 4.0 || q[1] > h + step * 4.0 {
                    break;
                }
                if depth < 3 && n > 2 && self.rng.f() < branch * 0.07 * (1.0 - 0.25 * depth as f32) {
                    let a = self.rng.range(0.35, 0.9) * if self.rng.f() < 0.5 { -1.0 } else { 1.0 };
                    let bd = rot(dir, a);
                    let bl = left * self.rng.range(0.15, 0.5);
                    let bt = [q[0] + bd[0] * bl * 2.0, q[1] + bd[1] * bl * 2.0];
                    stack.push((par, bd, bl, depth + 1, bt, 0.3));
                }
            }
        }
        let life = self.p[P_LIFE] * self.rng.range(0.7, 1.3);
        self.bolts.push(Bolt { nodes, age: 0.0, life, pulse: 1.0, temp: self.p[P_TEMP] });
        self.strikes += 1;
    }

    fn update_bolt(&mut self, bi: usize, dt: f32) {
        let step = self.step_len();
        let flow = self.p[P_FLOW] * (1.0 + 1.5 * self.p[P_MIC]);
        let crackle_tau = 0.08f32;
        let ou_k = (-dt / crackle_tau).exp();
        let ou_s = (1.0 - ou_k * ou_k).sqrt() * 0.45;
        let mut nodes = std::mem::take(&mut self.bolts[bi].nodes);
        // RK2 advection through the incompressible flow
        for nd in nodes.iter_mut() {
            if !nd.alive {
                continue;
            }
            let v1 = self.velocity(nd.p, usize::MAX);
            let mid = [nd.p[0] + v1[0] * dt * flow * 0.5, nd.p[1] + v1[1] * dt * flow * 0.5];
            let v2 = self.velocity(mid, usize::MAX);
            nd.p[0] += v2[0] * dt * flow;
            nd.p[1] += v2[1] * dt * flow;
            nd.jit[0] = nd.jit[0] * ou_k + ou_s * self.rng.gauss();
            nd.jit[1] = nd.jit[1] * ou_k + ou_s * self.rng.gauss();
        }
        // topology helpers
        let n = nodes.len();
        self.kids.clear();
        self.kids.resize(n, 0);
        self.first_child.clear();
        self.first_child.resize(n, -1);
        for i in 0..n {
            if nodes[i].alive && nodes[i].parent >= 0 {
                let p = nodes[i].parent as usize;
                self.kids[p] = self.kids[p].saturating_add(1);
                if self.first_child[p] < 0 {
                    self.first_child[p] = i as i32;
                }
            }
        }
        // surface tension: pull chain-interior nodes toward the mean of their neighbours
        let k = (self.p[P_TENSION] * dt * 12.0).min(0.5);
        if k > 0.0 {
            for i in 0..n {
                if !nodes[i].alive || nodes[i].parent < 0 || self.kids[i] != 1 {
                    continue;
                }
                let a = nodes[nodes[i].parent as usize].p;
                let b = nodes[self.first_child[i] as usize].p;
                let p = &mut nodes[i].p;
                p[0] += k * ((a[0] + b[0]) * 0.5 - p[0]);
                p[1] += k * ((a[1] + b[1]) * 0.5 - p[1]);
            }
        }
        // resample: split stretched links, merge compressed ones (keeps strands continuous)
        for i in 0..n {
            if !nodes[i].alive || nodes[i].parent < 0 {
                continue;
            }
            let pi = nodes[i].parent as usize;
            let a = nodes[pi].p;
            let b = nodes[i].p;
            let d = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
            if d > step * 1.7 && nodes.len() < NODE_CAP {
                let m = Node {
                    p: [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5],
                    parent: pi as i32,
                    jit: [self.rng.gauss() * 0.3, self.rng.gauss() * 0.3],
                    w: nodes[i].w,
                    depth: nodes[i].depth,
                    alive: true,
                };
                nodes.push(m);
                nodes[i].parent = (nodes.len() - 1) as i32;
            } else if d < step * 0.35 && self.kids[i] == 1 {
                let c = self.first_child[i] as usize;
                if nodes[c].alive && nodes[c].parent == i as i32 {
                    nodes[c].parent = pi as i32;
                    nodes[i].alive = false;
                }
            }
        }
        // compact once there is too much garbage
        let dead = nodes.iter().filter(|x| !x.alive).count();
        if dead > 200 && dead * 3 > nodes.len() {
            let mut remap = vec![-1i32; nodes.len()];
            let mut out = Vec::with_capacity(nodes.len() - dead);
            for (i, nd) in nodes.iter().enumerate() {
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
            nodes = out;
        }
        let full = nodes.len() >= NODE_CAP;
        self.bolts[bi].nodes = nodes;
        if full {
            // chaotic advection stretches strands exponentially; once the budget is used
            // up the bolt cools and fades instead of being over-stretched
            let b = &mut self.bolts[bi];
            let end = b.age + 1.2;
            if b.life > end {
                b.life = end;
            }
        }

        // light: return-stroke flash, random re-strikes, cooling at the end of life
        let rate = self.p[P_RESTRIKE] * (1.0 + 3.0 * self.p[P_MIC]);
        let b = &mut self.bolts[bi];
        b.age += dt;
        b.pulse *= (-dt / 0.12).exp();
        if self.rng.f() < rate * dt {
            b.pulse = b.pulse.max(self.rng.range(0.5, 1.0));
            self.restrikes += 1;
        }
        let tp = self.p[P_TEMP];
        let flash = (-b.age / 0.15).exp();
        let mut t = tp * (0.42 + 0.58 * flash.max(b.pulse));
        let fade_start = b.life * 0.65;
        if b.age > fade_start {
            let f = ((b.life - b.age) / (b.life - fade_start)).clamp(0.0, 1.0);
            // cools through the black-body sequence: blue-white → white → yellow → orange → red
            t = 1200.0 + (t - 1200.0) * f * f;
        }
        b.temp = t;
    }

    fn step(&mut self, dt: f32) -> u32 {
        let dt = dt.clamp(0.0, 0.05);
        self.time += dt;
        self.strikes = 0;
        self.restrikes = 0;
        if dt > 0.0 {
            let pv = [(self.pointer[0] - self.pointer_prev[0]) / dt, (self.pointer[1] - self.pointer_prev[1]) / dt];
            self.pointer_vel = [self.pointer_vel[0] * 0.6 + pv[0] * 0.4, self.pointer_vel[1] * 0.6 + pv[1] * 0.4];
        }
        self.pointer_prev = self.pointer;
        self.ensure_vortices();
        self.move_vortices(dt);
        self.build_sources();
        let want = (self.p[P_BOLTS] as usize).clamp(0, MAX_BOLTS);
        // stagger new bolts so they don't all strike at once
        self.spawn_t -= dt;
        if self.bolts.len() < want && self.spawn_t <= 0.0 {
            self.spawn_bolt(None);
            self.spawn_t = self.rng.range(0.15, 0.6) / (1.0 + 2.0 * self.p[P_MIC]);
        }
        for i in 0..self.bolts.len() {
            self.update_bolt(i, dt);
        }
        self.bolts.retain(|b| b.age < b.life);
        self.emit()
    }

    fn emit(&mut self) -> u32 {
        let step = self.step_len();
        let crackle = self.p[P_CRACKLE];
        let mut k = 0usize;
        let mut act = 0.0f32;
        let (mut cx, mut cy) = (0.0f32, 0.0f32);
        for b in self.bolts.iter() {
            let n = b.nodes.len();
            let mut has_child = vec![false; n];
            for nd in b.nodes.iter() {
                if nd.alive && nd.parent >= 0 {
                    has_child[nd.parent as usize] = true;
                }
            }
            let jp = |nd: &Node| -> [f32; 2] { [nd.p[0] + nd.jit[0] * step * crackle, nd.p[1] + nd.jit[1] * step * crackle] };
            for (i, nd) in b.nodes.iter().enumerate() {
                if !nd.alive || nd.parent < 0 || k >= MAX_SEGS {
                    continue;
                }
                let par = &b.nodes[nd.parent as usize];
                let a = jp(par);
                let c = jp(nd);
                if (nd.p[0] - par.p[0]).hypot(nd.p[1] - par.p[1]) > step * 3.5 {
                    continue; // over-stretched link of a bolt that is already fading out
                }
                let t = (b.temp * (1.0 - 0.18 * nd.depth as f32)).max(1000.0);
                let o = k * SEG_FLOATS;
                let out = &mut self.out[o..o + SEG_FLOATS];
                out[0] = a[0];
                out[1] = a[1];
                out[2] = c[0];
                out[3] = c[1];
                out[4] = t;
                out[5] = if has_child[i] { nd.w } else { -nd.w };
                out[6] = 1.0;
                out[7] = nd.depth as f32;
                let len = (c[0] - a[0]).hypot(c[1] - a[1]);
                let rad = (t / 10_000.0).powi(4) * nd.w * len;
                act += rad;
                cx += rad * c[0];
                cy += rad * c[1];
                k += 1;
            }
        }
        if act > 0.0 {
            cx /= act;
            cy /= act;
        }
        let sc = self.scale();
        self.info[0] = self.strikes as f32;
        self.info[1] = self.restrikes as f32;
        self.info[2] = act / (sc * 60.0);
        self.info[3] = cx;
        self.info[4] = cy;
        self.info[5] = self.bolts.len() as f32;
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
    if (s.w - w).abs() > 0.5 || (s.h - h).abs() > 0.5 {
        let (sx, sy) = (w / s.w, h / s.h);
        for b in s.bolts.iter_mut() {
            for n in b.nodes.iter_mut() {
                n.p[0] *= sx;
                n.p[1] *= sy;
            }
        }
        for v in s.vort.iter_mut() {
            v.p[0] *= sx;
            v.p[1] *= sy;
        }
        s.vort.clear(); // re-seed with the new scale
        s.w = w.max(1.0);
        s.h = h.max(1.0);
    }
}
#[no_mangle]
pub extern "C" fn set_pointer(x: f32, y: f32, down: u32) {
    let s = sim();
    if !s.pointer_down && down != 0 {
        s.pointer_prev = [x, y];
        s.pointer_vel = [0.0; 2];
    }
    s.pointer = [x, y];
    s.pointer_down = down != 0;
}
/// Strike a new bolt from (x, y).
#[no_mangle]
pub extern "C" fn strike_at(x: f32, y: f32) {
    let s = sim();
    if s.bolts.len() >= MAX_BOLTS {
        // replace the oldest bolt
        let oldest = (0..s.bolts.len()).max_by(|&a, &b| s.bolts[a].age.partial_cmp(&s.bolts[b].age).unwrap()).unwrap();
        s.bolts.remove(oldest);
    }
    s.spawn_bolt(Some([x, y]));
}
#[no_mangle]
pub extern "C" fn strike() {
    let s = sim();
    if s.bolts.len() >= MAX_BOLTS {
        s.bolts.remove(0);
    }
    s.spawn_bolt(None);
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
