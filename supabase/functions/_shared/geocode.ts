// Shared geocoding helper for edge functions.
// -----------------------------------------------------------------------------
// Turns an address string into { lat, lng } using the free Nominatim / OpenStreetMap
// API. Best-effort: returns null on no result or any error, and NEVER throws, so
// callers can always proceed (e.g. insert the row with null coordinates).
//
// Nominatim usage policy requires a descriptive User-Agent that identifies the app
// and a contact — update the CONTACT below to a real value for your deployment.
// It also rate-limits to ~1 request/second, which is fine for per-write geocoding.
// -----------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

const CONTACT = "contact: you@example.com";
const USER_AGENT = `NoShowSpotExchange/1.0 (${CONTACT})`;

export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const query = address?.trim();
  if (!query) return null;

  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
      encodeURIComponent(query);

    const res = await fetch(url, {
      headers: {
        // Required by Nominatim; requests without a real UA may be blocked.
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      console.error(`geocodeAddress: Nominatim returned ${res.status}`);
      return null;
    }

    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) {
      return null; // no match
    }

    const lat = Number(results[0]?.lat);
    const lng = Number(results[0]?.lon); // Nominatim uses "lon"
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

    return { lat, lng };
  } catch (err) {
    console.error("geocodeAddress: unexpected error", err);
    return null;
  }
}
