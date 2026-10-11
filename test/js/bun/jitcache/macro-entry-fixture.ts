// The entry point macro-build-fixture.js bundles: the bundler inlines what the macro returns.
import { answer } from "./macro-fixture.ts" with { type: "macro" };

console.log(answer());
