// The app jitcache.test.ts runs with JITCache and without it. It prints only what does not depend on JITCache, so a
// consumer's output must equal a JITCache-off run's. Arguments:
//   worker        also runs lib-fixture.js in a worker, writing the worker's threadId to standard error
//   chdir=<path>  changes the working directory before it starts the worker
import { Worker } from "node:worker_threads";
import { run } from "./lib-fixture.js";

const lines = [`main ${run(60)}`];

const chdir = process.argv.find(argument => argument.startsWith("chdir="));
if (chdir) process.chdir(chdir.slice("chdir=".length));

if (process.argv.includes("worker")) {
  const worker = new Worker(new URL("./worker-fixture.js", import.meta.url));
  // A worker VM's report paths end with .<executionContextId>, which is its threadId plus one.
  console.error(`threadId ${worker.threadId}`);
  const result = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  await new Promise(resolve => worker.once("exit", resolve));
  lines.push(`worker ${result}`);
}

console.log(lines.join("\n"));
