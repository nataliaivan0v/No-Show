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
