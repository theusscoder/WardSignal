export type State = 'stable' | 'review' | 'stale' | 'urgent'
export type DemoPerson = { id: string; name: string; role: string }
export type Observation = {
  id?: number
  patient_id: string
  encounter_id: string
  code: string
  name: string
  value: number | null
  unit: string
  observed_at: string
  received_at: string
  source: string
  quality: 'valid' | 'stale' | 'missing'
  freshness?: 'fresh' | 'stale' | 'missing'
  kind: 'measured' | 'missing'
}
export type AuditEvent = {
  id: number | string
  alert_id: string | null
  patient_id: string
  event: string
  actor: string
  details: Record<string, string | number | null>
  created_at: string
}
export type Alert = {
  id: string
  state: string
  owner: DemoPerson
  score: number
  reason: string
  created_at: string
  acknowledged_at: string | null
  escalated_at: string | null
}
export type Patient = {
  patient_id: string
  encounter_id: string
  demo_id: string
  name: string
  bed: string
  ward: string
  state: State
  last_updated: string
  owner: DemoPerson
  observations: Record<string, Observation>
  trend: { value: number | null; observed_at: string; quality: string }[]
  risk_estimate: { value: number; target: string; horizon: string; label: string; contributors: string[] }
  alert: Alert | null
  scenario: 'rising' | 'stable' | 'missing' | 'unacknowledged'
}
export type Queue = {
  ward: string
  shift: string
  synthetic: boolean
  on_duty: DemoPerson
  backup: DemoPerson
  review_count: number
  urgent_count: number
  patients: Patient[]
}
export type Timeline = { patient_id: string; encounter_id: string; observations: Observation[]; events: AuditEvent[] }
export type Notification = {
  id: number
  alert_id: string
  patient_id: string
  patient_name: string
  demo_id: string
  recipient: DemoPerson
  created_at: string
  read: boolean
  state: string
}
