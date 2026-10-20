/** A tiny filter_complex writer: labelled chains, fresh labels. */
export class Graph {
  readonly lines: string[] = [];
  private n = 0;

  fresh(prefix = 'v'): string {
    return `${prefix}${this.n++}`;
  }

  /** `[in]f1,f2,…[out]` — returns the output label (or `in` unchanged when there are no filters). */
  chain(input: string, filters: string[], outLabel?: string): string {
    if (!filters.length) return input;
    const out = outLabel ?? this.fresh();
    this.lines.push(`[${input}]${filters.join(',')}[${out}]`);
    return out;
  }

  /** Free-form line (multi-input filters). */
  raw(line: string): void {
    this.lines.push(line);
  }

  toString(): string {
    return this.lines.join(';\n');
  }
}
