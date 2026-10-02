from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from backend import main


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "test.db")
    main.init_db()
    with TestClient(main.app) as test_client:
        yield test_client


def test_seeded_queue_has_distinct_synthetic_states(client):
    response = client.get("/api/ward/queue")
    assert response.status_code == 200
    queue = response.json()
    assert queue["synthetic"] is True
    states = {person["demo_id"]: person["state"] for person in queue["patients"]}
    assert states["WS-1042"] == "stable"
    assert states["WS-1078"] == "review"
    assert states["WS-1091"] == "stale"
    assert states["WS-1106"] == "urgent"


def test_observation_validation_rejects_bad_types_and_missing_values():
    with pytest.raises(ValueError, match="numeric"):
        main.validate_observation_payload("p-101", "enc-101", "87", "valid")
    with pytest.raises(ValueError, match="cannot carry a value"):
        main.validate_observation_payload("p-101", "enc-101", 87, "missing")


def test_replay_updates_observations_and_reuses_open_alert(client):
    first = client.post("/api/scenarios/replay", json={"patient_id": "p-102", "encounter_id": "enc-102", "scenario": "rising"})
    assert first.status_code == 200
    assert first.json()["patient"]["alert"]["state"] == "open"
    alert_id = first.json()["patient"]["alert"]["id"]
    count_after_first = len(client.get("/api/patients/p-102/timeline").json()["observations"])
    second = client.post("/api/scenarios/replay", json={"patient_id": "p-102", "encounter_id": "enc-102", "scenario": "rising"})
    assert second.status_code == 200
    assert second.json()["patient"]["alert"]["id"] == alert_id
    history = client.get("/api/alerts/history").json()
    assert sum(row["event"] == "created" and row["alert_id"] == alert_id for row in history) == 1
    assert len(client.get("/api/patients/p-102/timeline").json()["observations"]) > count_after_first


def test_missing_replay_records_null_sample_and_stale_state(client):
    response = client.post("/api/scenarios/replay", json={"patient_id": "p-103", "encounter_id": "enc-103", "scenario": "missing"})
    assert response.status_code == 200
    patient = response.json()["patient"]
    assert patient["state"] == "stale"
    assert patient["observations"]["spo2"]["value"] is None
    assert patient["observations"]["spo2"]["quality"] == "missing"
    assert patient["observations"]["spo2"]["freshness"] == "missing"


def test_stable_replay_returns_patient_to_stable_without_open_alert(client):
    response = client.post("/api/scenarios/replay", json={"patient_id": "p-102", "encounter_id": "enc-102", "scenario": "stable"})
    assert response.status_code == 200
    assert response.json()["patient"]["state"] == "stable"
    assert response.json()["patient"]["risk_estimate"]["value"] == 0


def test_patient_encounter_mismatch_is_rejected_without_write(client):
    response = client.post("/api/scenarios/replay", json={"patient_id": "p-101", "encounter_id": "enc-104", "scenario": "stable"})
    assert response.status_code == 422
    assert "do not match" in response.json()["detail"]


def test_acknowledgement_and_reassignment_are_audited(client):
    reassigned = client.post("/api/alerts/al-p-104/reassign", json={"owner_id": "clinician-2"})
    assert reassigned.status_code == 200
    assert reassigned.json()["alert"]["owner"]["id"] == "clinician-2"
    assert client.post("/api/alerts/al-p-104/acknowledge", json={}).status_code == 200
    events = client.get("/api/patients/p-104/timeline").json()["events"]
    assert any(row["event"] == "reassigned" for row in events)
    assert any(row["event"] == "acknowledged" for row in events)


def test_unacknowledged_alert_escalates_to_backup_after_demo_timeout(client):
    with main.connect() as db:
        old = main.stamp(main.now() - timedelta(seconds=main.ESCALATION_SECONDS + 1))
        db.execute("UPDATE alerts SET created_at = ?, assigned_at = ? WHERE id = ?", (old, old, "al-p-104"))
    queue = client.get("/api/ward/queue").json()
    patient = next(row for row in queue["patients"] if row["patient_id"] == "p-104")
    assert patient["alert"]["owner"]["id"] == "clinician-2"
    events = client.get("/api/alerts/history").json()
    assert any(row["event"] == "escalated" and row["alert_id"] == "al-p-104" for row in events)
    notifications = client.get("/api/notifications").json()
    assert any(row["recipient"]["id"] == "clinician-2" and row["alert_id"] == "al-p-104" for row in notifications)
