// The bodies jitcache.test.ts's app runs, in its main thread and in its worker. run(60) calls weigh and shape 60 times
// each: with concurrent JIT off each compiles to baseline code at its 34th call, and none reaches the DFG, so a
// producer commits both at their compilations and again at its delta at exit, once their property ICs hold cases.
export function shape(i) {
  return { x: i, y: i & 7 };
}

export function weigh(point, scale) {
  return point.x * scale + point.y;
}

export function run(count) {
  let total = 0;
  for (let i = 0; i < count; ++i) total += weigh(shape(i), 3);
  return total;
}
