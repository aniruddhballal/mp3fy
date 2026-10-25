/** Return the order in which a looping playlist reaches tracks after the current one. */
export function upcomingFrom<T>(queue: readonly T[], currentIndex: number): T[] {
  if (currentIndex < 0 || currentIndex >= queue.length) return [];
  return [...queue.slice(currentIndex + 1), ...queue.slice(0, currentIndex)];
}

/** Move an upcoming track without changing the current track. */
export function moveUpcoming<T>(upcoming: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= upcoming.length || to < 0 || to >= upcoming.length || from === to) return [...upcoming];
  const next = [...upcoming];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
