import type { CoolSupply, FlowFromCurveFn, WeatherCurve } from '../../shared/model';
import { clamp, round1 } from './util';

/* =====================================================================================================
 * Weather-compensated flow: the colder it is outside, the hotter the water a heat pump or boiler makes.
 * Piecewise linear between the user's points, flat beyond the ends, shifted in parallel and kept inside
 * the device limits. (−20,52)(−10,45)(0,40)(15,32) at 4.2° outdoors → 37.8°.
 * ===================================================================================================== */

export const flowFromCurve: FlowFromCurveFn = (curve: WeatherCurve, outdoorC: number) => {
  const pts = curve.points
    .filter((p) => Number.isFinite(p.outdoorC) && Number.isFinite(p.flowC))
    .sort((a, b) => a.outdoorC - b.outdoorC);
  const lo = Math.min(curve.minFlowC, curve.maxFlowC);
  const hi = Math.max(curve.minFlowC, curve.maxFlowC);
  if (!pts.length) return round1(clamp(lo + curve.shiftC, lo, hi));

  let flow: number;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (outdoorC <= first.outdoorC) flow = first.flowC;
  else if (outdoorC >= last.outdoorC) flow = last.flowC;
  else {
    flow = last.flowC;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (outdoorC <= b.outdoorC) {
        const span = b.outdoorC - a.outdoorC;
        flow = span === 0 ? b.flowC : a.flowC + ((b.flowC - a.flowC) * (outdoorC - a.outdoorC)) / span;
        break;
      }
    }
  }
  return round1(clamp(flow + curve.shiftC, lo, hi));
};

/**
 * Cooling supply that keeps every floor above the dew point: the circuit's design flow, raised to the
 * worst room's dew point plus the margin.
 */
export function coolSupplySetpoint(designC: number, maxDewC: number | null, marginC: number): number {
  return round1(maxDewC === null ? designC : Math.max(designC, maxDewC + marginC));
}

/** The flow a source asks for when it cools: its own cooling curve when it has one, else the circuit's. */
export function coolSupplyOf(curve: CoolSupply | null, fallbackC: number): number {
  return curve ? curve.flowC : fallbackC;
}
