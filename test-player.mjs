// Scroll-engine tests with a stubbed DOM and a controllable clock, so the
// timing maths can be checked without a real browser.  Run: node test-player.mjs

let rafQueue = [];
let clock = 0;

globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => { rafQueue = []; };
Object.defineProperty(globalThis, 'document', {
  value: { addEventListener() {}, visibilityState: 'visible' },
  configurable: true, writable: true,
});
Object.defineProperty(globalThis, 'navigator', {
  value: {}, configurable: true, writable: true,
});

const { createPlayer } = await import('./player.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else { fail++; console.log(`FAIL ${label}${detail ? '\n  ' + detail : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function harness({ scrollHeight = 2000, clientHeight = 800 } = {}) {
  const viewport = { clientHeight, addEventListener() {}, removeEventListener() {} };
  const content = { scrollHeight, style: { transform: '' } };
  const events = { ends: 0, ticks: 0 };
  const player = createPlayer({
    viewport, content,
    onTick: () => { events.ticks++; },
    onEnd: () => { events.ends++; },
    onStateChange: () => {},
  });
  return { player, content, events };
}

/** Run `ms` of wall time in `step`-sized animation frames. */
function advance(ms, step = 16) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    clock += step;
    const queued = rafQueue;
    rafQueue = [];
    for (const fn of queued) fn(clock);
  }
}

const shownY = (content) => {
  const m = /translate3d\(0, (-?[\d.]+)px, 0\)/.exec(content.style.transform);
  return m ? Math.abs(parseFloat(m[1])) : 0;
};

// --- speed accuracy ---------------------------------------------------------
{
  const { player, content } = harness();
  player.setSpeed(30);
  player.play(0);
  advance(1000);
  ok('30 px/s scrolls ~30px in 1s', near(shownY(content), 30, 1.5), `got ${shownY(content)}`);
  advance(2000);
  ok('…and ~90px after 3s total', near(shownY(content), 90, 2), `got ${shownY(content)}`);
  player.destroy();
}

// --- sub-pixel accumulation (the reason we don't use scrollTop) -------------
{
  const { player, content } = harness();
  player.setSpeed(10);          // 0.16px per 16ms frame
  player.play(0);
  advance(160);
  const y = shownY(content);
  ok('slow speed still moves', y > 0.5, `got ${y}`);
  ok('slow speed moves sub-pixel amounts', y % 1 !== 0, `got ${y}`);
  player.destroy();
}

// --- a backgrounded tab must not teleport the song -------------------------
{
  const { player, content } = harness();
  player.setSpeed(40);
  player.play(0);
  advance(16);
  const before = shownY(content);
  advance(5000, 5000);          // one giant 5-second frame
  const jumped = shownY(content) - before;
  ok('huge frame delta is clamped', jumped <= 40 * 0.25 + 0.5, `jumped ${jumped}px`);
  player.destroy();
}

// --- lead-in countdown ------------------------------------------------------
{
  const { player, content } = harness();
  player.setSpeed(30);
  player.play(3);
  advance(1000);
  ok('no motion during lead-in', shownY(content) === 0, `got ${shownY(content)}`);
  ok('lead-in counts down', near(player.state.leadIn, 2, 0.1), `got ${player.state.leadIn}`);
  advance(2100);
  ok('lead-in ends and motion starts', shownY(content) > 0, `got ${shownY(content)}`);
  player.destroy();
}

// --- stopping at the end ----------------------------------------------------
{
  const { player, content, events } = harness({ scrollHeight: 2000, clientHeight: 800 });
  const limit = player.maxScroll();
  ok('maxScroll leaves the last line on screen', near(limit, 1200 + 360, 1), `got ${limit}`);
  player.setSpeed(200);
  player.play(0);
  advance(20000);
  ok('stops exactly at the end', near(shownY(content), limit, 0.5), `got ${shownY(content)}`);
  ok('reports end once', events.ends === 1, `got ${events.ends}`);
  ok('is paused at the end', player.state.playing === false);
  player.destroy();
}

// --- pause / reset / clamping ----------------------------------------------
{
  const { player, content } = harness();
  player.setSpeed(50);
  player.play(0);
  advance(1000);
  player.pause();
  const held = shownY(content);
  advance(1000);
  ok('paused means stopped', shownY(content) === held, `moved to ${shownY(content)}`);

  player.moveBy(-99999);
  ok('cannot scroll above the start', shownY(content) === 0);
  player.moveBy(99999);
  ok('cannot scroll past the end', near(shownY(content), player.maxScroll(), 0.5));
  ok('progress reaches 1 at the end', near(player.progress(), 1, 0.001));

  player.reset();
  ok('reset returns to the top', shownY(content) === 0);
  player.destroy();
}

// --- replay after finishing -------------------------------------------------
{
  const { player, content } = harness();
  player.setSpeed(200);
  player.play(0);
  advance(20000);                       // run to the end
  player.play(0);                       // press play again
  advance(500);
  ok('replay restarts from the top', shownY(content) < 200, `got ${shownY(content)}`);
  player.destroy();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
