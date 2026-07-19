// Supabase Edge Function: send-notification-email
// -----------------------------------------------------------------------------
// Triggered by a Supabase Database Webhook on INSERT into public.notifications.
// It emails the matched seeker that a spot just opened for them. It is strictly
// best-effort: any failure is logged and the function still returns 200 so the
// webhook does not retry forever, and so matching/claiming are never affected.
//
// NEVER include claim_info (booking secrets) in the email — those are only
// revealed in-app after the seeker actually claims the spot.
//
// Env (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically by the
// Edge runtime; the rest must be set with `supabase secrets set`):
//   SUPABASE_URL                - project URL (auto)
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (auto)
//   RESEND_API_KEY              - Resend API key
//   RESEND_FROM                 - verified sender, e.g. "No Show <notify@yourdomain.com>"
//   APP_URL                     - base URL of the app, for the "Claim it" link
// -----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shape of the Supabase Database Webhook payload (only the parts we use).
interface WebhookPayload {
  type?: string;
  table?: string;
  record?: {
    id: string;
    seeker_id: string;
    spot_id: string;
    message: string;
    status: string;
    created_at: string;
  };
}

// Minimal escape so user-entered fields can't break the HTML.
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Format the class time for humans. The DB stores UTC; we render in UTC and label
// it as such rather than silently using the server's zone.
function formatWhen(scheduledAt: string): string {
  try {
    return (
      new Date(scheduledAt).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      }) + " (UTC)"
    );
  } catch {
    return scheduledAt;
  }
}

interface SpotRow {
  studio: string;
  title: string;
  class_type: string;
  scheduled_at: string;
  location: string | null;
  class_level: string | null;
  instructor: string | null;
}

function buildEmailHtml(spot: SpotRow, appUrl: string): string {
  const when = formatWhen(spot.scheduled_at);

  // Optional detail rows — only rendered when present.
  const detailRows: Array<[string, string | null]> = [
    ["Class", spot.title],
    ["Type", spot.class_type],
    ["Studio", spot.studio],
    ["When", when],
    ["Location", spot.location],
    ["Level", spot.class_level],
    ["Instructor", spot.instructor],
  ];

  const rowsHtml = detailRows
    .filter(([, value]) => value)
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:4px 12px 4px 0;color:#888;font-size:14px;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
          <td style="padding:4px 0;color:#111;font-size:14px;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join("");

  const claimUrl = escapeHtml(appUrl || "#");

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fff8f4;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
      <div style="background:#fff;border:1px solid #f0e8e0;border-radius:16px;padding:32px;">
        <h1 style="margin:0 0 8px;font-size:22px;color:#F35C20;">A spot just opened!</h1>
        <p style="margin:0 0 20px;font-size:15px;color:#333;">
          A <strong>${escapeHtml(spot.class_type)}</strong> spot at
          <strong>${escapeHtml(spot.studio)}</strong> is available and matches your
          waitlist preferences.
        </p>

        <table style="border-collapse:collapse;margin-bottom:24px;">
          ${rowsHtml}
        </table>

        <p style="margin:0 0 24px;font-size:15px;color:#b45309;background:#fff3ee;border-radius:10px;padding:12px 14px;">
          ⏱ You have <strong>30 minutes</strong> to claim this spot before it passes
          to the next person in line.
        </p>

        <a href="${claimUrl}"
           style="display:inline-block;background:#F35C20;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 28px;border-radius:100px;">
          Claim it in the app →
        </a>

        <p style="margin:24px 0 0;font-size:12px;color:#aaa;">
          Booking details are revealed only after you claim the spot in the app.
        </p>
      </div>
    </div>
  </body>
</html>`;
}

Deno.serve(async (req) => {
  // Always respond 200 — email is best-effort and the webhook must not retry.
  const ok = (msg: string) =>
    new Response(JSON.stringify({ ok: true, msg }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const payload = (await req.json()) as WebhookPayload;
    const record = payload.record;

    // 1. Read the new notification's identifiers.
    if (!record?.seeker_id || !record?.spot_id) {
      console.warn("send-notification-email: payload missing record/ids", payload?.type);
      return ok("no record");
    }

    // Only email for freshly-created pending offers.
    if (record.status && record.status !== "pending") {
      return ok(`ignored status=${record.status}`);
    }

    // 2. Service-role client (bypasses RLS; injected env in the Edge runtime).
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      console.error("send-notification-email: missing SUPABASE_URL / SERVICE_ROLE_KEY");
      return ok("missing supabase env");
    }
    const supabase = createClient(supabaseUrl, serviceKey);

    // 3. Fetch the spot — explicitly selecting fields, never claim_info.
    const { data, error: spotError } = await supabase
      .from("spots")
      .select("studio, title, class_type, scheduled_at, location, class_level, instructor")
      .eq("id", record.spot_id)
      .single();
    const spot = data as SpotRow | null;

    if (spotError || !spot) {
      console.error("send-notification-email: spot fetch failed", spotError?.message);
      return ok("spot not found");
    }

    // 4. Look up the seeker's email via the auth admin API.
    const { data: userData, error: userError } =
      await supabase.auth.admin.getUserById(record.seeker_id);
    const toEmail = userData?.user?.email;

    if (userError) {
      console.error("send-notification-email: getUserById failed", userError.message);
      return ok("user lookup failed");
    }
    if (!toEmail) {
      console.log(`send-notification-email: no email for seeker ${record.seeker_id}, skipping`);
      return ok("no email");
    }

    // 5. Send via Resend.
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) {
      console.error("send-notification-email: RESEND_API_KEY not set");
      return ok("no resend key");
    }
    const from = Deno.env.get("RESEND_FROM") ?? "No Show <onboarding@resend.dev>";
    const appUrl = Deno.env.get("APP_URL") ?? "";

    const className = spot.title || spot.class_type;
    const subject = `A spot just opened: ${className} at ${spot.studio}`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [toEmail],
        subject,
        html: buildEmailHtml(spot, appUrl),
      }),
    });

    if (!resendRes.ok) {
      // 6. Best-effort: log and still return 200.
      const errText = await resendRes.text();
      console.error(`send-notification-email: Resend ${resendRes.status}: ${errText}`);
      return ok("resend failed");
    }

    console.log(`send-notification-email: sent to ${toEmail} for spot ${record.spot_id}`);
    return ok("sent");
  } catch (err) {
    // Never throw — email failure must not affect matching or trigger retries.
    console.error("send-notification-email: unexpected error", err);
    return ok("caught error");
  }
});
