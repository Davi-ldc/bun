// The worker of jitcache.test.ts's app: it runs the bodies the main thread runs and posts the result.
import { parentPort } from "node:worker_threads";
import { run } from "./lib-fixture.js";

parentPort.postMessage(run(60));
