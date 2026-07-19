import { supabase } from "./supabase";

// Client-side helper: calls the geocode-address edge function to turn an address
// into coordinates. Best-effort — returns { lat: null, lng: null } on empty input,
// any error, or no match, and never throws, so a geocode failure never blocks a
// spot/waitlist write.
export async function geocode(
  address: string,
): Promise<{ lat: number | null; lng: number | null }> {
  const query = address?.trim();
  if (!query) return { lat: null, lng: null };

  try {
    const { data, error } = await supabase.functions.invoke("geocode-address", {
      body: { address: query },
    });
    if (error || !data) return { lat: null, lng: null };

    // Coerce to numbers and accept "lon" as a fallback for "lng", so a stale
    // function that returns strings or Nominatim's raw "lon" still works.
    const d = data as { lat?: unknown; lng?: unknown; lon?: unknown };
    const toNum = (v: unknown): number | null => {
      const n =
        typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const lat = toNum(d.lat);
    const lng = toNum(d.lng ?? d.lon);
    console.log("geocode(): address", query, "→", { lat, lng });
    return { lat, lng };
  } catch {
    return { lat: null, lng: null };
  }
}
