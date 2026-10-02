import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert as MuiAlert, Avatar, Badge, Button, ButtonBase, Card, CardContent,
  Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, FormControl, IconButton, InputAdornment, LinearProgress, MenuItem,
  Popover, Select, Snackbar, TextField, Tooltip, Typography,
} from '@mui/material'
import AccessTime from '@mui/icons-material/AccessTime'
import ArrowBack from '@mui/icons-material/ArrowBack'
import AssignmentTurnedIn from '@mui/icons-material/AssignmentTurnedIn'
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline'
import ChevronRight from '@mui/icons-material/ChevronRight'
import Close from '@mui/icons-material/Close'
import ErrorOutline from '@mui/icons-material/ErrorOutline'
import EventNote from '@mui/icons-material/EventNote'
import InfoOutlined from '@mui/icons-material/InfoOutlined'
import MonitorHeart from '@mui/icons-material/MonitorHeart'
import NotificationsNone from '@mui/icons-material/NotificationsNone'
import PersonOutline from '@mui/icons-material/PersonOutline'
import Replay from '@mui/icons-material/Replay'
import Search from '@mui/icons-material/Search'
import SensorsOff from '@mui/icons-material/SensorsOff'
import SwapHoriz from '@mui/icons-material/SwapHoriz'
import TrendingUp from '@mui/icons-material/TrendingUp'
import WarningAmber from '@mui/icons-material/WarningAmber'
import type { Alert, AuditEvent, Notification, Observation, Patient, Queue, State, Timeline } from './types'

const API = import.meta.env.VITE_API_URL || '/api'
const SCENARIOS = [
  { id: 'rising', title: 'Rising concerning trend', description: 'Advance vitals toward the prototype review thresholds.' },
  { id: 'stable', title: 'Stable patient', description: 'Add a stable set of recorded observations.' },
  { id: 'missing', title: 'Missing reading', description: 'Record an unavailable SpO₂ sample and show a chart gap.' },
  { id: 'unacknowledged', title: 'Unacknowledged alert', description: 'Advance the episode and route an open alert to the owner.' },
] as const
type Scenario = typeof SCENARIOS[number]['id']
type Filter = 'all' | 'urgent' | 'review' | 'stale' | 'stable'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`)
  return body as T
}

const statusMeta: Record<State, { label: string; color: 'success' | 'warning' | 'error' | 'default'; Icon: typeof CheckCircleOutline }> = {
  stable: { label: 'Stable', color: 'success', Icon: CheckCircleOutline },
  review: { label: 'Review trend', color: 'warning', Icon: TrendingUp },
  stale: { label: 'Stale data', color: 'default', Icon: SensorsOff },
  urgent: { label: 'Open alert', color: 'error', Icon: ErrorOutline },
}

function StateChip({ state, compact = false }: { state: State; compact?: boolean }) {
  const { label, color, Icon } = statusMeta[state]
  return <Chip className={`status-chip status-${state}`} icon={<Icon />} label={compact ? label : label} size="small" color={color} variant="outlined" />
}

function when(value?: string | null) {
  if (!value) return 'No observation yet'
  const date = new Date(value)
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} hr${hours === 1 ? '' : 's'} ago`
}

function clock(value?: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

function eventTitle(event: AuditEvent) {
  const names: Record<string, string> = {
    created: 'Alert created', delivered: 'In-app notification delivered', acknowledged: 'Alert acknowledged',
    reassigned: 'Alert reassigned', escalated: 'Escalated to backup', resolved: 'Alert resolved', updated: 'Open alert updated',
    replayed: 'Scenario replayed', observation: 'Observation received',
  }
  return names[event.event] || event.event
}

function eventDescription(event: AuditEvent) {
  if (event.event === 'observation') {
    const value = event.details.value
    return value == null ? `${event.details.name} unavailable · missing sample` : `${event.details.name} ${value} ${event.details.unit} · ${event.details.quality}`
  }
  if (event.event === 'reassigned') return `${event.details.from} → ${event.details.to}`
  if (event.event === 'escalated') return `No acknowledgement within the demo window · now with ${event.details.to}`
  if (event.event === 'replayed') return `${String(event.details.scenario || 'demo').replaceAll('_', ' ')} scenario`
  if (event.event === 'updated') return `Prototype estimate refreshed · ${event.details.score ?? '—'} points`
  return String(event.details.reason || event.details.channel || '')
}

function StatePill({ state }: { state: State }) {
  const { label, Icon } = statusMeta[state]
  return <div className={`state-pill ${state}`}><Icon fontSize="small" /><span>{label}</span></div>
}

function Sparkline({ patient }: { patient: Patient }) {
  const vals = patient.trend.map(x => x.value).filter((x): x is number => x !== null)
  const min = vals.length ? Math.min(...vals) : 0
  const max = vals.length ? Math.max(...vals) : 1
  const d = vals.map((v, i) => `${i ? 'L' : 'M'} ${4 + (i * 68) / Math.max(vals.length - 1, 1)} ${24 - ((v - min) / Math.max(max - min, 1)) * 19}`).join(' ')
  const color = patient.state === 'urgent' ? '#c45350' : patient.state === 'review' ? '#bb7a24' : '#258572'
  return <svg className="sparkline" viewBox="0 0 76 28" role="img" aria-label="Recent heart-rate trend"><path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><circle cx={4 + ((vals.length - 1) * 68) / Math.max(vals.length - 1, 1)} cy={24 - (((vals.at(-1) || min) - min) / Math.max(max - min, 1)) * 19} r="2.6" fill={color} /></svg>
}

function latestValue(patient: Patient, code: string, digits = 0) {
  const o = patient.observations[code]
  if (!o || o.value === null || o.quality === 'missing') return '—'
  return Number(o.value).toFixed(digits)
}

function FreshnessText({ observation, freshness }: { observation?: Observation; freshness?: string }) {
  const current = freshness || observation?.freshness || (observation?.quality === 'stale' ? 'stale' : undefined)
  if (!observation || current === 'missing') return <span className="freshness missing">Missing</span>
  if (current === 'stale') return <span className="freshness stale">Stale</span>
  return <span className="freshness current">Recorded</span>
}

function PatientRow({ patient, onOpen }: { patient: Patient; onOpen: () => void }) {
  const topVitals = [
    { name: 'HR', code: 'hr', unit: 'bpm' },
    { name: 'SpO₂', code: 'spo2', unit: '%' },
    { name: 'RR', code: 'rr', unit: '/min' },
  ]
  return <ButtonBase className={`patient-row ${patient.state === 'urgent' ? 'priority-row' : ''}`} onClick={onOpen} aria-label={`Open ${patient.name}, ${patient.bed}, ${statusMeta[patient.state].label}`}>
    <div className="patient-col patient-identity">
      <Avatar className={`patient-avatar avatar-${patient.state}`}>{patient.name.split(' ').map(part => part[0]).join('')}</Avatar>
      <div className="identity-copy"><div className="patient-name">{patient.name}<span className="bed-mobile"> · {patient.bed}</span></div><div className="patient-demo">{patient.demo_id}<span className="bed-desktop"> · {patient.bed}</span></div></div>
    </div>
    <div className="patient-col state-col"><StatePill state={patient.state} /></div>
    <div className="patient-col vitals-col">
      {topVitals.map(v => {
        const obs = patient.observations[v.code]
        const stale = obs?.freshness === 'stale' || obs?.freshness === 'missing'
        return <div key={v.code} className={`vital-mini ${stale ? 'vital-stale' : ''}`}><span>{v.name}</span><b>{latestValue(patient, v.code)}<small> {v.unit}</small></b></div>
      })}
    </div>
    <div className="patient-col trend-col"><Sparkline patient={patient} /><span>HR trend</span></div>
    <div className="patient-col updated-col"><b>{when(patient.last_updated)}</b><span>Last update</span></div>
    <div className="patient-col owner-col"><Avatar className="owner-avatar">{patient.owner.name.split(' ').at(-1)?.[0]}</Avatar><span>{patient.owner.name.replace('Dr. ', '')}</span><ChevronRight className="row-arrow" fontSize="small" /></div>
  </ButtonBase>
}

function SummaryItem({ label, value, foot, tone = 'neutral', icon }: { label: string; value: string | number; foot: string; tone?: string; icon: React.ReactNode }) {
  return <Card className="summary-card"><CardContent className="summary-content"><div className={`summary-icon ${tone}`}>{icon}</div><div className="summary-copy"><span>{label}</span><b>{value}</b><small>{foot}</small></div></CardContent></Card>
}

function VitalChart({ observations, code, title, unit, freshness }: { observations: Observation[]; code: string; title: string; unit: string; freshness?: string }) {
  const points = observations.filter(o => o.code === code).slice(-10)
  const currentFreshness = freshness
  const chartPoints = [...points]
  if (currentFreshness === 'stale' || currentFreshness === 'missing') {
    chartPoints.push({ patient_id: '', encounter_id: '', code, name: title, value: null, unit, observed_at: new Date().toISOString(), received_at: '', source: '', quality: 'missing', kind: 'missing' })
  }
  const times = chartPoints.map(o => new Date(o.observed_at).getTime())
  const end = Math.max(Date.now(), ...times)
  const start = Math.min(...times, end - 60 * 60_000)
  const valid = chartPoints.filter(o => o.value !== null && o.quality === 'valid').map(o => o.value as number)
  const rawMin = valid.length ? Math.min(...valid) : 0
  const rawMax = valid.length ? Math.max(...valid) : 1
  const padding = Math.max((rawMax - rawMin) * 0.18, code === 'temp' ? 0.2 : 2)
  const min = rawMin - padding
  const max = rawMax + padding
  const x = (o: Observation) => 38 + ((new Date(o.observed_at).getTime() - start) / Math.max(end - start, 1)) * 384
  const y = (o: Observation) => 114 - (((o.value as number) - min) / Math.max(max - min, 1)) * 88
  const segments: Observation[][] = []
  chartPoints.forEach(point => {
    if (point.value === null || point.quality !== 'valid') segments.push([])
    else {
      if (!segments.length || segments.at(-1)?.length === 0) segments.push([])
      segments.at(-1)!.push(point)
    }
  })
  const timeLabels = [start, start + (end - start) / 2, end].map(t => new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)))
  const latest = points.at(-1)
  const displayValue = latest?.value == null ? '—' : `${Number(latest.value).toFixed(code === 'temp' ? 1 : 0)} ${unit}`
  const status = currentFreshness === 'missing' ? 'Missing sample' : currentFreshness === 'stale' ? `Last measured ${when(latest?.observed_at)}` : 'Recorded observations'
  return <Card className="chart-card"><CardContent>
    <div className="chart-head"><div><div className="eyebrow">Recorded observation</div><Typography variant="h3">{title}</Typography></div><div className="chart-latest"><b>{displayValue}</b><FreshnessText observation={latest} freshness={currentFreshness} /></div></div>
    <svg className="vital-chart" viewBox="0 0 440 154" role="img" aria-label={`${title} in ${unit}, with visible missing sample gaps`}>
      {[22, 52, 82, 114].map(gy => <line key={gy} x1="36" x2="424" y1={gy} y2={gy} className="chart-grid" />)}
      {[0, 1, 2, 3].map((_, i) => <text key={i} x="0" y={[26, 56, 86, 118][i]} className="chart-axis">{Math.round(max - ((max - min) * i) / 3)}</text>)}
      {segments.filter(segment => segment.length > 1).map((segment, index) => <path key={`path-${index}`} d={segment.map((p, i) => `${i ? 'L' : 'M'} ${x(p)} ${y(p)}`).join(' ')} className={`chart-line ${code}`} />)}
      {chartPoints.filter(point => point.value !== null && point.quality === 'valid').map((point, i) => <circle key={`${point.observed_at}-${i}`} cx={x(point)} cy={y(point)} r={i === chartPoints.length - 1 ? 4 : 3} className={`chart-dot ${code}`} />)}
      {chartPoints.some(point => point.value === null || point.quality !== 'valid') && <g><line x1="421" x2="421" y1="22" y2="114" className="gap-marker" /><text x="395" y="17" className="gap-label">GAP</text></g>}
      {timeLabels.map((label, i) => <text key={label + i} x={[38, 230, 422][i]} y="146" textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} className="chart-axis">{label}</text>)}
    </svg>
    <div className="chart-foot"><span><i className="legend-dot" />{status}</span><span>Observed time · local</span></div>
  </CardContent></Card>
}

function EcgWaveform() {
  const wave = Array.from({ length: 541 }, (_, i) => {
    const x = i * 1.65
    const phase = i % 108
    let y = 39 + Math.sin(phase / 20) * 1.2
    if (phase > 20 && phase < 34) y -= Math.sin(((phase - 20) / 14) * Math.PI) * 7
    if (phase >= 48 && phase <= 56) y += ((phase - 52) / 4) * 5
    if (phase > 56 && phase < 64) y -= Math.max(0, 1 - Math.abs(phase - 60) / 4) * 35
    if (phase >= 64 && phase <= 71) y += Math.max(0, 1 - Math.abs(phase - 67.5) / 3.5) * 7
    if (phase > 76 && phase < 96) y -= Math.sin(((phase - 76) / 20) * Math.PI) * 8
    return `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
  return <Card className="ecg-card"><CardContent>
    <div className="chart-head ecg-head"><div><div className="eyebrow">Waveform viewing only</div><Typography variant="h3">Sample ECG</Typography></div><Chip icon={<MonitorHeart />} label="Lead II" size="small" variant="outlined" /></div>
    <div className="ecg-meta"><span>Source <b>Bedside monitor · synthetic</b></span><span>Capture <b>14:32:08</b></span><span>25 mm/s · 10 mm/mV</span></div>
    <svg viewBox="0 0 892 72" className="ecg-wave" role="img" aria-label="Synthetic sample Lead II ECG waveform for viewing only"><defs><pattern id="ecg-grid" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M 18 0 L 0 0 0 18" fill="none" stroke="#e6f0ee" strokeWidth="1" /></pattern></defs><rect width="892" height="72" fill="url(#ecg-grid)" rx="8" /><path d={wave} fill="none" stroke="#16877e" strokeWidth="1.8" strokeLinejoin="round" /></svg>
    <div className="ecg-note"><InfoOutlined fontSize="small" />This sample is illustrative waveform data; the prototype estimate does not use ECG.</div>
  </CardContent></Card>
}

function ReplayDialog({ open, onClose, patients, patientId, onReplay }: { open: boolean; onClose: () => void; patients: Patient[]; patientId: string; onReplay: (id: string, scenario: Scenario) => Promise<void> }) {
  const [target, setTarget] = useState(patientId || patients[0]?.patient_id || '')
  const [scenario, setScenario] = useState<Scenario>('rising')
  const [running, setRunning] = useState(false)
  useEffect(() => { if (open) { setTarget(patientId || patients[0]?.patient_id || ''); setScenario('rising') } }, [open, patientId])
  const selected = patients.find(p => p.patient_id === target)
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs"><DialogTitle className="dialog-title">Replay a synthetic scenario<IconButton onClick={onClose} aria-label="Close replay"><Close /></IconButton></DialogTitle>
    <DialogContent className="dialog-content"><Typography color="text.secondary" variant="body2">Advance timestamped demo observations for one patient. Replay updates the chart, freshness, review estimate and alert history.</Typography>
      <FormControl fullWidth size="small" className="dialog-field"><label className="field-label">Patient</label><Select value={target} onChange={e => setTarget(e.target.value)}>{patients.map(p => <MenuItem key={p.patient_id} value={p.patient_id}>{p.name} · {p.bed}</MenuItem>)}</Select></FormControl>
      <FormControl fullWidth size="small" className="dialog-field"><label className="field-label">Scenario</label><Select value={scenario} onChange={e => setScenario(e.target.value as Scenario)}>{SCENARIOS.map(s => <MenuItem key={s.id} value={s.id}>{s.title}</MenuItem>)}</Select></FormControl>
      <div className="scenario-hint"><Replay fontSize="small" /><span>{SCENARIOS.find(s => s.id === scenario)?.description}</span></div>
      {selected && <div className="replay-target"><PersonOutline fontSize="small" /><span>Patient and encounter will be validated by the demo API.</span></div>}
    </DialogContent><DialogActions className="dialog-actions"><Button color="inherit" onClick={onClose}>Cancel</Button><Button variant="contained" startIcon={running ? <CircularProgress size={15} color="inherit" /> : <Replay />} disabled={running || !target} onClick={async () => { setRunning(true); try { await onReplay(target, scenario); onClose() } finally { setRunning(false) } }}>Replay scenario</Button></DialogActions></Dialog>
}

function PatientProfile({ patient, timeline, onBack, onReplay, onAcknowledge, onReassign, actionBusy }: {
  patient: Patient; timeline: Timeline | null; onBack: () => void;
  onReplay: () => void; onAcknowledge: (alert: Alert) => void; onReassign: (alert: Alert, ownerId: string) => void; actionBusy: boolean;
}) {
  const [showAll, setShowAll] = useState(false)
  const [showRecorded, setShowRecorded] = useState(false)
  useEffect(() => { setShowAll(false); setShowRecorded(false) }, [patient.patient_id])
  const obs = patient.observations
  const staleInputs = Object.values(obs).filter(x => x.freshness === 'stale' || x.freshness === 'missing')
  const story = patient.alert?.reason || (patient.state === 'review'
    ? 'Recent recorded heart-rate observations are moving upward across the replay window. No alert is open at this point.'
    : patient.state === 'stale'
      ? 'No recent SpO₂ sample is available. The profile marks the reading as stale and leaves an explicit gap in the chart.'
      : 'Recent measured observations remain close to this patient’s synthetic baseline.')
  const codeSpecs = [
    { code: 'hr', title: 'Heart rate', unit: 'bpm' }, { code: 'spo2', title: 'Oxygen saturation', unit: '%' },
    { code: 'rr', title: 'Respiratory rate', unit: '/min' }, { code: 'temp', title: 'Temperature', unit: '°C' },
    { code: 'sbp', title: 'Systolic blood pressure', unit: 'mmHg' },
  ]
  const events = timeline?.events || []
  const visibleEvents = showAll ? events : events.slice(0, 8)
  const riskSignals = patient.risk_estimate.contributors
  return <>
    <button className="back-link" onClick={onBack}><ArrowBack fontSize="small" /> Back to ward overview</button>
    <div className="profile-heading">
      <div className="profile-heading-copy"><div className="patient-kicker"><span className="synthetic-dot" /> Synthetic patient profile <span className="kicker-dot">·</span> {patient.demo_id}</div><div className="profile-title"><Typography component="h1" variant="h1">{patient.name}</Typography><StateChip state={patient.state} /></div><div className="profile-meta"><span>{patient.bed}</span><i /> <span>{patient.ward}</span><i /> <span>Encounter {patient.encounter_id}</span><i /> <span><AccessTime fontSize="inherit" /> Updated {when(patient.last_updated)}</span></div></div>
      <div className="profile-actions"><div className="assigned-tag"><Avatar className="owner-avatar">{patient.owner.name.split(' ').at(-1)?.[0]}</Avatar><div><small>Review owner</small><b>{patient.owner.name}</b></div></div><Button variant="outlined" startIcon={<Replay />} onClick={onReplay}>Replay scenario</Button></div>
    </div>
    <div className="profile-overview-grid">
      <Card className="story-card"><CardContent>
        <div className="story-heading"><div className="story-icon"><TrendingUp /></div><div><div className="eyebrow">Signal story</div><Typography variant="h3">{patient.state === 'urgent' ? 'Open alert needs acknowledgement' : patient.state === 'review' ? 'A rising trend needs a closer look' : patient.state === 'stale' ? 'One key input is out of date' : 'Observations remain steady'}</Typography></div></div>
        <p className="story-copy">{story}</p>
        <div className="signal-strip"><span className="signal-label">What changed</span><b>{patient.scenario === 'missing' ? 'Latest oxygen sample unavailable' : patient.scenario === 'stable' ? 'Stable replay recorded' : patient.scenario === 'rising' ? 'Heart rate and respiratory rate trending up' : 'Several values crossed demo thresholds'}</b><span className="signal-time"><AccessTime fontSize="inherit" /> {when(patient.last_updated)}</span></div>
        <div className="story-bottom"><div><span className="signal-label">Contributing inputs</span><div className="contributor-list">{riskSignals.length ? riskSignals.map(x => <Chip key={x} label={x} size="small" variant="outlined" />) : <span className="muted-small">No recorded input crossed a demo alert threshold</span>}</div></div>
          <div className="stale-block"><span className="signal-label">Freshness</span>{staleInputs.length ? <div className="stale-summary"><SensorsOff fontSize="small" /><span>{staleInputs.map(x => `${x.name} ${x.freshness === 'missing' ? 'missing' : 'stale'}`).join(' · ')}</span></div> : <div className="fresh-summary"><CheckCircleOutline fontSize="small" /><span>Latest recorded inputs are current</span></div>}</div></div>
      </CardContent></Card>
      <Card className={`risk-card ${patient.state === 'urgent' ? 'risk-urgent' : ''}`}><CardContent>
        <div className="risk-top"><div><div className="eyebrow">Prototype estimate</div><Typography variant="h3">Review signal</Typography></div><InfoOutlined className="risk-info" fontSize="small" /></div>
        <div className="risk-score"><strong>{patient.risk_estimate.value}</strong><span>demo points</span></div><LinearProgress variant="determinate" value={patient.risk_estimate.value} className="risk-progress" />
        <div className="risk-range"><span>0</span><span>100</span></div>
        <div className="risk-target"><span>Target</span><b>{patient.risk_estimate.target}</b></div><div className="risk-target"><span>Horizon</span><b>{patient.risk_estimate.horizon}</b></div>
        <div className="risk-disclaimer">Transparent demo rule · not a diagnosis or clinically validated result.</div>
      </CardContent></Card>
    </div>

    <div className="section-heading"><div><div className="eyebrow">Recorded observations</div><Typography variant="h2">Vital signs over time</Typography></div><span className="section-period"><AccessTime fontSize="small" /> Last hour · local times</span></div>
    <div className="charts-grid">{codeSpecs.map(spec => <VitalChart key={spec.code} observations={timeline?.observations || []} {...spec} freshness={obs[spec.code]?.freshness} />)}</div>
    <EcgWaveform />

    <div className="lower-grid">
      <Card className="timeline-card"><CardContent>
        <div className="panel-heading"><div><div className="eyebrow">Audit history</div><Typography variant="h3">Event timeline</Typography></div><Chip label={`${events.length} events`} size="small" variant="outlined" /></div>
        <div className="event-list">{visibleEvents.length ? visibleEvents.map(event => <div className="event-item" key={event.id}><div className={`event-dot event-${event.event}`}><EventNote fontSize="small" /></div><div className="event-content"><div className="event-top"><b>{eventTitle(event)}</b><time>{clock(event.created_at)}</time></div><span>{eventDescription(event)}</span><small>{event.actor}</small></div></div>) : <div className="empty-inline">No events have been recorded yet.</div>}</div>
        {events.length > 8 && <Button className="show-history" size="small" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show recent activity' : `Show all ${events.length} events`}</Button>}
      </CardContent></Card>
      <div className="right-panels">
        <Card className="response-card"><CardContent>
          <div className="panel-heading"><div><div className="eyebrow">Response</div><Typography variant="h3">Alert ownership</Typography></div><AssignmentTurnedIn color="primary" fontSize="small" /></div>
          {patient.alert?.state === 'open' ? <><div className="alert-state-line"><span className="pulse-indicator" /> <b>Open · awaiting acknowledgement</b></div><p className="response-reason">{patient.alert.reason}</p><div className="response-owner"><Avatar className="owner-avatar">{patient.alert.owner.name.split(' ').at(-1)?.[0]}</Avatar><div><small>Currently with</small><b>{patient.alert.owner.name}</b></div></div><Button fullWidth variant="contained" startIcon={<CheckCircleOutline />} disabled={actionBusy} onClick={() => onAcknowledge(patient.alert!)}>Acknowledge alert</Button><Divider className="response-divider" /><label className="field-label">Reassign to demo clinician</label><FormControl fullWidth size="small"><Select disabled={actionBusy} displayEmpty value="" onChange={e => onReassign(patient.alert!, e.target.value)} renderValue={() => 'Choose a clinician'}><MenuItem value="clinician-1" disabled={patient.alert.owner.id === 'clinician-1'}>Dr. Ananya Sen · On duty</MenuItem><MenuItem value="clinician-2" disabled={patient.alert.owner.id === 'clinician-2'}>Dr. Rohan Iyer · Backup</MenuItem></Select></FormControl><div className="escalation-note"><SwapHoriz fontSize="small" /> Backup receives open alert after {90} sec without acknowledgement.</div></> : patient.alert?.state === 'acknowledged' ? <div className="resolved-response"><CheckCircleOutline color="success" /><div><b>Acknowledged</b><span>{patient.alert.owner.name} acknowledged · {when(patient.alert.acknowledged_at)}</span></div></div> : <div className="no-alert-state"><CheckCircleOutline /><b>No open alert</b><span>{patient.state === 'review' ? 'Trend is visible for clinician review; no alert has been created.' : patient.state === 'stale' ? 'Review the missing or stale observations before interpreting this profile.' : 'There is no active alert for this patient.'}</span></div>}
        </CardContent></Card>
        <Card className="recorded-card"><CardContent><div className="panel-heading"><div><div className="eyebrow">Latest inputs</div><Typography variant="h3">Recorded values</Typography></div><Chip label="Device measured" size="small" className="measured-chip" /></div>
          <div className="recorded-list">{codeSpecs.map(spec => { const item = obs[spec.code]; return <div key={spec.code} className="recorded-row"><div><b>{spec.title}</b><span>{item ? `Observed ${clock(item.observed_at)}` : 'No observation'}</span></div><div>{item?.value == null ? <b>—</b> : <b>{Number(item.value).toFixed(spec.code === 'temp' ? 1 : 0)} <small>{spec.unit}</small></b>}<FreshnessText observation={item} /></div></div> })}</div>
          <Button className="recorded-toggle" size="small" endIcon={<ChevronRight className={showRecorded ? 'rotate-down' : ''} />} onClick={() => setShowRecorded(!showRecorded)}>{showRecorded ? 'Hide source details' : 'Show source details'}</Button>
          {showRecorded && <div className="source-details">{codeSpecs.map(spec => { const item = obs[spec.code]; return item ? <div key={spec.code}><b>{spec.title}</b><span>{item.source} · received {clock(item.received_at)}</span></div> : null })}</div>}
        </CardContent></Card>
      </div>
    </div>
    <div className="profile-footer"><InfoOutlined fontSize="small" /><span>WardSignal is a decision-support demonstration. All people, observations, assignments and notifications shown here are synthetic.</span></div>
  </>
}

export default function App() {
  const [queue, setQueue] = useState<Queue | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [replayOpen, setReplayOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [notificationAnchor, setNotificationAnchor] = useState<HTMLElement | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const selected = queue?.patients.find(p => p.patient_id === selectedId) || null

  const refresh = useCallback(async (initial = false) => {
    try {
      const [nextQueue, nextNotifications] = await Promise.all([
        request<Queue>('/ward/queue'), request<Notification[]>('/notifications'),
      ])
      setQueue(nextQueue)
      setNotifications(nextNotifications)
      setError('')
      if (initial) setLoading(false)
      return nextQueue
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the WardSignal demo service.')
      if (initial) setLoading(false)
      throw e
    }
  }, [])

  const refreshProfile = useCallback(async (patientId: string) => {
    const [patient, nextTimeline] = await Promise.all([
      request<Patient>(`/patients/${patientId}`), request<Timeline>(`/patients/${patientId}/timeline`),
    ])
    setQueue(previous => previous ? { ...previous, patients: previous.patients.map(p => p.patient_id === patientId ? patient : p) } : previous)
    setTimeline(nextTimeline)
  }, [])

  useEffect(() => { void refresh(true) }, [refresh])
  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh().then(async () => { if (selectedId) await refreshProfile(selectedId) }).catch(() => undefined)
    }, 6000)
    return () => window.clearInterval(interval)
  }, [refresh, refreshProfile, selectedId])
  useEffect(() => {
    if (!selectedId) { setTimeline(null); return }
    void refreshProfile(selectedId).catch(e => setError(e instanceof Error ? e.message : 'Could not load patient profile.'))
  }, [selectedId, refreshProfile])

  const visiblePatients = useMemo(() => (queue?.patients || []).filter(patient => {
    const term = search.trim().toLocaleLowerCase()
    const matches = !term || `${patient.name} ${patient.demo_id} ${patient.bed} ${patient.owner.name}`.toLocaleLowerCase().includes(term)
    return matches && (filter === 'all' || patient.state === filter)
  }), [queue, search, filter])

  const replay = async (patientId: string, scenario: Scenario) => {
    const patient = queue?.patients.find(p => p.patient_id === patientId)
    if (!patient) return
    setBusy(true)
    try {
      await request('/scenarios/replay', { method: 'POST', body: JSON.stringify({ patient_id: patient.patient_id, encounter_id: patient.encounter_id, scenario }) })
      await refresh()
      if (selectedId === patientId) await refreshProfile(patientId)
      setToast(`${SCENARIOS.find(s => s.id === scenario)?.title} replayed for ${patient.name}`)
    } catch (e) { setToast(e instanceof Error ? e.message : 'Replay failed.') }
    finally { setBusy(false) }
  }

  const acknowledge = async (alert: Alert) => {
    setActionBusy(true)
    try {
      await request(`/alerts/${alert.id}/acknowledge`, { method: 'POST', body: JSON.stringify({ actor_id: queue?.on_duty.id }) })
      if (selectedId) await refreshProfile(selectedId)
      await refresh()
      setToast('Alert acknowledged and added to audit history.')
    } catch (e) { setToast(e instanceof Error ? e.message : 'Could not acknowledge this alert.') }
    finally { setActionBusy(false) }
  }

  const reassign = async (alert: Alert, ownerId: string) => {
    setActionBusy(true)
    try {
      await request(`/alerts/${alert.id}/reassign`, { method: 'POST', body: JSON.stringify({ actor_id: queue?.on_duty.id, owner_id: ownerId }) })
      if (selectedId) await refreshProfile(selectedId)
      await refresh()
      setToast('Alert reassigned and the new owner was notified.')
    } catch (e) { setToast(e instanceof Error ? e.message : 'Could not reassign this alert.') }
    finally { setActionBusy(false) }
  }

  const chooseNotification = async (notification: Notification) => {
    try { await request(`/notifications/${notification.id}/read`, { method: 'POST' }); await refresh() } catch { /* the profile remains available even if read-state sync fails */ }
    setNotificationAnchor(null)
    setSelectedId(notification.patient_id)
  }

  const unread = notifications.filter(n => !n.read).length
  return <div className="app-shell">
    <aside className="left-rail" aria-label="Primary navigation"><div className="brand-mark"><MonitorHeart /></div><div className="rail-divider" /><Tooltip title="Patients" placement="right"><button className="rail-active" aria-label="Patients" onClick={() => setSelectedId(null)}><PersonOutline /></button></Tooltip><div className="rail-spacer" /><span className="rail-synthetic">S</span></aside>
    <div className="app-main">
      <header className="topbar"><div className="mobile-brand"><div className="brand-mark small"><MonitorHeart /></div><b>WardSignal</b></div><div className="topbar-left"><div className="wordmark">WardSignal</div><span className="topbar-divider" /><div className="ward-context"><span className="context-label">DEMO WARD</span><b>{queue?.ward || 'North · Medical 3'}</b></div><span className="topbar-divider context-divider" /><div className="shift-context"><span className="context-label">SHIFT</span><b>{queue?.shift || 'Day shift · 07:00–19:00'}</b></div></div>
        <div className="topbar-right"><Chip className="demo-chip" label="Synthetic data" size="small" /><Tooltip title={`${unread} unread demo notification${unread === 1 ? '' : 's'}`}><IconButton className="notification-button" aria-label={`Notifications, ${unread} unread`} onClick={e => setNotificationAnchor(e.currentTarget)}><Badge badgeContent={unread} color="error" max={9}><NotificationsNone /></Badge></IconButton></Tooltip><div className="topbar-user"><Avatar className="user-avatar">AS</Avatar><div><b>Dr. Ananya Sen</b><span>Demo clinician</span></div></div></div>
      </header>
      <Popover open={Boolean(notificationAnchor)} anchorEl={notificationAnchor} onClose={() => setNotificationAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}><div className="notification-popover"><div className="notification-popover-head"><b>Notifications</b><span>{unread} unread</span></div>{notifications.length ? notifications.slice(0, 6).map(n => <button className={`notification-item ${n.read ? '' : 'unread'}`} key={n.id} onClick={() => void chooseNotification(n)}><span className="notification-icon"><ErrorOutline fontSize="small" /></span><span><b>{n.patient_name} · {n.demo_id}</b><small>{n.recipient.name} · {when(n.created_at)}</small></span><ChevronRight fontSize="small" /></button>) : <div className="empty-inline">No notifications.</div>}</div></Popover>
      <main className="workspace">
        {error && <MuiAlert className="service-alert" severity="error" action={<Button color="inherit" size="small" onClick={() => void refresh(true)}>Retry</Button>}>Could not load live demo data: {error}</MuiAlert>}
        {loading && !queue ? <div className="loading-state"><CircularProgress size={25} /><span>Connecting to the synthetic ward feed…</span></div> : !queue ? <Card className="unavailable-card"><InfoOutlined color="warning" /><Typography variant="h3">The ward service isn’t available</Typography><Typography color="text.secondary">Start the local API and retry to load the synthetic patient queue.</Typography><Button variant="contained" onClick={() => void refresh(true)}>Retry connection</Button></Card> : <>
          {!selected ? <>
            <div className="page-heading"><div><div className="eyebrow page-eyebrow"><span className="live-dot" /> Ward workspace</div><Typography component="h1" variant="h1">Ward overview</Typography><p>Review recent observations and see who owns the next action.</p></div><Button variant="contained" startIcon={<Replay />} onClick={() => setReplayOpen(true)}>Replay scenario</Button></div>
            <div className="summary-grid"><SummaryItem label="Patients on ward" value={queue.patients.length} foot="Synthetic demo encounters" tone="teal" icon={<PersonOutline />} /><SummaryItem label="Need review" value={queue.review_count} foot="Urgent, changing or stale" tone="amber" icon={<WarningAmber />} /><SummaryItem label="Open alerts" value={queue.urgent_count} foot="Awaiting acknowledgement" tone="coral" icon={<ErrorOutline />} /><SummaryItem label="Queue sync" value="Connected" foot={`Refreshed ${new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())}`} tone="blue" icon={<AccessTime />} /></div>
            <div className="overview-layout"><Card className="patient-list-card"><div className="list-head"><div><div className="list-title"><Typography variant="h2">Patients</Typography><Chip label={`${visiblePatients.length} shown`} size="small" variant="outlined" /></div><span>Latest recorded observations · select a patient to review the signal story</span></div><div className="list-controls"><TextField size="small" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search patients" inputProps={{ 'aria-label': 'Search patients' }} InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }} /><FormControl size="small" className="filter-select"><Select value={filter} onChange={e => setFilter(e.target.value as Filter)} aria-label="Filter patients by status"><MenuItem value="all">All states</MenuItem><MenuItem value="urgent">Open alert</MenuItem><MenuItem value="review">Review trend</MenuItem><MenuItem value="stale">Stale data</MenuItem><MenuItem value="stable">Stable</MenuItem></Select></FormControl></div></div>
              <div className="patient-table-head"><span>Patient / bed</span><span>Current state</span><span>Latest observations</span><span>Trend</span><span>Last update</span><span>Review owner</span></div>
              <div className="patient-rows">{visiblePatients.map(patient => <PatientRow key={patient.patient_id} patient={patient} onOpen={() => setSelectedId(patient.patient_id)} />)}{!visiblePatients.length && <div className="empty-list"><Search /><b>No patients match this view</b><span>Try another search or status filter.</span><Button size="small" onClick={() => { setSearch(''); setFilter('all') }}>Clear filters</Button></div>}</div>
              <div className="list-foot"><span><span className="legend-dot status-stable-dot" /> Stable</span><span><span className="legend-dot status-review-dot" /> Review trend</span><span><span className="legend-dot status-stale-dot" /> Stale / missing</span><span><span className="legend-dot status-urgent-dot" /> Open alert</span><span className="synthetic-foot"><InfoOutlined fontSize="inherit" /> All listed data is synthetic</span></div>
            </Card><aside className="overview-aside"><Card className="attention-card"><CardContent><div className="panel-heading"><div><div className="eyebrow">Needs a look</div><Typography variant="h3">Attention queue</Typography></div><span className="attention-count">{queue.review_count}</span></div><div className="attention-list">{queue.patients.filter(p => p.state !== 'stable').map(patient => <button key={patient.patient_id} className="attention-item" onClick={() => setSelectedId(patient.patient_id)}><span className={`attention-marker ${patient.state}`} /><span><b>{patient.name}</b><small>{patient.demo_id} · {patient.bed}</small></span><StateChip state={patient.state} /><ChevronRight fontSize="small" /></button>)}{!queue.review_count && <p className="muted-small">No patients currently need review.</p>}</div></CardContent></Card><Card className="shift-card"><CardContent><div className="eyebrow">Simulated shift roster</div><Typography variant="h3">Review ownership</Typography><div className="roster-person"><Avatar className="roster-avatar">AS</Avatar><div><b>{queue.on_duty.name}</b><span>On duty · 07:00–19:00</span></div><span className="on-duty-dot" /></div><div className="roster-person"><Avatar className="roster-avatar backup-avatar">RI</Avatar><div><b>{queue.backup.name}</b><span>Backup clinician</span></div><span className="backup-pill">Backup</span></div><Divider className="roster-divider" /><div className="timeout-note"><AccessTime fontSize="small" /><span>Open alerts route to the backup after <b>90 seconds</b> without acknowledgement.</span></div></CardContent></Card><div className="prototype-note"><InfoOutlined fontSize="small" /><span>WardSignal is a demo decision-support prototype. Risk thresholds are deterministic examples, not a validated clinical model.</span></div></aside></div>
          </> : <PatientProfile patient={selected} timeline={timeline} onBack={() => setSelectedId(null)} onReplay={() => setReplayOpen(true)} onAcknowledge={a => void acknowledge(a)} onReassign={(a, ownerId) => void reassign(a, ownerId)} actionBusy={actionBusy} />}
          <footer className="app-footer"><span>WardSignal · early-warning prototype</span><span><span className="footer-live-dot" /> Demo feed polling every 6 sec <span className="footer-separator">·</span> All data synthetic</span></footer>
        </>}
      </main>
    </div>
    {queue && <ReplayDialog open={replayOpen} onClose={() => setReplayOpen(false)} patients={queue.patients} patientId={selectedId || ''} onReplay={replay} />}
    <Snackbar open={Boolean(toast)} autoHideDuration={4600} onClose={() => setToast('')} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}><MuiAlert severity="success" variant="filled" onClose={() => setToast('')} sx={{ width: '100%' }}>{toast}</MuiAlert></Snackbar>
    <Snackbar open={busy} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}><MuiAlert severity="info" variant="outlined" icon={<CircularProgress size={16} />}>Advancing the synthetic observations…</MuiAlert></Snackbar>
  </div>
}
