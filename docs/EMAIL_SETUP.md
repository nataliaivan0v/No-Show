# Email Notification Setup

How to set up the `send-notification-email` Edge Function so seekers get an email
when a spot is offered to them. See the README ("Email notifications") for how the
flow works; this doc is just the reproducible setup steps.

## 1. Secrets

The function reads these at runtime.

| Name | Who sets it | Notes |
|---|---|---|
| `SUPABASE_URL` | **Auto-injected** by the Edge runtime | Do not set manually. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Auto-injected** by the Edge runtime | The function uses the **service role key** so it can read any spot and call the Auth admin API (`auth.admin.getUserById`). Do not set manually; never expose it to the client. |
| `RESEND_API_KEY` | You | From the [Resend dashboard](https://resend.com) → API Keys. |
| `APP_URL` | You | Base URL used for the "Claim it in the app" link, e.g. `http://localhost:5173` in dev or your deployed URL. |
| `RESEND_FROM` | Optional | Sender address. Defaults to `No Show <onboarding@resend.dev>` (Resend's sandbox sender). Set this to an address on a **verified domain** for real delivery to arbitrary recipients. |

Set the ones you own with the CLI:

```bash
npx supabase secrets set \
  RESEND_API_KEY=re_xxxxxxxx \
  APP_URL="http://localhost:5173"
# optional, only once you have a verified domain in Resend:
# npx supabase secrets set RESEND_FROM="No Show <notify@yourdomain.com>"

# verify
npx supabase secrets list
```

> **Sandbox sender caveat:** with the default `onboarding@resend.dev`, Resend only
> delivers to the email address that owns your Resend account. To test end to end,
> make the matched seeker's account email your own Resend login email.

## 2. Deploy the function

```bash
npx supabase functions deploy send-notification-email --no-verify-jwt --use-api
```

- `--no-verify-jwt` lets the Database Webhook call the function (it's an internal,
  trusted trigger).
- `--use-api` bundles server-side, so you don't need Docker running locally.

The deployed URL is:

```
https://<project-ref>.supabase.co/functions/v1/send-notification-email
```

## 3. Create the Database Webhook (manual, dashboard)

There is no CLI command for this — create it once in the dashboard:

1. **Database → Webhooks → Create a new hook**
2. Name: `send-notification-email` (any name)
3. Table: **`notifications`**
4. Events: **Insert** only
5. Type: **Supabase Edge Functions** → select `send-notification-email`
   - (If you pick **HTTP Request** instead: method `POST`, URL = the function URL
     above, and add headers `Authorization: Bearer <service-role-key>` and
     `Content-Type: application/json`.)
6. Save.

## 4. Verify

- Post a spot that matches a waitlisted seeker (this inserts a `notifications` row).
- Check the function's **Logs** and **Invocations** tabs:
  `https://supabase.com/dashboard/project/<project-ref>/functions/send-notification-email/logs`
- The email is **best-effort**: failures are logged and the function still returns
  `200`, so a delivery problem never blocks matching or retries the webhook. Look for
  a `Resend 4xx/5xx` line in the logs if an email doesn't arrive.

---

# Unfilled-spot Email (`send-unfilled-spot-email`)

A second transactional email tells the **poster** when No Show couldn't find anyone
to take their spot. It fires in two situations, both of which end up at the same place
in the code (`notify_seeker_for_spot()` returning "no candidate"):

- **(a) No match at post time** — a spot is posted and no waitlisted seeker matches.
- **(b) Queue exhausted** — everyone who was offered the spot let it expire or hit
  "Not Interested", and there's no one left to advance to.

## How it's wired (mechanism reused from above)

Same Database-Webhook → Edge-Function path as the seeker email, but on a different
table and event:

1. When the matcher hits a dead end it calls `mark_spot_unfilled(spot_id)`, which sets
   `spots.unfilled_notified_at` from `null` → `now()` **exactly once** (the `WHERE`
   also refuses to set it on a `claimed` or deleted spot).
2. That `UPDATE` fires a Database Webhook on the `spots` table.
3. `send-unfilled-spot-email` receives the row, confirms the flag just transitioned
   (`old_record.unfilled_notified_at` was null, `record.unfilled_notified_at` now set,
   status ≠ `claimed`), looks up the poster's email, and sends via Resend.

The idempotency guard lives in the DB (`unfilled_notified_at` set once) **and** in the
function (only the null→set transition sends), so the every-minute expiry cron can call
the matcher repeatedly without ever emailing twice.

### Re-match behavior: once-ever (current) vs re-notify

The app re-checks available spots when a new seeker joins the waitlist
(`notify_available_spots_for_me()`), so a spot that already got the "no match" email
could later be matched and even claimed. The current behavior is **strictly once ever
per spot** (option i): `mark_spot_unfilled()` only sets `unfilled_notified_at` when it's
null, and nothing clears it — so the poster is never emailed twice, even if the spot is
later matched then exhausted again.

To switch to **re-notify on a later exhaustion** (option ii) — i.e. if a new seeker
gets matched to an already-notified spot, allow a future dead end to email again — clear
the flag whenever a fresh offer goes out. In `notify_seeker_for_spot()`, right after the
`insert into public.notifications (...)`, add:

```sql
update public.spots set unfilled_notified_at = null where id = v_spot.id;
```

That resets the guard on every new offer, so the next time the queue runs dry the poster
is emailed again.

## Secrets & deploy

It shares all the same secrets as `send-notification-email` (`RESEND_API_KEY`,
`RESEND_FROM`, `APP_URL`) — nothing new to set. Deploy it the same way:

```bash
npx supabase functions deploy send-unfilled-spot-email --no-verify-jwt --use-api
```

## Create the Database Webhook (manual, dashboard)

1. **Database → Webhooks → Create a new hook**
2. Name: `send-unfilled-spot-email` (any name)
3. Table: **`spots`**
4. Events: **Update** only
5. Type: **Supabase Edge Functions** → select `send-unfilled-spot-email`
6. Save.

## Verify

- **Condition (a):** post a spot (at least 1h out) whose class type / level / time /
  location matches **no** waitlist entry. Within a moment the spots row gets
  `unfilled_notified_at` set and the poster gets the email.
- **Condition (b):** post a spot that matches exactly one waitlisted seeker, then let
  that seeker's offer expire (wait for the 30-min cron sweep, or temporarily lower the
  `interval '30 minutes'` in `expire_stale_notifications()`) or hit "Not Interested".
  With no one left in the queue, the poster gets the email.
- **Idempotency check:** watch the spots row — `unfilled_notified_at` is set once and
  never changes; the minute-by-minute cron does not re-send. The function logs
  `already notified (flag was already set)` / `not an unfilled transition` for the
  UPDATEs that must not email (e.g. a claim).
