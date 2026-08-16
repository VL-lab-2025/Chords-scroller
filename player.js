// player.js — the autoscroll engine and screen wake lock.
//
// Scrolling uses a requestAnimationFrame loop with a fractional position
// accumulator driving a GPU-composited transform. Incrementing scrollTop
// instead would quantise to whole pixels, which visibly stutters at the slow
// speeds (10-30 px/s) this app actually runs at.

export function createPlayer({ viewport, content, onTick, onEnd, onStateChange }) {
  let position = 0;        // fractional pixels scrolled
  let speed = 25;          // px per second
  let playing = false;
  let rafId = null;
  let lastFrame = 0;
  let leadInLeft = 0;      // seconds of countdown remaining before motion starts

  const state = {
    get playing() { return playing; },
    get position() { return position; },
    get speed() { return speed; },
    get leadIn() { return leadInLeft; },
  };

  function maxScroll() {
    // Stop with the last line resting near the top of the screen rather than
    // scrolling it off the bottom edge.
    const overflow = content.scrollHeight - viewport.clientHeight;
    return Math.max(0, overflow + viewport.clientHeight * 0.45);
  }

  function apply() {
    content.style.transform = `translate3d(0, ${-position.toFixed(2)}px, 0)`;
  }

  function notify() {
    if (onStateChange) onStateChange(state);
  }

  function frame(now) {
    if (!playing) return;
    if (!lastFrame) lastFrame = now;
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    // A backgrounded tab can hand back a huge delta; don't teleport the song.
    if (dt > 0.25) dt = 0.25;

    if (leadInLeft > 0) {
      leadInLeft = Math.max(0, leadInLeft - dt);
      if (onTick) onTick(state);
      rafId = requestAnimationFrame(frame);
      if (leadInLeft === 0) notify();
      return;
    }

    position += speed * dt;
    const limit = maxScroll();
    if (position >= limit) {
      position = limit;
      apply();
      pause();
      if (onEnd) onEnd();
      return;
    }
    apply();
    if (onTick) onTick(state);
    rafId = requestAnimationFrame(frame);
  }

  function play(leadInSeconds = 0) {
    if (playing) return;
    if (position >= maxScroll()) position = 0;
    leadInLeft = Math.max(0, leadInSeconds || 0);
    playing = true;
    lastFrame = 0;
    rafId = requestAnimationFrame(frame);
    acquireWakeLock();
    notify();
  }

  function pause() {
    if (!playing) return;
    playing = false;
    leadInLeft = 0;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    releaseWakeLock();
    notify();
  }

  function toggle(leadInSeconds = 0) {
    playing ? pause() : play(leadInSeconds);
  }

  function reset() {
    position = 0;
    apply();
    notify();
  }

  function setSpeed(v) {
    speed = Math.min(200, Math.max(1, v));
    notify();
  }

  /** Move by a pixel delta, clamped — used by nudge buttons and touch drag. */
  function moveBy(px) {
    position = Math.min(maxScroll(), Math.max(0, position + px));
    apply();
    notify();
  }

  function seekFraction(f) {
    position = Math.min(maxScroll(), Math.max(0, maxScroll() * f));
    apply();
    notify();
  }

  function progress() {
    const limit = maxScroll();
    return limit > 0 ? Math.min(1, position / limit) : 0;
  }

  // --- touch drag to find your place while paused --------------------------
  let dragging = false;
  let dragStartY = 0;
  let dragStartPos = 0;
  let dragMoved = 0;

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    dragging = true;
    dragMoved = 0;
    dragStartY = e.touches[0].clientY;
    dragStartPos = position;
  }

  function onTouchMove(e) {
    if (!dragging || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - dragStartY;
    dragMoved = Math.max(dragMoved, Math.abs(dy));
    if (dragMoved > 6) {
      position = Math.min(maxScroll(), Math.max(0, dragStartPos - dy));
      apply();
      if (e.cancelable) e.preventDefault();
    }
  }

  function onTouchEnd() {
    dragging = false;
    notify();
  }

  viewport.addEventListener('touchstart', onTouchStart, { passive: true });
  viewport.addEventListener('touchmove', onTouchMove, { passive: false });
  viewport.addEventListener('touchend', onTouchEnd, { passive: true });
  viewport.addEventListener('touchcancel', onTouchEnd, { passive: true });

  /** True if the last touch was a drag rather than a tap (so taps can toggle). */
  const wasDrag = () => dragMoved > 6;

  function destroy() {
    pause();
    viewport.removeEventListener('touchstart', onTouchStart);
    viewport.removeEventListener('touchmove', onTouchMove);
    viewport.removeEventListener('touchend', onTouchEnd);
    viewport.removeEventListener('touchcancel', onTouchEnd);
  }

  return {
    state, play, pause, toggle, reset, setSpeed, moveBy,
    seekFraction, progress, maxScroll, apply, wasDrag, destroy,
  };
}

// ---------------------------------------------------------------------------
// Screen wake lock
//
// Without this the phone dims and locks mid-song, which makes the whole app
// pointless. Supported in iOS Safari 16.4+.
// ---------------------------------------------------------------------------

let wakeLock = null;
let wantWakeLock = false;

export const wakeLockSupported = () => 'wakeLock' in navigator;

async function acquireWakeLock() {
  wantWakeLock = true;
  if (!wakeLockSupported() || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    wakeLock = null; // denied (e.g. low power mode) — not fatal
  }
}

function releaseWakeLock() {
  wantWakeLock = false;
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// iOS drops the lock whenever the app is backgrounded; take it back on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWakeLock) acquireWakeLock();
});
