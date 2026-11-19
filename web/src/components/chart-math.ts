// Geometry of the time chart, kept apart from the drawing so the scales and
// the stacking can be tested without a browser.

export type Point = { unix: number; value: number | null };
export type Series = { label: string; color: string; points: Point[] };

export type Frame = {
  /// Every timestamp of every series, sorted. A series without a point at a
  /// timestamp has a gap there, not a zero.
  xs: number[];
  /// One row per series, aligned to `xs`. `null` marks a gap.
  values: (number | null)[][];
  /// Sum of the known values at each timestamp: the height of a stack.
  totals: number[];
  min: number;
  max: number;
};

/// Aligns the series on one time axis and finds the value domain.
/// `zeroBased` starts the axis at zero; without it the axis follows the data,
/// which is what a nearly full quota needs to show its slope at all.
export function frame(series: Series[], stacked: boolean, zeroBased: boolean): Frame {
  const stamps = new Set<number>();
  for (const one of series) for (const point of one.points) stamps.add(point.unix);
  const xs = [...stamps].sort((a, b) => a - b);
  // An upstream can send a malformed number: it must not poison the axis
  // with NaN or draw garbage, so it is treated as not reported.
  const clean = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const values = series.map((one) => {
    const byUnix = new Map(one.points.map((point) => [point.unix, point.value]));
    return xs.map((unix) => clean(byUnix.get(unix)));
  });
  const totals = xs.map((_, index) =>
    values.reduce((sum, row) => sum + (row[index] ?? 0), 0),
  );
  const known = stacked ? totals : values.flat().filter((value): value is number => value !== null);
  if (known.length === 0) return { xs, values, totals, min: 0, max: 1 };
  const low = Math.min(...known);
  const high = Math.max(...known);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { xs, values, totals, min: 0, max: 1 };
  if (stacked || zeroBased) {
    // A flat row still needs a domain, otherwise every point divides by zero.
    return { xs, values, totals, min: 0, max: high > 0 ? high : 1 };
  }
  // A level axis must not start at zero, or a small change is invisible. But
  // stretching the change over the whole plot height is the opposite lie: 0.03
  // out of 419 looks like a collapse. Give the domain a floor of 2% of the
  // level, so a nearly unchanged balance draws a nearly flat line and a real
  // drop still fills the plot. The badge above the chart states the change and
  // the axis range in numbers.
  // A flat series has no spread to scale: a zero balance would otherwise get
  // a domain of 1e-16 and four identical axis labels. Give it a whole unit.
  const spread = high - low;
  const reach =
    spread > 0 ? Math.max(spread, Math.abs(high) * 0.02) : Math.max(1, Math.abs(high) * 0.02);
  // low/2 + high/2, not (low + high) / 2: two huge same-sign values would
  // overflow the sum to Infinity and break every later calculation.
  const middle = low / 2 + high / 2;
  const pad = reach * 0.15;
  const min = middle - reach / 2 - pad;
  const max = middle + reach / 2 + pad;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { xs, values, totals, min: 0, max: 1 };
  return { xs, values, totals, min, max };
}

/// First and last reported value of a level series, with the change between
/// them. A zoomed axis needs this in words: a 0.03 drop out of 419 looks like
/// a crash on the plot, and only the numbers say it is 0.007%.
export function change(values: (number | null)[]): {
  from: number;
  to: number;
  delta: number;
  percent: number | null;
} | null {
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2) return null;
  const from = known[0];
  const to = known[known.length - 1];
  return {
    from,
    to,
    delta: to - from,
    percent: from === 0 ? null : ((to - from) / Math.abs(from)) * 100,
  };
}

/// Decimals that keep neighbouring axis labels apart. A span of 0.0004 must
/// not print the same number four times.
export function axisDecimals(min: number, max: number, count = 4): number {
  const step = (max - min) / Math.max(1, count);
  if (!(step > 0)) return 0;
  // Up to 14: a 1e-13-scale span needs 13 decimals to keep labels apart.
  return Math.min(14, Math.max(0, Math.ceil(-Math.log10(step)) + 1));
}

/// A round step near `raw`, so axis labels read 1, 2, 2.5, 5, 10 and not 3.7.
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/// A power of ten that makes the step an integer, so tick rounding keeps
/// neighbours apart (2.5 needs tens, 1e-11 needs 1e11).
function stepShift(step: number): number {
  for (let digits = 0; digits <= 17; digits += 1) {
    const shift = 10 ** digits;
    const scaled = step * shift;
    // Relative tolerance: an absolute one would call any tiny step an
    // integer at digits 0 and round every tick to zero.
    if (Math.abs(scaled - Math.round(scaled)) <= 1e-6 * Math.abs(scaled)) return shift;
  }
  return 1;
}

/// Grid values inside the domain, from a round step. Always at least two, so
/// a chart with one point still shows a scale.
export function ticks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return [min, max];
  const step = niceStep((max - min) / Math.max(1, count));
  const shift = stepShift(step);
  const out: number[] = [];
  // A hard cap: a broken step must not spin the loop forever, whatever the
  // values on the axis are.
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9 && out.length < 32; value += step) {
    // Repeated addition drifts; rounding to the step keeps labels clean.
    // The shift can overflow on huge values, where no rounding is needed.
    const scaled = value * shift;
    out.push(Number.isFinite(scaled) ? Math.round(scaled) / shift : value);
  }
  return out.length >= 2 ? out : [min, max];
}

/// Index of the timestamp nearest to `unix`, for the hover crosshair.
export function nearestIndex(xs: number[], unix: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < xs.length; index += 1) {
    const distance = Math.abs(xs[index] - unix);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/// Contiguous runs of indexes where every reporting series has a value. A
/// stacked band must not bridge a gap, because that would draw spend that
/// never happened. A series with no value anywhere does not report this
/// metric at all: it must not blank the bands of the series that do.
export function runs(values: (number | null)[][]): number[][] {
  const reporting = values.filter((row) => row.some((value) => value !== null));
  if (reporting.length === 0) return [];
  const width = values[0]?.length ?? 0;
  const out: number[][] = [];
  let current: number[] = [];
  for (let index = 0; index < width; index += 1) {
    const complete = reporting.every((row) => row[index] !== null);
    if (complete) current.push(index);
    else if (current.length > 0) {
      out.push(current);
      current = [];
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}