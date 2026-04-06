export interface GraphNode<K, V> {
  data: V;
  referees: Set<K>;
  referrers: Set<K>;
}

/**
 * Directed graph: one map entry per vertex holds both referee and referrer sets.
 */
export class BidirectedGraph<K, V> {
  private readonly nodes = new Map<K, GraphNode<K, V>>();

  getVertex(k: K): GraphNode<K, V> | undefined {
    return this.nodes.get(k);
  }

  hasVertex(k: K): boolean {
    return this.nodes.has(k);
  }

  addVertex(k: K, v: V): GraphNode<K, V> {
    const existing = this.nodes.get(k);
    if (existing) return existing;

    const node: GraphNode<K, V> = { data: v, referees: new Set(), referrers: new Set() };
    this.nodes.set(k, node);
    return node;
  }

  removeVertex(k: K): void {
    const n = this.nodes.get(k);
    if (!n) return;

    if (this.nodes.delete(k)) {
      for (const to of n.referees) this.removeEdge(k, to);
      for (const from of n.referrers) this.removeEdge(from, k);
    }
  }

  /** Directed arc `from → to`. */
  addEdge(from: K, to: K): void {
    const a = this.nodes.get(from);
    const b = this.nodes.get(to);

    if (a && b) {
      a.referees.add(to);
      b.referrers.add(from);
    } else {
      throw new Error("vertices do not exist");
    }
  }

  removeEdge(from: K, to: K): void {
    const a = this.nodes.get(from);
    if (a) a.referees.delete(to);
    const b = this.nodes.get(to);
    if (b) b.referrers.delete(from);
  }

  hasEdge(from: K, to: K): boolean {
    return this.nodes.get(from)?.referees.has(to) ?? false;
  }

  /** Vertices that `k` refers to (`k → *`). */
  *referees(k: K): Generator<K, void, undefined> {
    const s = this.nodes.get(k)?.referees;
    if (s) yield* s;
  }

  /** Vertices that refer to `k` (`* → k`). */
  *referrers(k: K): Generator<K, void, undefined> {
    const s = this.nodes.get(k)?.referrers;
    if (s) yield* s;
  }

  *vertices(): Generator<K, void, undefined> {
    yield* this.nodes.keys();
  }

  entries() {
    return this.nodes.entries();
  }

  get vertexCount(): number {
    return this.nodes.size;
  }

  /** Number of directed arcs. */
  get edgeCount(): number {
    let n = 0;
    for (const { referees } of this.nodes.values()) n += referees.size;
    return n;
  }

  clear(): void {
    this.nodes.clear();
  }
}
