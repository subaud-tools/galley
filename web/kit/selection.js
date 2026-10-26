// A selection store: a set of row ids that one or more views bind to, so a
// flat list and a board of the same items show one selection. list() creates
// its own when none is passed.

export function createSelection() {
  const sel = new Set();
  const subs = new Set();
  let anchor = null;

  const notify = () => {
    const ids = [...sel];
    for (const cb of [...subs]) cb(ids);
  };
  // apply runs a change and notifies only if the set actually changed.
  const apply = fn => {
    const before = sel.size + '\u0000' + [...sel].join('\u0000');
    fn();
    if (sel.size + '\u0000' + [...sel].join('\u0000') !== before) notify();
  };

  const store = {
    ids: () => [...sel],
    has: id => sel.has(id),
    anchor: () => anchor,
    toggle(id) {
      anchor = id;
      apply(() => (sel.has(id) ? sel.delete(id) : sel.add(id)));
    },
    // range sets every id between anchorId and id (in orderedIds) to the
    // anchor's state. If either is not in orderedIds, it toggles id.
    range(anchorId, id, orderedIds) {
      const a = orderedIds.indexOf(anchorId), b = orderedIds.indexOf(id);
      if (a < 0 || b < 0) return store.toggle(id);
      const on = sel.has(anchorId);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      anchor = id;
      apply(() => {
        for (let i = lo; i <= hi; i++) on ? sel.add(orderedIds[i]) : sel.delete(orderedIds[i]);
      });
    },
    all: ids => apply(() => ids.forEach(id => sel.add(id))),
    deselect: ids => apply(() => ids.forEach(id => sel.delete(id))),
    clear() {
      anchor = null;
      apply(() => sel.clear());
    },
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
  return store;
}
