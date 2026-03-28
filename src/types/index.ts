export type NotifStatus = 'pending' | 'claimed' | 'expired'

export interface Profile {
  id: string
  full_name: string
  created_at: string
}

export interface Spot {
  id: string
  poster_id: string
  title: string
  class_type: string
  studio: string
  scheduled_at: string
  status: 'available' | 'claimed'
  created_at: string
}

export interface WaitlistEntry {
  id: string
  seeker_id: string
  class_types: string[]
  created_at: string
}

export interface Notification {
  id: string
  seeker_id: string
  spot_id: string
  waitlist_entry_id: string
  message: string
  status: NotifStatus
  created_at: string
}
