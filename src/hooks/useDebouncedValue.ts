import { useEffect, useState } from 'react';

/**
 * The value, but only once it has stopped changing.
 *
 * Used for the counts that read every file in the project: the to-do list and
 * the project word total. Recomputing those on each keystroke is fine on a
 * two-page paper and noticeable on a thesis, and neither number needs to be
 * accurate to the millisecond.
 */
export function useDebouncedValue<T>(value: T, delay = 600): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
