// Test clock, loaded only by execution tests. SIGUSR2 steps Date.now() back a minute.
const now = Date.now;
let offset = 0;
Date.now = () => now() + offset;
process.on("SIGUSR2", () => {
  offset -= 60_000;
  console.info("Clock stepped back.");
});
