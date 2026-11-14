import { useEffect, useRef, useState, useCallback } from 'react';

/** Re-renders every `interval` ms; returns the current timestamp. */
export function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

/**
 * Loads data and keeps it fresh. Responses that arrive out of order (e.g. a slow poll
 * landing after a newer mutation) are discarded by sequence number, so the UI never
 * jumps back to stale state.
 */
export function useLiveResource(loader, { interval = 5000, deps = [] } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await loaderRef.current();
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(e);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  /** Apply a mutation; its response becomes the new state and invalidates in-flight polls. */
  const mutate = useCallback(async (fn) => {
    const my = ++seq.current;
    const d = await fn();
    if (my === seq.current && d) setData(d);
    else if (my !== seq.current) refresh();
    return d;
  }, [refresh]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setError(null);
    refresh();
    if (!interval) return undefined;
    const tick = () => { if (document.visibilityState === 'visible') refresh(); };
    const id = setInterval(tick, interval);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
      seq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, refresh, mutate, setData };
}
