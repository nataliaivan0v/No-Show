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
    return {
      lat: typeof data.lat === "number" ? data.lat : null,
      lng: typeof data.lng === "number" ? data.lng : null,
    };
  } catch {
    return { lat: null, lng: null };
  }
}
