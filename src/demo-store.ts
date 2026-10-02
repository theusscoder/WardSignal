import type { Alert, AuditEvent, DemoPerson, Notification, Observation, Patient, Queue, Scenario, Timeline } from './types'

const STORAGE_KEY = 'wardsignal-browser-demo-v1'
const WARD = 'North · Medical 3'
const ON_DUTY: DemoPerson = { id: 'clinician-1', name: 'Dr. Ananya Sen', role: 'On duty' }
const BACKUP: DemoPerson = { id: 'clinician-2', name: 'Dr. Rohan Iyer', role: 'Backup' }
const UNITS: Record<string, string> = { hr: 'bpm', spo2: '%', rr: '/min', temp: '°C', sbp: 'mmHg' }
const NAMES: Record<string, string> = { hr: 'Heart rate', spo2: 'Oxygen saturation', rr: 'Respiratory rate', temp: 'Temperature', sbp: 'Systolic blood pressure' }
const CODES = ['hr', 'spo2', 'rr', 'temp', 'sbp'] as const

export type DemoState = {
  patients: Patient[]
  timelines: Record<string, Timeline>
  notifications: Notification[]
  nextObservationId: number
  nextEventId: number
  nextNotificationId: number
}

function isoAt(minutesAgo = 0) { return new Date(Date.now() - minutesAgo * 60_000).toISOString() }
function stamp(date: Date) { return date.toISOString() }

function event(state: DemoState, patientId: string, type: string, actor: string, details: AuditEvent['details'], alertId: string | null = null, at = new Date()) {
  const timeline = state.timelines[patientId]
  timeline.events.unshift({ id: state.nextEventId++, alert_id: alertId, patient_id: patientId, event: type, actor, details, created_at: stamp(at) })
  timeline.events.sort((a, b) => b.created_at.localeCompare(a.created_at) || Number(b.id) - Number(a.id))
}

function newObservation(state: DemoState, patient: Patient, code: string, value: number | null, at: Date, quality: Observation['quality'] = 'valid', source = 'Bedside monitor · synthetic'): Observation {
  const observation: Observation = {
    id: state.nextObservationId++, patient_id: patient.patient_id, encounter_id: patient.encounter_id,
    code, name: NAMES[code], value, unit: UNITS[code], observed_at: stamp(at), received_at: stamp(new Date()),
    source, quality, freshness: quality === 'missing' ? 'missing' : quality === 'stale' ? 'stale' : 'fresh',
    kind: quality === 'missing' ? 'missing' : 'measured',
  }
  state.timelines[patient.patient_id].observations.push(observation)
  event(state, patient.patient_id, 'observation', source, { name: observation.name, value, unit: observation.unit, quality }, null, new Date())
  return observation
}

function scoreFor(observations: Observation[]) {
  const latest: Record<string, Observation> = {}
  for (const observation of [...observations].sort((a, b) => b.observed_at.localeCompare(a.observed_at) || (b.id || 0) - (a.id || 0))) latest[observation.code] ||= observation
  const checks: [string, (n: number) => boolean, string][] = [
    ['hr', value => value > 110, 'Heart rate above 110 bpm'],
    ['rr', value => value > 23, 'Respiratory rate above 23/min'],
    ['spo2', value => value < 94, 'Oxygen saturation below 94%'],
    ['temp', value => value >= 38, 'Temperature at or above 38.0°C'],
    ['sbp', value => value < 100, 'Systolic pressure below 100 mmHg'],
  ]
  const contributors = checks.flatMap(([code, crossed, label]) => {
    const observation = latest[code]
    return observation?.quality === 'valid' && observation.value !== null && crossed(observation.value) ? [label] : []
  })
  return { value: Math.min(100, contributors.length * 25), contributors }
}

function derivePatient(state: DemoState, patient: Patient, at = new Date()) {
  const timeline = state.timelines[patient.patient_id]
  const latest: Record<string, Observation> = {}
  for (const observation of [...timeline.observations].sort((a, b) => b.observed_at.localeCompare(a.observed_at) || (b.id || 0) - (a.id || 0))) latest[observation.code] ||= observation
  const observations: Patient['observations'] = {}
  for (const [code, item] of Object.entries(latest)) {
    const staleByAge = item.quality === 'valid' && at.getTime() - new Date(item.observed_at).getTime() > 20 * 60_000
    observations[code] = { ...item, freshness: item.quality === 'missing' ? 'missing' : item.quality === 'stale' || staleByAge ? 'stale' : 'fresh' }
  }
  const heartRates = timeline.observations.filter(item => item.code === 'hr').slice(-7)
  const risk = scoreFor(timeline.observations)
  const alert = patient.alert
  const hasStaleData = Object.values(observations).some(item => item.freshness === 'stale' || item.freshness === 'missing')
  const stateValue = alert?.state === 'open' ? 'urgent' : risk.value >= 25 || patient.scenario === 'rising' ? 'review' : hasStaleData ? 'stale' : 'stable'
  const latestRecorded = [...timeline.observations].sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0]
  const owner = alert?.owner || patient.owner
  return {
    ...patient,
    state: stateValue as Patient['state'],
    last_updated: latestRecorded?.observed_at || patient.last_updated,
    owner,
    observations,
    trend: heartRates.map(item => ({ value: item.value, observed_at: item.observed_at, quality: item.quality })),
    risk_estimate: { value: risk.value, target: 'review-threshold crossings in recorded observations', horizon: 'current snapshot', label: 'Prototype estimate', contributors: risk.contributors },
  }
}

function createSeed(): DemoState {
  const state: DemoState = { patients: [], timelines: {}, notifications: [], nextObservationId: 1, nextEventId: 1, nextNotificationId: 1 }
  const descriptors = [
    { id: 'p-101', encounter: 'enc-101', demo: 'WS-1042', name: 'Meera Nair', bed: 'Bed 12', owner: ON_DUTY, scenario: 'stable' as const, mins: 10, values: { hr: [72, 73, 72, 74, 73, 74], spo2: [98, 98, 97, 98, 98, 98], rr: [15, 15, 16, 15, 15, 15], temp: [36.7, 36.7, 36.8, 36.7, 36.7, 36.7], sbp: [118, 119, 117, 118, 120, 119] } },
    { id: 'p-102', encounter: 'enc-102', demo: 'WS-1078', name: 'Arjun Menon', bed: 'Bed 14', owner: ON_DUTY, scenario: 'rising' as const, mins: 10, values: { hr: [88, 91, 96, 99, 103, 106], spo2: [97, 97, 96, 96, 95, 94], rr: [17, 18, 19, 20, 21, 22], temp: [36.8, 36.9, 37, 37.2, 37.5, 37.8], sbp: [122, 121, 120, 118, 116, 114] } },
    { id: 'p-103', encounter: 'enc-103', demo: 'WS-1091', name: 'Ayesha Khan', bed: 'Bed 18', owner: BACKUP, scenario: 'missing' as const, mins: 48, values: { hr: [78, 79, 77, 78, 80], spo2: [97, 97, 96, 97], rr: [16, 16, 16, 17, 16], temp: [36.8, 36.8, 36.8, 36.9, 36.8], sbp: [116, 117, 118, 117, 116] } },
    { id: 'p-104', encounter: 'enc-104', demo: 'WS-1106', name: 'Devika Iyer', bed: 'Bed 21', owner: ON_DUTY, scenario: 'unacknowledged' as const, mins: 10, values: { hr: [91, 98, 104, 109, 114, 118], spo2: [96, 95, 94, 93, 92, 91], rr: [19, 20, 22, 24, 25, 27], temp: [37.2, 37.3, 37.5, 37.8, 38, 38.3], sbp: [109, 106, 104, 102, 99, 96] } },
    { id: 'p-105', encounter: 'enc-105', demo: 'WS-1133', name: 'Kabir Rao', bed: 'Bed 24', owner: BACKUP, scenario: 'stable' as const, mins: 10, values: { hr: [67, 68, 68, 69, 67, 68], spo2: [98, 98, 99, 98, 98, 98], rr: [14, 14, 15, 14, 14, 14], temp: [36.5, 36.5, 36.6, 36.5, 36.5, 36.5], sbp: [124, 123, 124, 126, 124, 125] } },
  ]
  for (const desc of descriptors) {
    const patient: Patient = { patient_id: desc.id, encounter_id: desc.encounter, demo_id: desc.demo, name: desc.name, bed: desc.bed, ward: WARD, state: 'stable', last_updated: isoAt(desc.mins), owner: desc.owner, observations: {}, trend: [], risk_estimate: { value: 0, target: 'review-threshold crossings in recorded observations', horizon: 'current snapshot', label: 'Prototype estimate', contributors: [] }, alert: null, scenario: desc.scenario }
    state.patients.push(patient)
    state.timelines[desc.id] = { patient_id: desc.id, encounter_id: desc.encounter, observations: [], events: [] }
    const count = Math.min(...Object.values(desc.values).map(values => values.length))
    for (let index = 0; index < count; index += 1) {
      const at = new Date(Date.now() - (desc.mins + (count - index - 1) * 4) * 60_000)
      for (const code of CODES) {
        const series = desc.values[code as keyof typeof desc.values]
        const value = series[index]
        if (value !== undefined) newObservation(state, patient, code, value, at)
      }
    }
    if (desc.id === 'p-103') newObservation(state, patient, 'spo2', null, new Date(), 'missing', 'Scenario simulator · unavailable')
  }
  const alertAt = new Date(Date.now() - 30_000)
  const alert: Alert = { id: 'al-p-104', state: 'open', owner: ON_DUTY, score: 100, reason: 'Several recent observations crossed the transparent prototype review thresholds.', created_at: stamp(alertAt), acknowledged_at: null, escalated_at: null, assigned_at: stamp(alertAt) }
  const patient = state.patients.find(item => item.patient_id === 'p-104')!
  patient.alert = alert
  state.notifications.unshift({ id: state.nextNotificationId++, alert_id: alert.id, patient_id: patient.patient_id, patient_name: patient.name, demo_id: patient.demo_id, recipient: ON_DUTY, created_at: stamp(alertAt), read: false, state: 'open' })
  event(state, patient.patient_id, 'created', 'WardSignal demo', { state: 'open', score: 100 }, alert.id, alertAt)
  event(state, patient.patient_id, 'delivered', ON_DUTY.name, { channel: 'in-app' }, alert.id, new Date(alertAt.getTime() + 1000))
  state.patients = state.patients.map(item => derivePatient(state, item))
  return state
}

export function loadDemoState(): DemoState {
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as DemoState
        if (Array.isArray(parsed.patients) && parsed.timelines && Array.isArray(parsed.notifications)) {
          parsed.patients = parsed.patients.map(patient => derivePatient(parsed, patient))
          return parsed
        }
      }
    } catch { /* Start with fresh synthetic data when browser storage is unavailable or invalid. */ }
  }
  return createSeed()
}

export function saveDemoState(state: DemoState) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* The demo still works for this session if storage is disabled. */ }
}

export function toQueue(state: DemoState): Queue {
  const patients = [...state.patients].sort((a, b) => (a.state === 'urgent' ? -1 : b.state === 'urgent' ? 1 : a.state === 'review' ? -1 : b.state === 'review' ? 1 : a.bed.localeCompare(b.bed, undefined, { numeric: true })))
  return { ward: WARD, shift: 'Day shift · 07:00–19:00', synthetic: true, on_duty: ON_DUTY, backup: BACKUP, review_count: patients.filter(patient => patient.state !== 'stable').length, urgent_count: patients.filter(patient => patient.state === 'urgent').length, patients }
}

function refreshAlert(state: DemoState, patient: Patient, at: Date) {
  const risk = scoreFor(state.timelines[patient.patient_id].observations)
  const openOrAck = patient.alert && ['open', 'acknowledged'].includes(patient.alert.state) ? patient.alert : null
  if (risk.value >= 50) {
    const reason = risk.contributors.length ? `Prototype thresholds crossed: ${risk.contributors.join('; ')}.` : 'Prototype thresholds crossed in recent observations.'
    if (openOrAck) {
      patient.alert = { ...openOrAck, score: risk.value, reason }
      event(state, patient.patient_id, 'updated', 'WardSignal demo', { score: risk.value }, openOrAck.id, at)
      state.notifications = state.notifications.map(item => item.alert_id === openOrAck.id ? { ...item, state: openOrAck.state } : item)
    } else {
      const created: Alert = { id: `al-${crypto.randomUUID().slice(0, 8)}`, state: 'open', owner: patient.owner, score: risk.value, reason, created_at: stamp(at), assigned_at: stamp(at), acknowledged_at: null, escalated_at: null }
      patient.alert = created
      event(state, patient.patient_id, 'created', 'WardSignal demo', { state: 'open', score: risk.value }, created.id, at)
      state.notifications.unshift({ id: state.nextNotificationId++, alert_id: created.id, patient_id: patient.patient_id, patient_name: patient.name, demo_id: patient.demo_id, recipient: created.owner, created_at: stamp(at), read: false, state: 'open' })
      event(state, patient.patient_id, 'delivered', created.owner.name, { channel: 'in-app' }, created.id, at)
    }
  } else if (openOrAck) {
    patient.alert = { ...openOrAck, state: 'resolved' }
    event(state, patient.patient_id, 'resolved', 'WardSignal demo', { score: risk.value, reason: 'No longer above the demo alert threshold.' }, openOrAck.id, at)
    state.notifications = state.notifications.map(item => item.alert_id === openOrAck.id ? { ...item, state: 'resolved' } : item)
  }
}

export function replayScenario(state: DemoState, patientId: string, encounterId: string, scenario: Scenario): DemoState {
  const next = structuredClone(state)
  const patient = next.patients.find(item => item.patient_id === patientId)
  if (!patient || patient.encounter_id !== encounterId) throw new Error('Patient and encounter do not match.')
  const timeline = next.timelines[patientId]
  const at = new Date()
  patient.scenario = scenario
  if (scenario === 'missing') {
    newObservation(next, patient, 'spo2', null, at, 'missing', 'Scenario simulator · unavailable')
  } else {
    const current = Object.fromEntries(CODES.map(code => {
      const previous = [...timeline.observations].reverse().find(item => item.code === code && item.value !== null && item.quality === 'valid')
      const fallback = { hr: 76, spo2: 97, rr: 16, temp: 36.8, sbp: 118 }[code]
      return [code, previous?.value ?? fallback]
    })) as Record<typeof CODES[number], number>
    const values: Record<typeof CODES[number], number> = scenario === 'rising'
      ? { hr: current.hr + 5, spo2: current.spo2 - 1, rr: current.rr + 2, temp: current.temp + 0.2, sbp: current.sbp - 2 }
      : scenario === 'unacknowledged'
        ? { hr: Math.max(current.hr, 112), spo2: Math.min(current.spo2, 92), rr: Math.max(current.rr, 25), temp: Math.max(current.temp, 38.2), sbp: Math.min(current.sbp, 98) }
        : { hr: 74, spo2: 98, rr: 15, temp: 36.7, sbp: 120 }
    for (const code of CODES) newObservation(next, patient, code, Math.round(values[code] * 10) / 10, at)
  }
  refreshAlert(next, patient, at)
  event(next, patientId, 'replayed', 'WardSignal demo', { scenario }, null, at)
  next.patients = next.patients.map(item => item.patient_id === patientId ? derivePatient(next, patient, at) : derivePatient(next, item, at))
  return next
}

export function acknowledgeAlert(state: DemoState, alertId: string, actorId: string): DemoState {
  const next = structuredClone(state)
  const actor = actorId === ON_DUTY.id ? ON_DUTY : actorId === BACKUP.id ? BACKUP : null
  const patient = next.patients.find(item => item.alert?.id === alertId)
  if (!actor || !patient?.alert || patient.alert.state !== 'open') throw new Error('This alert is no longer open.')
  const at = new Date()
  patient.alert = { ...patient.alert, state: 'acknowledged', acknowledged_at: stamp(at) }
  event(next, patient.patient_id, 'acknowledged', actor.name, {}, alertId, at)
  next.notifications = next.notifications.map(item => item.alert_id === alertId ? { ...item, state: 'acknowledged' } : item)
  next.patients = next.patients.map(item => derivePatient(next, item, at))
  return next
}

export function reassignAlert(state: DemoState, alertId: string, ownerId: string, actorId: string): DemoState {
  const next = structuredClone(state)
  const actor = actorId === ON_DUTY.id ? ON_DUTY : actorId === BACKUP.id ? BACKUP : null
  const owner = ownerId === ON_DUTY.id ? ON_DUTY : ownerId === BACKUP.id ? BACKUP : null
  const patient = next.patients.find(item => item.alert?.id === alertId)
  if (!actor || !owner || !patient?.alert || patient.alert.state !== 'open' || patient.alert.owner.id === owner.id) throw new Error('Choose a different clinician for an open alert.')
  const at = new Date()
  const previous = patient.alert.owner
  patient.alert = { ...patient.alert, owner, assigned_at: stamp(at), escalated_at: null }
  event(next, patient.patient_id, 'reassigned', actor.name, { from: previous.name, to: owner.name }, alertId, at)
  next.notifications.unshift({ id: next.nextNotificationId++, alert_id: alertId, patient_id: patient.patient_id, patient_name: patient.name, demo_id: patient.demo_id, recipient: owner, created_at: stamp(at), read: false, state: 'open' })
  event(next, patient.patient_id, 'delivered', owner.name, { channel: 'in-app' }, alertId, at)
  next.notifications = next.notifications.map(item => item.alert_id === alertId ? { ...item, state: 'open' } : item)
  next.patients = next.patients.map(item => derivePatient(next, item, at))
  return next
}

export function markNotificationRead(state: DemoState, notificationId: number): DemoState {
  const next = structuredClone(state)
  next.notifications = next.notifications.map(item => item.id === notificationId ? { ...item, read: true } : item)
  return next
}

export function processEscalations(state: DemoState, at = new Date()): DemoState {
  let next: DemoState | null = null
  for (const candidate of state.patients) {
    const alert = candidate.alert
    if (!alert || alert.state !== 'open' || alert.owner.id !== ON_DUTY.id) continue
    const assignedAt = alert.assigned_at || alert.created_at
    if (at.getTime() - new Date(assignedAt).getTime() < 90_000) continue
    next ||= structuredClone(state)
    const patient = next.patients.find(item => item.patient_id === candidate.patient_id)!
    patient.alert = { ...alert, owner: BACKUP, assigned_at: stamp(at), escalated_at: stamp(at) }
    event(next, patient.patient_id, 'escalated', 'WardSignal demo', { from: ON_DUTY.name, to: BACKUP.name, after_seconds: 90 }, alert.id, at)
    next.notifications.unshift({ id: next.nextNotificationId++, alert_id: alert.id, patient_id: patient.patient_id, patient_name: patient.name, demo_id: patient.demo_id, recipient: BACKUP, created_at: stamp(at), read: false, state: 'open' })
  }
  if (!next) return state
  next.patients = next.patients.map(item => derivePatient(next!, item, at))
  return next
}

