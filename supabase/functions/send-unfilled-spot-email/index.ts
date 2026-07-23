// Supabase Edge Function: send-unfilled-spot-email
// -----------------------------------------------------------------------------
// Triggered by a Supabase Database Webhook on UPDATE of public.spots. It emails the
// POSTER that No Show couldn't find anyone to take their spot.
//
// The webhook fires on every spots UPDATE, so this function only sends when the row
// TRANSITIONED into the "unfilled" state — old_record.unfilled_notified_at was null
// and record.unfilled_notified_at is now set. That transition happens exactly once,
// in mark_spot_unfilled() (SECURITY DEFINER), which guards status <> 'claimed' and
// only-set-once. Combined, the poster is emailed at most once per spot.
//
// Best-effort, exactly like send-notification-email: any failure is logged and we
// still return 200 so the webhook does not retry and matching is never affected.
//
// Env (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically by the
// Edge runtime; the rest are shared with send-notification-email):
//   SUPABASE_URL                - project URL (auto)
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (auto)
//   RESEND_API_KEY              - Resend API key
//   RESEND_FROM                 - verified sender, e.g. "No Show <notify@yourdomain.com>"
//   APP_URL                     - base URL of the app, for the "Post another" link
// -----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shape of the Supabase Database Webhook payload for a spots UPDATE (parts we use).
// NOTE: the payload carries every column including claim_info — we deliberately never
// read or send it.
interface SpotRecord {
  id: string;
  poster_id: string;
  title: string;
  class_type: string;
  studio: string;
  location: string | null;
  class_level: string | null;
  instructor: string | null;
  scheduled_at: string;
  status: string;
  unfilled_notified_at: string | null;
}

interface WebhookPayload {
  type?: string;
  table?: string;
  record?: SpotRecord;
  old_record?: SpotRecord;
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

// Format the class time for humans. The DB stores UTC; we render in UTC and label it.
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

function buildEmailHtml(spot: SpotRecord, appUrl: string): string {
  const when = formatWhen(spot.scheduled_at);

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

  const postUrl = escapeHtml(appUrl || "#");

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fff8f4;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
      <div style="background:#fff;border:1px solid #f0e8e0;border-radius:16px;padding:32px;">
        <h1 style="margin:0 0 8px;font-size:22px;color:#F35C20;">We couldn't fill your spot</h1>
        <p style="margin:0 0 20px;font-size:15px;color:#333;">
          We're sorry — No Show couldn't find anyone on the waitlist to take your
          <strong>${escapeHtml(spot.class_type)}</strong> spot at
          <strong>${escapeHtml(spot.studio)}</strong>.
        </p>

        <table style="border-collapse:collapse;margin-bottom:24px;">
          ${rowsHtml}
        </table>

        <p style="margin:0 0 24px;font-size:15px;color:#333;">
          Nothing more to do here — we just wanted to let you know so you can plan
          around it. Preferences change often, so it's worth posting again next time.
        </p>

        <a href="${postUrl}"
           style="display:inline-block;background:#F35C20;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 28px;border-radius:100px;">
          Open No Show →
        </a>
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
    const oldRecord = payload.old_record;

    // 1. Only the null -> set transition of unfilled_notified_at should email. This is
    //    the idempotency gate: mark_spot_unfilled() flips it exactly once, and any other
    //    spots UPDATE (e.g. a claim) either leaves it unchanged or was already set.
    if (!record?.id || !record?.poster_id) {
      console.warn("send-unfilled-spot-email: payload missing record/ids", payload?.type);
      return ok("no record");
    }
    if (!record.unfilled_notified_at) {
      return ok("not an unfilled transition (flag not set)");
    }
    if (oldRecord?.unfilled_notified_at) {
      return ok("already notified (flag was already set)");
    }
    // Never email about a spot that ended up claimed.
    if (record.status === "claimed") {
      return ok("spot is claimed");
    }

    // 2. Service-role client (bypasses RLS; injected env in the Edge runtime).
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      console.error("send-unfilled-spot-email: missing SUPABASE_URL / SERVICE_ROLE_KEY");
      return ok("missing supabase env");
    }
    const supabase = createClient(supabaseUrl, serviceKey);

    // 3. Look up the poster's email via the auth admin API (same source of truth the
    //    seeker email uses in send-notification-email).
    const { data: userData, error: userError } =
      await supabase.auth.admin.getUserById(record.poster_id);
    const toEmail = userData?.user?.email;

    if (userError) {
      console.error("send-unfilled-spot-email: getUserById failed", userError.message);
      return ok("user lookup failed");
    }
    if (!toEmail) {
      console.log(`send-unfilled-spot-email: no email for poster ${record.poster_id}, skipping`);
      return ok("no email");
    }

    // 4. Send via Resend.
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) {
      console.error("send-unfilled-spot-email: RESEND_API_KEY not set");
      return ok("no resend key");
    }
    const from = Deno.env.get("RESEND_FROM") ?? "No Show <onboarding@resend.dev>";
    const appUrl = Deno.env.get("APP_URL") ?? "";

    const className = record.title || record.class_type;
    const subject = `We couldn't fill your ${className} spot`;

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
        html: buildEmailHtml(record, appUrl),
      }),
    });

    if (!resendRes.ok) {
      // Best-effort: log and still return 200.
      const errText = await resendRes.text();
      console.error(`send-unfilled-spot-email: Resend ${resendRes.status}: ${errText}`);
      return ok("resend failed");
    }

    console.log(`send-unfilled-spot-email: sent to ${toEmail} for spot ${record.id}`);
    return ok("sent");
  } catch (err) {
    // Never throw — email failure must not affect matching or trigger retries.
    console.error("send-unfilled-spot-email: unexpected error", err);
    return ok("caught error");
  }
});
