import { useEffect, useState } from 'react'
import { type Profile, type Spot } from '../types'
import { supabase } from '../lib/supabase'

// Extends Spot with a display role so SpotCard knows whether the user posted or claimed it
interface SpotWithRole extends Spot {
  role: 'claimed' | 'listed'
}

export default function Dashboard({ profile }: { profile: Profile }) {
  const [upcoming, setUpcoming] = useState<SpotWithRole[]>([])
  const [listed, setListed] = useState<Spot[]>([])
  const [pastTaken, setPastTaken] = useState<Spot[]>([])
  const [pastListed, setPastListed] = useState<Spot[]>([])
  const [loading, setLoading] = useState(true)

  // Fetch all four spot lists in a single effect so we only run one round of queries on mount
  useEffect(() => {
    const fetchAll = async () => {
      const now = new Date().toISOString()

      // Spots are linked to a seeker via notifications (not directly), so we look up
      // claimed spot IDs through the notifications table first
      const { data: claimedNotifs } = await supabase
        .from('notifications')
        .select('spot_id')
        .eq('seeker_id', profile.id)
        .eq('status', 'claimed')

      const claimedIds = claimedNotifs?.map(n => n.spot_id) ?? []

      // Upcoming claimed
      let upcomingClaimed: SpotWithRole[] = []
      if (claimedIds.length) {
        const { data } = await supabase
          .from('spots').select('*')
          .in('id', claimedIds)
          .gte('scheduled_at', now)
          .order('scheduled_at', { ascending: true })
        upcomingClaimed = (data ?? []).map(s => ({ ...s, role: 'claimed' as const }))
      }
      setUpcoming(upcomingClaimed)

      // Upcoming listed
      const { data: listedData } = await supabase
        .from('spots').select('*')
        .eq('poster_id', profile.id)
        .gte('scheduled_at', now)
        .order('scheduled_at', { ascending: true })
      setListed(listedData ?? [])

      // Past taken (claimed by me)
      if (claimedIds.length) {
        const { data } = await supabase
          .from('spots').select('*')
          .in('id', claimedIds)
          .lt('scheduled_at', now)
          .order('scheduled_at', { ascending: false })
        setPastTaken(data ?? [])
      }

      // Past listed (posted by me)
      const { data: pastPosted } = await supabase
        .from('spots').select('*')
        .eq('poster_id', profile.id)
        .lt('scheduled_at', now)
        .order('scheduled_at', { ascending: false })
      setPastListed(pastPosted ?? [])

      setLoading(false)
    }

    fetchAll()
  }, [profile.id])

  if (loading) return <div style={{ padding: 48, fontFamily: "'Afacad', sans-serif", color: '#888' }}>Loading...</div>

  return (
    <div style={{ minHeight: '100vh', background: '#fff8f4', fontFamily: "'Afacad', sans-serif", padding: '40px 48px' }}>
      <h1 style={{ fontFamily: "'Berkshire Swash', cursive", fontSize: 36, color: '#111', marginBottom: 40, textAlign: 'center' }}>
        Dashboard
      </h1>

      {/* Top row — Upcoming + Listed side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 48 }}>
        <Column title="Upcoming Classes" subtitle="Spots you've claimed.">
          {upcoming.length === 0
            ? <EmptyState message="No upcoming classes." />
            : upcoming.map(s => <SpotCard key={s.id} spot={s} role="claimed" />)
          }
        </Column>
        <Column title="Listed Classes" subtitle="Spots you've posted.">
          {listed.length === 0
            ? <EmptyState message="No upcoming listings." />
            : listed.map(s => <SpotCard key={s.id} spot={s} role="listed" />)
          }
        </Column>
      </div>

      {/* Past — two columns */}
      <div style={{ borderTop: '1px solid #f0e8e0', paddingTop: 40 }}>
        <h2 style={{ fontFamily: "'Berkshire Swash', cursive", fontSize: 22, color: '#111', marginBottom: 4 }}>
          Past Classes
        </h2>
        <p style={{ fontSize: 14, color: '#aaa', marginBottom: 24 }}>Classes you've attended or listed in the past.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <Column title="Classes Taken" subtitle="Spots you claimed and attended.">
            {pastTaken.length === 0
              ? <EmptyState message="No past classes taken." />
              : pastTaken.map(s => <SpotCard key={s.id} spot={s} role="claimed" />)
            }
          </Column>
          <Column title="Classes Listed" subtitle="Spots you posted for others.">
            {pastListed.length === 0
              ? <EmptyState message="No past listings." />
              : pastListed.map(s => <SpotCard key={s.id} spot={s} role="listed" />)
            }
          </Column>
        </div>
      </div>
    </div>
  )
}

function Column({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontFamily: "'Berkshire Swash', cursive", fontSize: 20, color: '#111', marginBottom: 4 }}>
          {title}
        </h2>
        <p style={{ fontSize: 13, color: '#aaa' }}>{subtitle}</p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {children}
      </div>
    </div>
  )
}

function SpotCard({ spot, role }: { spot: Spot; role: 'claimed' | 'listed' }) {
  // Status badge label — "Claimed by you" for seekers, otherwise reflects the spot's own status
  const statusLabel = role === 'claimed' ? 'Claimed by you' : spot.status === 'claimed' ? 'Claimed' : 'Available'
  // Green for claimed spots, orange for available/listed
  const accentColor = spot.status === 'claimed' || role === 'claimed' ? '#22c55e' : '#F35C20'
  const bgColor = spot.status === 'claimed' || role === 'claimed' ? '#f0fdf4' : '#fff3ee'
  // Booking info is only shown on upcoming claimed spots (not past, not listed)
  const isUpcomingClaim = role === 'claimed' && new Date(spot.scheduled_at) > new Date()

  // Use the browser's local timezone so times aren't shown in UTC
  const formattedDate = new Date(spot.scheduled_at).toLocaleString('en-US', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  })

  return (
    <div style={{
      background: '#fff',
      borderRadius: 14,
      padding: '16px 18px',
      border: '1px solid #f0e8e0',
      borderLeft: `5px solid ${accentColor}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
        <div>
          <p style={{ fontSize: 15, fontWeight: 700, color: '#111', marginBottom: 1 }}>
            {spot.studio}{spot.title && !spot.title.includes('·') ? ` — ${spot.title}` : ''}
          </p>
        </div>
        <span style={{
          background: bgColor,
          color: accentColor,
          fontSize: 11,
          fontWeight: 700,
          padding: '3px 10px',
          borderRadius: 100,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}>
          ● {statusLabel}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <DetailRow label="Date" value={formattedDate} />
        {spot.location && <DetailRow label="Location" value={spot.location} />}
        {spot.class_level && <DetailRow label="Level" value={spot.class_level} />}
        {spot.instructor && <DetailRow label="Instructor" value={spot.instructor} />}
        <DetailRow label="Type" value={spot.class_type} />
      </div>

      {isUpcomingClaim && spot.claim_info && (
        <div style={{ marginTop: 12, padding: '10px 14px', background: '#f0fdf4', borderRadius: 10, border: '1px solid #86efac' }}>
          <p style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, color: '#166534' }}>Booking Info</p>
          <p style={{ fontSize: 12, whiteSpace: 'pre-wrap', color: '#333', margin: 0 }}>{spot.claim_info}</p>
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', fontSize: 12, marginBottom: 2, textAlign: "left", paddingLeft: "5px" }}>
      <span style={{ color: '#aaa', fontWeight: 600, width: 72, flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#444' }}>{value}</span>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div style={{
      background: '#fff',
      borderRadius: 14,
      padding: '24px',
      border: '1px solid #f0e8e0',
      textAlign: 'center',
      color: '#bbb',
      fontSize: 13,
    }}>
      {message}
    </div>
  )
}