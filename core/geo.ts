/**
 * Coarse location. We keep a geohash-5 cell (roughly 5 km x 5 km) and throw the
 * coordinates away, so the database never holds where someone actually is.
 * This is what makes location search workable on D1 (decision D-003).
 */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function geohashEncode(lat: number, lon: number, precision = 5): string {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let hash = "", bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { ch = (ch << 1) | 1; lonMin = mid; } else { ch <<= 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; } else { ch <<= 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

export function geohashCentre(hash: string): { lat: number; lon: number } | null {
  if (!hash) return null;
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180, even = true;
  for (const c of hash) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) return null;
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (even) { const mid = (lonMin + lonMax) / 2; if (idx & mask) lonMin = mid; else lonMax = mid; }
      else { const mid = (latMin + latMax) / 2; if (idx & mask) latMin = mid; else latMax = mid; }
      even = !even;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function cellDistanceKm(cellA: string, cellB: string): number | null {
  const a = geohashCentre(cellA);
  const b = geohashCentre(cellB);
  return a && b ? Math.round(distanceKm(a, b)) : null;
}

/** Coarse cell for a coordinate: the geohash and its centre in milli-degrees. The input is then discarded. */
export function coarseCell(lat: number, lon: number): { geoCell: string; cellLat: number; cellLon: number } {
  const geoCell = geohashEncode(lat, lon, 5);
  const c = geohashCentre(geoCell)!;
  return { geoCell, cellLat: Math.round(c.lat * 1000), cellLon: Math.round(c.lon * 1000) };
}

/** Bounding box (milli-degrees) around a cell centre for an indexed SQL pre-filter; exact distance is applied after. */
export function boundingBox(cellLat: number, cellLon: number, km: number): { latMin: number; latMax: number; lonMin: number; lonMax: number } {
  const lat = cellLat / 1000;
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return {
    latMin: Math.floor((lat - dLat) * 1000), latMax: Math.ceil((lat + dLat) * 1000),
    lonMin: Math.floor((cellLon / 1000 - dLon) * 1000), lonMax: Math.ceil((cellLon / 1000 + dLon) * 1000),
  };
}

/** UK launch (open decision: "UK only"). Used when a member declines browser location. */
export const UK_AREAS: { label: string; lat: number; lon: number }[] = [
  { label: "London", lat: 51.5074, lon: -0.1278 }, { label: "Birmingham", lat: 52.4862, lon: -1.8904 },
  { label: "Manchester", lat: 53.4808, lon: -2.2426 }, { label: "Leeds", lat: 53.8008, lon: -1.5491 },
  { label: "Liverpool", lat: 53.4084, lon: -2.9916 }, { label: "Newcastle", lat: 54.9783, lon: -1.6178 },
  { label: "Sheffield", lat: 53.3811, lon: -1.4701 }, { label: "Bristol", lat: 51.4545, lon: -2.5879 },
  { label: "Nottingham", lat: 52.9548, lon: -1.1581 }, { label: "Leicester", lat: 52.6369, lon: -1.1398 },
  { label: "Southampton", lat: 50.9097, lon: -1.4044 }, { label: "Brighton", lat: 50.8225, lon: -0.1372 },
  { label: "Norwich", lat: 52.6309, lon: 1.2974 }, { label: "Cambridge", lat: 52.2053, lon: 0.1218 },
  { label: "Oxford", lat: 51.752, lon: -1.2577 }, { label: "Luton", lat: 51.8787, lon: -0.42 },
  { label: "Plymouth", lat: 50.3755, lon: -4.1427 }, { label: "Cardiff", lat: 51.4816, lon: -3.1791 },
  { label: "Swansea", lat: 51.6214, lon: -3.9436 }, { label: "Edinburgh", lat: 55.9533, lon: -3.1883 },
  { label: "Glasgow", lat: 55.8642, lon: -4.2518 }, { label: "Aberdeen", lat: 57.1497, lon: -2.0943 },
  { label: "Dundee", lat: 56.462, lon: -2.9707 }, { label: "Inverness", lat: 57.4778, lon: -4.2247 },
  { label: "Belfast", lat: 54.5973, lon: -5.9301 }, { label: "Derry", lat: 54.9966, lon: -7.3086 },
];

/** Great Britain + Northern Ireland bounding box, used to enforce the UK-only launch on supplied coordinates. */
export function isInUk(lat: number, lon: number): boolean {
  return lat >= 49.8 && lat <= 60.9 && lon >= -8.7 && lon <= 1.8;
}
