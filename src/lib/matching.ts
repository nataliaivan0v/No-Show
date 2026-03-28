import { supabase } from './supabase'

export async function notifyNextSeeker(
  spotId: string,
  afterEntryId?: string
): Promise<boolean> {
  const { data: spot } = await supabase
    .from('spots').select('*').eq('id', spotId).single()
  if (!spot) return false

  const { data: matches } = await supabase
    .from('waitlist_entries')
    .select('*')
    .contains('class_types', [spot.class_type])
    .order('created_at', { ascending: true })

  if (!matches?.length) return false

  let target = matches[0]
  if (afterEntryId) {
    const idx = matches.findIndex((e: { id: string }) => e.id === afterEntryId)
    if (idx === -1 || idx + 1 >= matches.length) return false
    target = matches[idx + 1]
  }

  await supabase.from('notifications').insert({
    seeker_id: target.seeker_id,
    spot_id: spot.id,
    waitlist_entry_id: target.id,
    message: `A ${spot.class_type} spot at ${spot.studio} is available on ${new Date(spot.scheduled_at).toLocaleString()}. Claim it before it's gone!`,
    status: 'pending'
  })

  return true
}

export async function simulateTimeout(spotId: string): Promise<string> {
  const { data: notif } = await supabase
    .from('notifications')
    .select('*')
    .eq('spot_id', spotId)
    .eq('status', 'pending')
    .maybeSingle()

  if (!notif) return 'No pending notification for this spot'

  await supabase
    .from('notifications')
    .update({ status: 'expired' })
    .eq('id', notif.id)

  const moved = await notifyNextSeeker(spotId, notif.waitlist_entry_id)
  return moved
    ? '⏱ Timed out — next seeker on waitlist notified'
    : '⏱ Timed out — waitlist exhausted, no more seekers'
}