// A producer that holds its artifact's producer lock until its standard input closes, as a long-running producer would.
// Its VM took the lock before this script ran, so "ready" means the lock is held.
console.log("ready");
await Bun.stdin.text();
