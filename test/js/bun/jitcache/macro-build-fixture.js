// Bundles macro-entry-fixture.ts with Bun.build and prints the bundle, for jitcache.test.ts's macro test. Bun's bundler
// parses on the threads of its worker pool, where no VM runs, so Macro::init creates a VM for the macro on that thread,
// with the execution context id INT32_MAX, in a process whose JITCache flags Bun parsed.
const build = await Bun.build({ entrypoints: [`${import.meta.dir}/macro-entry-fixture.ts`] });
if (!build.success) throw new AggregateError(build.logs, "Bun.build failed");
console.log(await build.outputs[0].text());
