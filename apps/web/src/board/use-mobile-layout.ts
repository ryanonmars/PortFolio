import { useEffect, useState, useSyncExternalStore } from 'react';

const mobileQuery = '(max-width: 760px), (pointer: coarse)';
const subscribe = (notify: () => void) => {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};

export function useMobileLayout() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(mobileQuery).matches,
    () => false,
  );
}

function visibleViewport() {
  const viewport = window.visualViewport;
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
    scale: viewport?.scale ?? 1,
  };
}

/** Screen-space UI bounds only; never writes the board's authored viewport. */
export function useVisualViewport() {
  const [viewport, setViewport] = useState(visibleViewport);
  useEffect(() => {
    let frame = 0;
    const settleTimers = new Set<ReturnType<typeof setTimeout>>();
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = visibleViewport();
        setViewport((current) =>
          Object.keys(next).every(
            (key) =>
              next[key as keyof typeof next] ===
              current[key as keyof typeof next],
          )
            ? current
            : next,
        );
      });
    };
    const settleViewport = () => {
      for (const timer of settleTimers) clearTimeout(timer);
      settleTimers.clear();
      resize();
      // Safari can settle keyboard and orientation bounds after the native event.
      for (const delay of [50, 150, 300, 600, 1000]) {
        const timer = setTimeout(() => {
          settleTimers.delete(timer);
          resize();
        }, delay);
        settleTimers.add(timer);
      }
    };
    document.addEventListener('focusin', settleViewport);
    document.addEventListener('focusout', settleViewport);
    window.addEventListener('resize', settleViewport);
    window.addEventListener('orientationchange', settleViewport);
    window.visualViewport?.addEventListener('resize', settleViewport);
    window.visualViewport?.addEventListener('scroll', settleViewport);
    settleViewport();
    return () => {
      cancelAnimationFrame(frame);
      for (const timer of settleTimers) clearTimeout(timer);
      document.removeEventListener('focusin', settleViewport);
      document.removeEventListener('focusout', settleViewport);
      window.removeEventListener('resize', settleViewport);
      window.removeEventListener('orientationchange', settleViewport);
      window.visualViewport?.removeEventListener('resize', settleViewport);
      window.visualViewport?.removeEventListener('scroll', settleViewport);
    };
  }, []);
  return viewport;
}
