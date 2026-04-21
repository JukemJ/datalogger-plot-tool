export function lttb(
  xs: Float64Array,
  ys: Float64Array,
  threshold: number,
  xStart?: number,
  xEnd?: number
): { x: number[]; y: number[] } {
  const n = xs.length
  if (n === 0) return { x: [], y: [] }

  let i0 = 0
  let i1 = n
  if (typeof xStart === 'number') i0 = lowerBound(xs, xStart)
  if (typeof xEnd === 'number') i1 = upperBound(xs, xEnd)
  if (i0 > 0) i0 -= 1
  if (i1 < n) i1 += 1
  if (i1 <= i0) return { x: [], y: [] }

  const len = i1 - i0
  if (len <= threshold || threshold < 3) {
    if (threshold < 3 && len >= 2) {
      return { x: [xs[i0], xs[i1 - 1]], y: [ys[i0], ys[i1 - 1]] }
    }
    const x = new Array<number>(len)
    const y = new Array<number>(len)
    for (let k = 0; k < len; k++) {
      x[k] = xs[i0 + k]
      y[k] = ys[i0 + k]
    }
    return { x, y }
  }

  const outX = new Array<number>(threshold)
  const outY = new Array<number>(threshold)
  outX[0] = xs[i0]
  outY[0] = ys[i0]

  const bucketSize = (len - 2) / (threshold - 2)
  let a = i0

  for (let i = 0; i < threshold - 2; i++) {
    const rangeStart = i0 + Math.floor((i + 1) * bucketSize) + 1
    const rangeEnd = Math.min(i0 + Math.floor((i + 2) * bucketSize) + 1, i1)
    const nextStart = rangeEnd
    const nextEnd = i === threshold - 3 ? i1 : Math.min(i0 + Math.floor((i + 3) * bucketSize) + 1, i1)

    let avgX = 0
    let avgY = 0
    const navg = Math.max(1, nextEnd - nextStart)
    if (nextEnd > nextStart) {
      for (let k = nextStart; k < nextEnd; k++) {
        avgX += xs[k]
        avgY += ys[k]
      }
      avgX /= navg
      avgY /= navg
    } else {
      avgX = xs[i1 - 1]
      avgY = ys[i1 - 1]
    }

    const ax = xs[a]
    const ay = ys[a]
    let maxArea = -1
    let chosen = rangeStart
    for (let k = rangeStart; k < rangeEnd; k++) {
      const area = Math.abs((ax - avgX) * (ys[k] - ay) - (ax - xs[k]) * (avgY - ay)) * 0.5
      if (area > maxArea) {
        maxArea = area
        chosen = k
      }
    }
    outX[i + 1] = xs[chosen]
    outY[i + 1] = ys[chosen]
    a = chosen
  }

  outX[threshold - 1] = xs[i1 - 1]
  outY[threshold - 1] = ys[i1 - 1]
  return { x: outX, y: outY }
}

function lowerBound(xs: Float64Array, t: number): number {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (xs[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(xs: Float64Array, t: number): number {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (xs[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function statsInRange(
  xs: Float64Array,
  ys: Float64Array,
  a: number,
  b: number
): { min: number; max: number; mean: number; count: number } | null {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  let i0 = 0
  let j = xs.length
  while (i0 < j) {
    const mid = (i0 + j) >>> 1
    if (xs[mid] < lo) i0 = mid + 1
    else j = mid
  }
  let i1 = i0
  j = xs.length
  while (i1 < j) {
    const mid = (i1 + j) >>> 1
    if (xs[mid] <= hi) i1 = mid + 1
    else j = mid
  }
  if (i1 <= i0) return null
  let mn = Infinity
  let mx = -Infinity
  let sum = 0
  for (let i = i0; i < i1; i++) {
    const v = ys[i]
    if (v < mn) mn = v
    if (v > mx) mx = v
    sum += v
  }
  const n = i1 - i0
  return { min: mn, max: mx, mean: sum / n, count: n }
}

export function stepSample(
  t: number,
  dir: -1 | 1,
  payloads: { timestamps: Float64Array }[]
): number | null {
  let best: number | null = null
  let bestDist = Infinity
  for (const p of payloads) {
    const xs = p.timestamps
    if (xs.length === 0) continue
    let lo = 0
    let hi = xs.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (xs[mid] <= t) lo = mid + 1
      else hi = mid
    }
    const cand = dir === 1 ? (lo < xs.length ? xs[lo] : null) : lo >= 1 ? xs[lo - 1] : null
    if (cand === null) continue
    if (dir === -1 && cand >= t) continue
    if (dir === 1 && cand <= t) continue
    const d = Math.abs(cand - t)
    if (d < bestDist) {
      bestDist = d
      best = cand
    }
  }
  return best
}

export function snapTimestamp(t: number, payloads: { timestamps: Float64Array }[]): number {
  let best = t
  let bestDist = Infinity
  for (const p of payloads) {
    const xs = p.timestamps
    if (xs.length === 0) continue
    let lo = 0
    let hi = xs.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (xs[mid] < t) lo = mid + 1
      else hi = mid
    }
    for (const i of [lo - 1, lo]) {
      if (i < 0 || i >= xs.length) continue
      const d = Math.abs(xs[i] - t)
      if (d < bestDist) {
        bestDist = d
        best = xs[i]
      }
    }
  }
  return best
}

export function sampleAt(
  xs: Float64Array,
  ys: Float64Array,
  t: number,
  nearest = false
): number | null {
  const n = xs.length
  if (n === 0) return null
  if (t <= xs[0]) return ys[0]
  if (t >= xs[n - 1]) return ys[n - 1]
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (xs[mid] <= t) lo = mid
    else hi = mid - 1
  }
  if (nearest) return ys[lo]
  const x0 = xs[lo]
  const y0 = ys[lo]
  const x1 = xs[lo + 1]
  const y1 = ys[lo + 1]
  if (x1 === x0) return y0
  return y0 + ((y1 - y0) * (t - x0)) / (x1 - x0)
}
