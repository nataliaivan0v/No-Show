// Shared geocoding helper for edge functions.
// -----------------------------------------------------------------------------
// This is the ONLY place the Nominatim fetch happens. index.ts imports
// geocodeAddress() from here — there is no duplicate fetch anywhere else.
//
// Turns an address string into { lat, lng } using the free Nominatim / OpenStreetMap
// API. Best-effort: returns null on no result or any error, and NEVER throws.
//
// Nominatim REQUIRES a descriptive User-Agent — default/stock HTTP-client UAs (like
// the edge runtime's) are rejected, which shows up as empty results. Override the UA
// with the GEOCODER_USER_AGENT secret; the default below identifies this app. Put a
// real contact in it for production.
// -----------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

const USER_AGENT =
  Deno.env.get("GEOCODER_USER_AGENT") ??
  "no-show/1.0 (contact: admin@example.com)";

export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const query = address?.trim();
  if (!query) {
    console.log("geocodeAddress: empty address — skipping");
    return null;
  }

  // URL: https://nominatim.openstreetmap.org/search?format=json&q=<encoded>&limit=1
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&q=" +
    encodeURIComponent(query) +
    "&limit=1";

  console.log(`geocodeAddress: address=${JSON.stringify(query)}`);
  console.log(`geocodeAddress: fetching ${url}`);
  console.log(`geocodeAddress: sending User-Agent=${JSON.stringify(USER_AGENT)}`);

  try {
    const res = await fetch(url, {
      headers: {
        // Required by Nominatim; a stock UA is the usual cause of empty results.
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    console.log(`geocodeAddress: Nominatim HTTP status ${res.status}`);

    if (!res.ok) {
      const body = await res.text();
      console.error(
        `geocodeAddress: non-OK response — body: ${body.slice(0, 500)}`,
      );
      return null;
    }

    const results = await res.json();
    console.log(
      `geocodeAddress: result count = ${
        Array.isArray(results) ? results.length : "NOT-AN-ARRAY"
      }`,
    );

    if (!Array.isArray(results) || results.length === 0) {
      console.log(
        `geocodeAddress: no usable results — raw body: ${JSON.stringify(
          results,
        ).slice(0, 500)}`,
      );
      return null;
    }

    const first = results[0];
    console.log(
      `geocodeAddress: raw first result = ${JSON.stringify(first).slice(0, 600)}`,
    );

    // Nominatim returns lat/lon as STRINGS and uses "lon" (NOT "lng").
    // Convert both to numbers and map lon -> lng for our double precision columns.
    const lat = parseFloat(first?.lat);
    const lng = parseFloat(first?.lon);
    console.log(
      `geocodeAddress: raw lat=${JSON.stringify(first?.lat)} lon=${JSON.stringify(
        first?.lon,
      )} -> numeric lat=${lat} lng=${lng}`,
    );

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      console.error("geocodeAddress: parsed coordinates are not finite numbers");
      return null;
    }

    console.log(`geocodeAddress: returning { lat: ${lat}, lng: ${lng} }`);
    return { lat, lng };
  } catch (err) {
    console.error("geocodeAddress: fetch/parse threw", err);
    return null;
  }
}
