// Supabase Edge Function: parse-booking-screenshot
// -----------------------------------------------------------------------------
// Receives a POST with a base64-encoded screenshot of a fitness-class booking
// confirmation and uses the Anthropic Messages API (vision) to extract structured
// fields, so the Post-a-Spot form can be pre-filled instead of typed by hand.
//
// Request body (JSON):
//   { "imageBase64": "<base64, no data: prefix>", "mediaType": "image/png" }
//
// Response (JSON): the extracted object, e.g.
//   { studio, title, class_type, scheduled_date, scheduled_time,
//     location, class_level, instructor }  (any missing field is null)
//
// Env (set with `supabase secrets set`):
//   ANTHROPIC_API_KEY - Anthropic API key (never returned or logged)
// -----------------------------------------------------------------------------

// Called from the browser, so CORS must be handled (incl. the OPTIONS preflight).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "content-type": "application/json" };

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

// The allowed class_type values, mirrored in the prompt.
const CLASS_TYPES = [
  "Yoga",
  "Spin",
  "Pilates",
  "HIIT",
  "Barre",
  "Cycling",
  "Boxing",
  "Dance",
  "Strength",
  "Other",
];

const EXTRACTION_PROMPT = `You are extracting details from a screenshot of a fitness class booking confirmation.

Return ONLY a single JSON object and nothing else — no prose, no explanation, no markdown code fences.

The object must have exactly these keys:
- "studio": the studio/gym name
- "title": the class name (e.g. "Morning Flow")
- "class_type": MUST be exactly one of: ${CLASS_TYPES.join(", ")}
- "scheduled_date": the class date as "YYYY-MM-DD"
- "scheduled_time": the class start time in 24-hour format as "HH:MM"
- "location": the studio address or location
- "class_level": the difficulty/level if shown
- "instructor": the instructor's name

Rules:
- If a field is not clearly present in the image, use null. Do NOT guess or invent values.
- "class_type" must be one of the listed values exactly; if none clearly applies, use "Other".
- Output valid JSON with double-quoted keys and string or null values only.`;

// Strip accidental ```json ... ``` (or plain ```) fences Claude may add.
function stripCodeFences(text: string): string {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = t.match(fence);
  if (match) t = match[1].trim();
  return t;
}

Deno.serve(async (req) => {
  // 0. CORS preflight — MUST be the very first thing, before any auth, body
  //    parsing, or env reads, and must return an OK (200) status with the CORS
  //    headers or the browser blocks the real request.
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST." }),
      { status: 405, headers: jsonHeaders },
    );
  }

  try {
    // 1. Read the API key and validate input.
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      // Config problem, not the caller's fault — don't leak any key details.
      console.error("parse-booking-screenshot: ANTHROPIC_API_KEY is not set");
      return new Response(
        JSON.stringify({ error: "Server is not configured for image parsing." }),
        { status: 500, headers: jsonHeaders },
      );
    }

    let body: { imageBase64?: unknown; mediaType?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Request body must be valid JSON." }),
        { status: 400, headers: jsonHeaders },
      );
    }

    const imageBase64 =
      typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
    const mediaType =
      typeof body.mediaType === "string" && body.mediaType
        ? body.mediaType
        : "image/png";

    if (!imageBase64) {
      return new Response(
        JSON.stringify({ error: "No image provided. Send `imageBase64`." }),
        { status: 400, headers: jsonHeaders },
      );
    }

    // 2. Call the Anthropic Messages API with a vision request.
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: imageBase64,
                },
              },
              { type: "text", text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      // Log status only — never the key or full auth context.
      const detail = await anthropicRes.text();
      console.error(
        `parse-booking-screenshot: Anthropic API ${anthropicRes.status}: ${detail}`,
      );
      return new Response(
        JSON.stringify({ error: "Image parsing service failed." }),
        { status: 502, headers: jsonHeaders },
      );
    }

    const completion = await anthropicRes.json();

    // 4. Pull the text block from the response.
    const rawText: string =
      Array.isArray(completion?.content)
        ? completion.content
            .filter((b: { type?: string }) => b?.type === "text")
            .map((b: { text?: string }) => b?.text ?? "")
            .join("")
            .trim()
        : "";

    if (!rawText) {
      console.error("parse-booking-screenshot: no text block in model response");
      return new Response(
        JSON.stringify({ error: "Model returned no text to parse." }),
        { status: 422, headers: jsonHeaders },
      );
    }

    const cleaned = stripCodeFences(rawText);

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Hand back the raw text so the caller can debug the model output.
      return new Response(
        JSON.stringify({
          error: "Could not parse model output as JSON.",
          raw: rawText,
        }),
        { status: 422, headers: jsonHeaders },
      );
    }

    // 5. Return the parsed object.
    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err) {
    // Catch-all: clear message, no key exposure.
    console.error("parse-booking-screenshot: unexpected error", err);
    return new Response(
      JSON.stringify({ error: "Unexpected error while parsing the image." }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
