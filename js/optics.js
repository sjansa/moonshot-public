// optics.js -- sensors, focal lengths, field of view. No DOM.
export const SENSORS = [   // width x height in mm, landscape
  { id: 'ff', name: 'Full frame', w: 36, h: 24 },
  { id: 'apsc', name: 'APS-C (Nikon, Sony, Fuji)', w: 23.5, h: 15.6 },
  { id: 'apsc-c', name: 'APS-C (Canon)', w: 22.3, h: 14.9 },
  { id: 'mft', name: 'Micro Four Thirds', w: 17.3, h: 13 },
  { id: 'one', name: '1 inch', w: 13.2, h: 8.8 },
  { id: 'mf', name: 'Medium format 44x33', w: 43.8, h: 32.9 },
];
export const FOCALS = [14, 20, 24, 35, 50, 85, 135, 200, 300, 400, 600, 800];

/** {w, h} in mm as held. */
export function frameSize(sensor, portrait) {
  return portrait ? { w: sensor.h, h: sensor.w } : { w: sensor.w, h: sensor.h };
}

/** Field of view in degrees: 2 * atan(size / (2 * focal)). */
export function fovDeg(sizeMm, focalMm) {
  return 2 * Math.atan(sizeMm / (2 * focalMm)) * 180 / Math.PI;
}
