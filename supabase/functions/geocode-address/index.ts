// Supabase Edge Function: geocode-address
// -----------------------------------------------------------------------------
// Thin, browser-callable wrapper over the shared Nominatim geocoder in
// ../_shared/geocode.ts (which is the ONLY code that fetches Nominatim — this file
// does no fetching of its own). The client calls this once at write time (posting a
// spot, saving a waitlist entry), gets back { lat, lng }, and stores the coordinates.
//
// Request body (JSON):  { "address": "123 Newbury St, Boston, MA" }
// Response (JSON):       { "lat": 42.35, "lng": -71.08 }  — or { lat: null, lng: null }
//                        when the address can't be resolved (best-effort).
// -----------------------------------------------------------------------------

import { geocodeAddress } from "../_shared/geocode.ts";

// Called from the browser, so CORS (incl. the OPTIONS preflight) must be handled.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const jsonHeaders = { ...corsHeaders, "content-type": "application/json" };

Deno.serve(async (req) => {
  // Preflight first, before anything else.
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST." }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  try {
    let body: { address?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Body must be valid JSON." }),
        { status: 400, headers: jsonHeaders },
      );
    }

    const address =
      typeof body.address === "string" ? body.address.trim() : "";
    console.log(`geocode-address: received address=${JSON.stringify(address)}`);

    if (!address) {
      return new Response(
        JSON.stringify({ error: "No address provided." }),
        { status: 400, headers: jsonHeaders },
      );
    }

    // Best-effort: coords may be null if unresolved — return 200 either way so the
    // caller can still save the row (with null coordinates).
    const coords = await geocodeAddress(address);
    const payload = coords ?? { lat: null, lng: null };
    console.log(`geocode-address: returning ${JSON.stringify(payload)}`);

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err) {
    console.error("geocode-address: unexpected error", err);
    // Still 200 with nulls so a geocode hiccup never blocks a write.
    return new Response(JSON.stringify({ lat: null, lng: null }), {
      status: 200,
      headers: jsonHeaders,
    });
  }
});
