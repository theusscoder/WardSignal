from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


DB_PATH = Path(os.environ.get("WARDSIGNAL_DB", Path(__file__).with_name("wardsignal.db")))
DEMO_WARD = "North · Medical 3"
ON_DUTY = {"id": "clinician-1", "name": "Dr. Ananya Sen", "role": "On duty"}
BACKUP = {"id": "clinician-2", "name": "Dr. Rohan Iyer", "role": "Backup"}
ROSTER = {person["id"]: person for person in (ON_DUTY, BACKUP)}
ESCALATION_SECONDS = 90

app = FastAPI(title="WardSignal synthetic demo API", version="0.1.0")
configured_origins = [
    origin.strip()
    for origin in os.environ.get("WARDSIGNAL_CORS_ORIGINS", "").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", *configured_origins],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_stamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS patients (
              patient_id TEXT PRIMARY KEY, encounter_id TEXT NOT NULL,
              demo_id TEXT NOT NULL, display_name TEXT NOT NULL, bed TEXT NOT NULL,
              ward TEXT NOT NULL, owner_id TEXT NOT NULL, scenario TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS observations (
              id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL,
              encounter_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
              value REAL, unit TEXT NOT NULL, observed_at TEXT NOT NULL,
              received_at TEXT NOT NULL, source TEXT NOT NULL, quality TEXT NOT NULL,
              FOREIGN KEY(patient_id) REFERENCES patients(patient_id)
            );
            CREATE TABLE IF NOT EXISTS alerts (
              id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, state TEXT NOT NULL,
              owner_id TEXT NOT NULL, score INTEGER NOT NULL, reason TEXT NOT NULL,
              created_at TEXT NOT NULL, assigned_at TEXT NOT NULL, acknowledged_at TEXT, escalated_at TEXT,
              FOREIGN KEY(patient_id) REFERENCES patients(patient_id)
            );
            CREATE TABLE IF NOT EXISTS audit (
              id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT, patient_id TEXT NOT NULL,
              event TEXT NOT NULL, actor TEXT NOT NULL, details TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notifications (
              id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT NOT NULL,
              patient_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
              created_at TEXT NOT NULL, read_at TEXT
            );
            CREATE INDEX IF NOT EXISTS observation_patient_time ON observations(patient_id, observed_at);
            CREATE INDEX IF NOT EXISTS audit_alert ON audit(alert_id, created_at);
            """
        )
        alert_columns = {row["name"] for row in db.execute("PRAGMA table_info(alerts)").fetchall()}
        if "assigned_at" not in alert_columns:
            db.execute("ALTER TABLE alerts ADD COLUMN assigned_at TEXT")
            db.execute("UPDATE alerts SET assigned_at = created_at WHERE assigned_at IS NULL")
        count = db.execute("SELECT COUNT(*) FROM patients").fetchone()[0]
        if not count:
            seed_demo(db)


def audit(db: sqlite3.Connection, patient_id: str, event: str, actor: str,
          details: dict, alert_id: str | None = None, at: datetime | None = None) -> None:
    db.execute(
        "INSERT INTO audit(alert_id, patient_id, event, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (alert_id, patient_id, event, actor, json.dumps(details), stamp(at or now())),
    )


def add_observation(db: sqlite3.Connection, patient: sqlite3.Row, code: str, value: float | None,
                    unit: str, observed_at: datetime, quality: str = "valid",
                    source: str = "Bedside monitor · synthetic") -> None:
    if not patient["patient_id"] or not patient["encounter_id"]:
        raise ValueError("Patient and encounter are required")
    if quality not in {"valid", "stale", "missing"}:
        raise ValueError("Unsupported data-quality state")
    if quality == "missing" and value is not None:
        raise ValueError("Missing observations cannot carry a value")
    if quality != "missing" and value is None:
        raise ValueError("Measured observations require a value")
    names = {"hr": "Heart rate", "spo2": "Oxygen saturation", "rr": "Respiratory rate", "temp": "Temperature", "sbp": "Systolic blood pressure"}
    db.execute(
        "INSERT INTO observations(patient_id, encounter_id, code, name, value, unit, observed_at, received_at, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (patient["patient_id"], patient["encounter_id"], code, names[code], value, unit,
         stamp(observed_at), stamp(now()), source, quality),
    )


def seed_demo(db: sqlite3.Connection) -> None:
    patients = [
        ("p-101", "enc-101", "WS-1042", "Meera Nair", "Bed 12", ON_DUTY["id"], "stable"),
        ("p-102", "enc-102", "WS-1078", "Arjun Menon", "Bed 14", ON_DUTY["id"], "rising"),
        ("p-103", "enc-103", "WS-1091", "Ayesha Khan", "Bed 18", BACKUP["id"], "missing"),
        ("p-104", "enc-104", "WS-1106", "Devika Iyer", "Bed 21", ON_DUTY["id"], "unacknowledged"),
        ("p-105", "enc-105", "WS-1133", "Kabir Rao", "Bed 24", BACKUP["id"], "stable"),
    ]
    db.executemany(
        "INSERT INTO patients(patient_id, encounter_id, demo_id, display_name, bed, ward, owner_id, scenario) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [(pid, enc, demo, name, bed, DEMO_WARD, owner, scenario) for pid, enc, demo, name, bed, owner, scenario in patients],
    )
    baseline = {
        "p-101": {"hr": [72, 73, 72, 74, 73, 74], "spo2": [98, 98, 97, 98, 98, 98], "rr": [15, 15, 16, 15, 15, 15], "temp": [36.7, 36.7, 36.8, 36.7, 36.7, 36.7], "sbp": [118, 119, 117, 118, 120, 119]},
        "p-102": {"hr": [88, 91, 96, 99, 103, 106], "spo2": [97, 97, 96, 96, 95, 94], "rr": [17, 18, 19, 20, 21, 22], "temp": [36.8, 36.9, 37, 37.2, 37.5, 37.8], "sbp": [122, 121, 120, 118, 116, 114]},
        "p-103": {"hr": [78, 79, 77, 78, 80], "spo2": [97, 97, 96, 97], "rr": [16, 16, 16, 17, 16], "temp": [36.8, 36.8, 36.8, 36.9, 36.8], "sbp": [116, 117, 118, 117, 116]},
        "p-104": {"hr": [91, 98, 104, 109, 114, 118], "spo2": [96, 95, 94, 93, 92, 91], "rr": [19, 20, 22, 24, 25, 27], "temp": [37.2, 37.3, 37.5, 37.8, 38, 38.3], "sbp": [109, 106, 104, 102, 99, 96]},
        "p-105": {"hr": [67, 68, 68, 69, 67, 68], "spo2": [98, 98, 99, 98, 98, 98], "rr": [14, 14, 15, 14, 14, 14], "temp": [36.5, 36.5, 36.6, 36.5, 36.5, 36.5], "sbp": [124, 123, 124, 126, 124, 125]},
    }
    units = {"hr": "bpm", "spo2": "%", "rr": "/min", "temp": "°C", "sbp": "mmHg"}
    for patient_id, values in baseline.items():
        patient = db.execute("SELECT * FROM patients WHERE patient_id = ?", (patient_id,)).fetchone()
        count = min(len(v) for v in values.values())
        age = 48 if patient_id == "p-103" else 10
        for index in range(count):
            observed = now() - timedelta(minutes=age + (count - index - 1) * 4)
            for code in ("hr", "spo2", "rr", "temp", "sbp"):
                if patient_id == "p-103" and index == count - 1 and code == "spo2":
                    continue
                add_observation(db, patient, code, float(values[code][index]), units[code], observed)
    # These seeded alerts and their history are explicitly simulated examples.
    for patient_id, score, reason in (
        ("p-104", 95, "Several recent observations crossed the transparent prototype review thresholds."),
    ):
        patient = db.execute("SELECT * FROM patients WHERE patient_id = ?", (patient_id,)).fetchone()
        alert_id = f"al-{patient_id}"
        created = now() - timedelta(seconds=30)
        db.execute(
            "INSERT INTO alerts(id, patient_id, state, owner_id, score, reason, created_at, assigned_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?)",
            (alert_id, patient_id, patient["owner_id"], score, reason, stamp(created), stamp(created)),
        )
        audit(db, patient_id, "created", "WardSignal demo", {"state": "open", "score": score}, alert_id, created)
        db.execute("INSERT INTO notifications(alert_id, patient_id, recipient_id, created_at) VALUES (?, ?, ?, ?)",
                   (alert_id, patient_id, patient["owner_id"], stamp(created)))
        audit(db, patient_id, "delivered", ROSTER[patient["owner_id"]]["name"], {"channel": "in-app"}, alert_id, created + timedelta(seconds=1))


def risk_for(latest: dict[str, sqlite3.Row]) -> tuple[int, list[str]]:
    contributions = []
    checks = (("hr", 110, "gt", 25, "Heart rate above 110 bpm"),
              ("rr", 23, "gt", 25, "Respiratory rate above 23/min"),
              ("spo2", 94, "lt", 25, "Oxygen saturation below 94%"),
              ("temp", 38.0, "gte", 25, "Temperature at or above 38.0°C"),
              ("sbp", 100, "lt", 25, "Systolic pressure below 100 mmHg"))
    for code, limit, direction, points, label in checks:
        item = latest.get(code)
        if not item or item["quality"] != "valid" or item["value"] is None:
            continue
        value = item["value"]
        crossed = value > limit if direction == "gt" else value < limit if direction == "lt" else value >= limit
        if crossed:
            contributions.append((points, label))
    return min(100, sum(x[0] for x in contributions)), [x[1] for x in contributions]


def latest_observations(db: sqlite3.Connection, patient_id: str) -> dict[str, sqlite3.Row]:
    rows = db.execute("SELECT * FROM observations WHERE patient_id = ? ORDER BY observed_at DESC, id DESC", (patient_id,)).fetchall()
    latest: dict[str, sqlite3.Row] = {}
    for row in rows:
        latest.setdefault(row["code"], row)
    return latest


def patient_state(db: sqlite3.Connection, patient: sqlite3.Row) -> tuple[str, int, dict[str, sqlite3.Row]]:
    latest = latest_observations(db, patient["patient_id"])
    score, _ = risk_for(latest)
    open_alert = db.execute("SELECT id FROM alerts WHERE patient_id = ? AND state = 'open'", (patient["patient_id"],)).fetchone()
    if open_alert:
        return "urgent", score, latest
    stale = False
    for row in latest.values():
        if row["quality"] in {"stale", "missing"} or now() - parse_stamp(row["observed_at"]) > timedelta(minutes=20):
            stale = True
    if score >= 25 or patient["scenario"] == "rising":
        return "review", score, latest
    return ("stale" if stale else "stable"), score, latest


def process_escalations(db: sqlite3.Connection) -> None:
    alerts = db.execute("SELECT * FROM alerts WHERE state = 'open' AND escalated_at IS NULL").fetchall()
    for alert in alerts:
        if alert["owner_id"] != ON_DUTY["id"]:
            continue
        assigned_at = alert["assigned_at"] or alert["created_at"]
        if (now() - parse_stamp(assigned_at)).total_seconds() < ESCALATION_SECONDS:
            continue
        db.execute("UPDATE alerts SET owner_id = ?, assigned_at = ?, escalated_at = ? WHERE id = ?", (BACKUP["id"], stamp(now()), stamp(now()), alert["id"]))
        db.execute("INSERT INTO notifications(alert_id, patient_id, recipient_id, created_at) VALUES (?, ?, ?, ?)",
                   (alert["id"], alert["patient_id"], BACKUP["id"], stamp(now())))
        audit(db, alert["patient_id"], "escalated", "WardSignal demo", {"from": ROSTER[alert["owner_id"]]["name"], "to": BACKUP["name"], "after_seconds": ESCALATION_SECONDS}, alert["id"])


def obs_dict(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "patient_id": row["patient_id"], "encounter_id": row["encounter_id"],
            "code": row["code"], "name": row["name"], "value": row["value"], "unit": row["unit"],
            "observed_at": row["observed_at"], "received_at": row["received_at"],
            "source": row["source"], "quality": row["quality"], "kind": "measured" if row["quality"] == "valid" else "missing"}


def alert_dict(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "state": row["state"], "owner": ROSTER.get(row["owner_id"], BACKUP),
            "score": row["score"], "reason": row["reason"], "created_at": row["created_at"],
            "acknowledged_at": row["acknowledged_at"], "escalated_at": row["escalated_at"]}


def patient_dict(db: sqlite3.Connection, patient: sqlite3.Row) -> dict:
    state, score, latest = patient_state(db, patient)
    observations = {}
    for code, row in latest.items():
        value = obs_dict(row)
        freshness = "missing" if row["quality"] == "missing" else "stale" if row["quality"] == "stale" or now() - parse_stamp(row["observed_at"]) > timedelta(minutes=20) else "fresh"
        value["freshness"] = freshness
        observations[code] = value
    history = db.execute("SELECT value, observed_at, quality FROM observations WHERE patient_id = ? AND code = 'hr' ORDER BY observed_at DESC, id DESC LIMIT 7", (patient["patient_id"],)).fetchall()
    trend = [{"value": row["value"], "observed_at": row["observed_at"], "quality": row["quality"]} for row in reversed(history)]
    rows = db.execute("SELECT * FROM observations WHERE patient_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1", (patient["patient_id"],)).fetchone()
    updated = rows["observed_at"] if rows else None
    alert = db.execute("SELECT * FROM alerts WHERE patient_id = ? AND state IN ('open', 'acknowledged') ORDER BY created_at DESC LIMIT 1", (patient["patient_id"],)).fetchone()
    _, why = risk_for(latest)
    return {"patient_id": patient["patient_id"], "encounter_id": patient["encounter_id"], "demo_id": patient["demo_id"],
            "name": patient["display_name"], "bed": patient["bed"], "ward": patient["ward"],
            "state": state, "last_updated": updated, "owner": ROSTER.get(alert["owner_id"] if alert else patient["owner_id"], ON_DUTY),
            "observations": observations, "trend": trend, "risk_estimate": {"value": score, "target": "review-threshold crossings in recorded observations", "horizon": "current snapshot", "label": "Prototype estimate", "contributors": why},
            "alert": alert_dict(alert) if alert else None, "scenario": patient["scenario"]}


def validate_patient_encounter(db: sqlite3.Connection, patient_id: str, encounter_id: str) -> sqlite3.Row:
    patient = db.execute("SELECT * FROM patients WHERE patient_id = ?", (patient_id,)).fetchone()
    if patient is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    if patient["encounter_id"] != encounter_id:
        raise HTTPException(status_code=422, detail="Patient and encounter IDs do not match; observation was not stored")
    return patient


def refresh_alert(db: sqlite3.Connection, patient: sqlite3.Row, at: datetime) -> None:
    latest = latest_observations(db, patient["patient_id"])
    score, contributors = risk_for(latest)
    existing = db.execute("SELECT * FROM alerts WHERE patient_id = ? AND state = 'open' ORDER BY created_at DESC LIMIT 1", (patient["patient_id"],)).fetchone()
    most_recent = db.execute("SELECT * FROM alerts WHERE patient_id = ? ORDER BY created_at DESC LIMIT 1", (patient["patient_id"],)).fetchone()
    if score >= 50:
        reason = ("Prototype thresholds crossed: " + "; ".join(contributors) + ".") if contributors else "Prototype thresholds crossed in recent observations."
        if existing:
            db.execute("UPDATE alerts SET score = ?, reason = ? WHERE id = ?", (score, reason, existing["id"]))
            audit(db, patient["patient_id"], "updated", "WardSignal demo", {"score": score, "contributors": contributors}, existing["id"], at)
        elif most_recent and most_recent["state"] == "acknowledged":
            # Keep one alert episode through acknowledgement; further high readings update it without another delivery.
            db.execute("UPDATE alerts SET score = ?, reason = ? WHERE id = ?", (score, reason, most_recent["id"]))
            audit(db, patient["patient_id"], "updated", "WardSignal demo", {"score": score, "contributors": contributors, "after_acknowledgement": True}, most_recent["id"], at)
        else:
            alert_id = f"al-{uuid4().hex[:8]}"
            owner = patient["owner_id"]
            db.execute("INSERT INTO alerts(id, patient_id, state, owner_id, score, reason, created_at, assigned_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?)",
                       (alert_id, patient["patient_id"], owner, score, reason, stamp(at), stamp(at)))
            audit(db, patient["patient_id"], "created", "WardSignal demo", {"state": "open", "score": score, "contributors": contributors}, alert_id, at)
            db.execute("INSERT INTO notifications(alert_id, patient_id, recipient_id, created_at) VALUES (?, ?, ?, ?)",
                       (alert_id, patient["patient_id"], owner, stamp(at)))
            audit(db, patient["patient_id"], "delivered", ROSTER[owner]["name"], {"channel": "in-app"}, alert_id, at)
    elif most_recent and most_recent["state"] in {"open", "acknowledged"} and score < 50:
        db.execute("UPDATE alerts SET state = 'resolved' WHERE id = ?", (most_recent["id"],))
        audit(db, patient["patient_id"], "resolved", "WardSignal demo", {"score": score, "reason": "No longer above the demo alert threshold."}, most_recent["id"], at)


class ReplayRequest(BaseModel):
    patient_id: str
    encounter_id: str
    scenario: Literal["rising", "stable", "missing", "unacknowledged"]


class ActionRequest(BaseModel):
    actor_id: str = Field(default=ON_DUTY["id"])


class ReassignRequest(ActionRequest):
    owner_id: str


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict:
    init_db()
    return {"ok": True, "data": "synthetic"}


@app.get("/api/ward/queue")
def ward_queue() -> dict:
    init_db()
    with connect() as db:
        process_escalations(db)
        patients = db.execute("SELECT * FROM patients ORDER BY CASE WHEN patient_id = 'p-104' THEN 0 WHEN patient_id = 'p-102' THEN 1 ELSE 2 END, bed").fetchall()
        items = [patient_dict(db, patient) for patient in patients]
        return {"ward": DEMO_WARD, "shift": "Day shift · 07:00–19:00", "synthetic": True,
                "on_duty": ON_DUTY, "backup": BACKUP, "review_count": sum(p["state"] in {"urgent", "review", "stale"} for p in items),
                "urgent_count": sum(p["state"] == "urgent" for p in items), "patients": items}


@app.get("/api/patients")
def list_patients() -> list[dict]:
    return ward_queue()["patients"]


@app.get("/api/patients/{patient_id}")
def get_patient(patient_id: str) -> dict:
    init_db()
    with connect() as db:
        process_escalations(db)
        patient = db.execute("SELECT * FROM patients WHERE patient_id = ?", (patient_id,)).fetchone()
        if patient is None:
            raise HTTPException(status_code=404, detail="Patient not found")
        return patient_dict(db, patient)


@app.get("/api/patients/{patient_id}/timeline")
def timeline(patient_id: str) -> dict:
    init_db()
    with connect() as db:
        patient = db.execute("SELECT * FROM patients WHERE patient_id = ?", (patient_id,)).fetchone()
        if patient is None:
            raise HTTPException(status_code=404, detail="Patient not found")
        observations = [obs_dict(row) for row in db.execute("SELECT * FROM observations WHERE patient_id = ? ORDER BY observed_at, id", (patient_id,)).fetchall()]
        events = audit_history(db, patient_id)
        rows = db.execute("SELECT * FROM observations WHERE patient_id = ?", (patient_id,)).fetchall()
        events.extend({"id": f"obs-{row['id']}", "alert_id": None, "patient_id": patient_id,
                       "event": "observation", "actor": row["source"],
                       "details": {"name": row["name"], "value": row["value"], "unit": row["unit"], "quality": row["quality"]},
                       "created_at": row["received_at"]} for row in rows)
        events.sort(key=lambda item: item["created_at"], reverse=True)
        return {"patient_id": patient_id, "encounter_id": patient["encounter_id"], "observations": observations, "events": events}


def audit_history(db: sqlite3.Connection, patient_id: str, alert_id: str | None = None) -> list[dict]:
    if alert_id:
        rows = db.execute("SELECT * FROM audit WHERE patient_id = ? AND alert_id = ? ORDER BY created_at DESC, id DESC", (patient_id, alert_id)).fetchall()
    else:
        rows = db.execute("SELECT * FROM audit WHERE patient_id = ? ORDER BY created_at DESC, id DESC", (patient_id,)).fetchall()
    return [{"id": row["id"], "alert_id": row["alert_id"], "patient_id": row["patient_id"], "event": row["event"], "actor": row["actor"], "details": json.loads(row["details"]), "created_at": row["created_at"]} for row in rows]


@app.get("/api/alerts/history")
def alert_history() -> list[dict]:
    init_db()
    with connect() as db:
        process_escalations(db)
        return [item for patient in db.execute("SELECT patient_id FROM patients").fetchall() for item in audit_history(db, patient["patient_id"]) if item["alert_id"]]


@app.get("/api/notifications")
def notifications() -> list[dict]:
    init_db()
    with connect() as db:
        process_escalations(db)
        rows = db.execute("SELECT n.*, p.display_name, p.demo_id, a.state FROM notifications n JOIN patients p USING(patient_id) JOIN alerts a ON a.id = n.alert_id ORDER BY n.created_at DESC LIMIT 20").fetchall()
        return [{"id": row["id"], "alert_id": row["alert_id"], "patient_id": row["patient_id"], "patient_name": row["display_name"], "demo_id": row["demo_id"], "recipient": ROSTER.get(row["recipient_id"], BACKUP), "created_at": row["created_at"], "read": row["read_at"] is not None, "state": row["state"]} for row in rows]


@app.post("/api/notifications/{notification_id}/read")
def mark_notification_read(notification_id: int) -> dict:
    init_db()
    with connect() as db:
        row = db.execute("SELECT id FROM notifications WHERE id = ?", (notification_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Notification not found")
        db.execute("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?", (stamp(now()), notification_id))
        return {"ok": True}


@app.post("/api/scenarios/replay")
def replay(body: ReplayRequest) -> dict:
    init_db()
    with connect() as db:
        patient = validate_patient_encounter(db, body.patient_id, body.encounter_id)
        at = now()
        db.execute("UPDATE patients SET scenario = ? WHERE patient_id = ?", (body.scenario, body.patient_id))
        latest = latest_observations(db, body.patient_id)
        if body.scenario == "missing":
            # A missing SpO₂ sample creates an explicit chart gap, never an imputed measurement.
            add_observation(db, patient, "spo2", None, "%", at, "missing", "Scenario simulator · unavailable")
        else:
            units = {"hr": "bpm", "spo2": "%", "rr": "/min", "temp": "°C", "sbp": "mmHg"}
            current = {code: (row["value"] if row["quality"] == "valid" and row["value"] is not None else base)
                       for code, row, base in (("hr", latest.get("hr"), 76), ("spo2", latest.get("spo2"), 97), ("rr", latest.get("rr"), 16), ("temp", latest.get("temp"), 36.8), ("sbp", latest.get("sbp"), 118))}
            if body.scenario == "rising":
                increments = {"hr": 5, "spo2": -1, "rr": 2, "temp": 0.2, "sbp": -2}
                values = {code: current[code] + increments[code] for code in current}
            elif body.scenario == "unacknowledged":
                values = {"hr": max(current["hr"], 112), "spo2": min(current["spo2"], 92), "rr": max(current["rr"], 25), "temp": max(current["temp"], 38.2), "sbp": min(current["sbp"], 98)}
            else:
                values = {"hr": 74, "spo2": 98, "rr": 15, "temp": 36.7, "sbp": 120}
            for code, value in values.items():
                add_observation(db, patient, code, round(float(value), 1), units[code], at)
        refresh_alert(db, patient, at)
        audit(db, body.patient_id, "replayed", "WardSignal demo", {"scenario": body.scenario}, at=at)
        patient = db.execute("SELECT * FROM patients WHERE patient_id = ?", (body.patient_id,)).fetchone()
        return {"patient": patient_dict(db, patient), "message": f"{body.scenario.title()} scenario replayed", "synthetic": True}


@app.post("/api/alerts/{alert_id}/acknowledge")
def acknowledge(alert_id: str, body: ActionRequest) -> dict:
    init_db()
    with connect() as db:
        alert = db.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
        if alert is None:
            raise HTTPException(status_code=404, detail="Alert not found")
        if alert["state"] != "open":
            raise HTTPException(status_code=409, detail="This alert is no longer open")
        if body.actor_id not in ROSTER:
            raise HTTPException(status_code=422, detail="Unknown demo clinician")
        at = now()
        db.execute("UPDATE alerts SET state = 'acknowledged', acknowledged_at = ? WHERE id = ?", (stamp(at), alert_id))
        audit(db, alert["patient_id"], "acknowledged", ROSTER[body.actor_id]["name"], {}, alert_id, at)
        patient = db.execute("SELECT * FROM patients WHERE patient_id = ?", (alert["patient_id"],)).fetchone()
        return {"patient": patient_dict(db, patient), "alert": alert_dict(db.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone())}


@app.post("/api/alerts/{alert_id}/reassign")
def reassign(alert_id: str, body: ReassignRequest) -> dict:
    init_db()
    with connect() as db:
        alert = db.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
        if alert is None:
            raise HTTPException(status_code=404, detail="Alert not found")
        if alert["state"] != "open":
            raise HTTPException(status_code=409, detail="This alert is no longer open")
        if body.owner_id not in ROSTER or body.owner_id == alert["owner_id"]:
            raise HTTPException(status_code=422, detail="Choose a different clinician from the simulated shift roster")
        if body.actor_id not in ROSTER:
            raise HTTPException(status_code=422, detail="Unknown demo clinician")
        at = now()
        db.execute("UPDATE alerts SET owner_id = ?, assigned_at = ?, escalated_at = NULL WHERE id = ?", (body.owner_id, stamp(at), alert_id))
        db.execute("INSERT INTO notifications(alert_id, patient_id, recipient_id, created_at) VALUES (?, ?, ?, ?)",
                   (alert_id, alert["patient_id"], body.owner_id, stamp(at)))
        audit(db, alert["patient_id"], "reassigned", ROSTER[body.actor_id]["name"], {"from": ROSTER[alert["owner_id"]]["name"], "to": ROSTER[body.owner_id]["name"]}, alert_id, at)
        audit(db, alert["patient_id"], "delivered", ROSTER[body.owner_id]["name"], {"channel": "in-app"}, alert_id, at)
        patient = db.execute("SELECT * FROM patients WHERE patient_id = ?", (alert["patient_id"],)).fetchone()
        return {"patient": patient_dict(db, patient), "alert": alert_dict(db.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone())}


def validate_observation_payload(patient_id: str, encounter_id: str, value: object, quality: str) -> None:
    if not patient_id or not encounter_id:
        raise ValueError("Patient and encounter IDs are required")
    if quality not in {"valid", "stale", "missing"}:
        raise ValueError("Unsupported data-quality state")
    if quality == "missing":
        if value is not None:
            raise ValueError("Missing observations cannot carry a value")
    elif isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError("A measured observation value must be numeric")


def insert_observation_checked(db: sqlite3.Connection, patient_id: str, encounter_id: str, code: str,
                               value: float | None, unit: str, observed_at: datetime,
                               quality: str = "valid") -> None:
    validate_observation_payload(patient_id, encounter_id, value, quality)
    patient = validate_patient_encounter(db, patient_id, encounter_id)
    if code not in {"hr", "spo2", "rr", "temp", "sbp"}:
        raise HTTPException(status_code=422, detail="Unknown observation code")
    add_observation(db, patient, code, float(value) if value is not None else None, unit, observed_at, quality)


init_db()
