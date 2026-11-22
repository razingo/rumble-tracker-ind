// The cheapest way to the rewards a player picks in an event's reward tree. A reward unlocks once any one of the
// rewards it requires is claimed, or all of them when it has requireAll. Requirements shared by several picks are paid
// once.

/** A reward's position, "row-col", which is also how rewards name their requirements. */
export const rewardKey = (r) => `${r.row}-${r.col}`;

export function rewardPlanner(rewards) {
  const byKey = new Map(rewards.map((r) => [rewardKey(r), r]));
  const requirements = (r) => (r.requires || []).map((k) => byKey.get(k)).filter(Boolean);

  // Every reward after the ones it requires (they can share a row).
  const order = [];
  const placed = new Set();
  const visit = (r, path = new Set()) => {
    if (placed.has(r) || path.has(r)) return;
    path.add(r);
    for (const req of requirements(r)) visit(req, path);
    placed.add(r);
    order.push(r);
  };
  for (const r of [...rewards].sort((a, b) => a.row - b.row || a.col - b.col)) visit(r);
  const position = new Map(order.map((r, i) => [rewardKey(r), i]));
  const normalize = (keys) => [...new Set(keys)].sort((a, b) => position.get(a) - position.get(b));

  // The cost of claiming every reward in `keys`, in order. It takes the last one. Without requirements that one is paid
  // alone; with requireAll its requirements join the set, and otherwise each requirement is tried in turn.
  const memo = new Map();
  function cheapest(keys) {
    if (!keys.length) return { cost: 0, take: [] };
    const id = keys.join(',');
    if (memo.has(id)) return memo.get(id);
    const last = byKey.get(keys[keys.length - 1]);
    const rest = keys.slice(0, -1);
    const reqs = requirements(last).map(rewardKey);
    const options = !reqs.length ? [rest] : last.requireAll ? [normalize([...rest, ...reqs])] : reqs.map((k) => normalize([...rest, k]));
    let best = { cost: Infinity, take: [] };
    for (const next of options) {
      const sub = cheapest(next);
      const cost = sub.cost + (last.cost || 0);
      if (cost < best.cost) best = { cost, take: [rewardKey(last), ...sub.take] };
    }
    memo.set(id, best);
    return best;
  }

  return {
    byKey,
    requirements,
    /** The rewards, each after the ones it requires. */
    order,
    /** The cheapest rewards that unlock all of `keys`: { cost, take: [key] }, with cost Infinity when impossible. */
    cheapest: (keys) => cheapest(normalize(keys)),
  };
}
