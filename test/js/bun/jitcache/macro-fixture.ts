// A macro that macro-entry-fixture.ts imports. The bundler runs it in a VM of its own, so it returns 42; run in the
// main thread's VM, whose execution context id is 1, it would return 0, and jitcache.test.ts would see that the macro
// never ran in a VM apart from the main one.
export function answer() {
  return Bun.isMainThread ? 0 : 6 * 7;
}
