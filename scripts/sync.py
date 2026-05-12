#!/usr/bin/env python3
"""Sync Todoist Pantry project state to data/pantry.json."""

from __future__ import annotations
import json, os, re, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests

PANTRY_PROJECT_ID = "6gcmCjvW6GHh9FGQ"
REST_BASE = "https://api.todoist.com/rest/v2"
SYNC_BASE = "https://api.todoist.com/sync/v9"
REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = REPO_ROOT / "data" / "pantry.json"

DESC_RE = {
    "purchased": re.compile(r"^Purchased:\s*(?P<date>\d{4}-\d{2}-\d{2})\s+at\s+(?P<store>.+?)\s*$", re.MULTILINE),
    "qty": re.compile(r"^Qty:\s*(?P<qty>[\d.]+)\s+(?P<unit>\S+)\s*(?:@\s*\$(?P<price>[\d.]+)(?:/\S+)?)?\s*$", re.MULTILINE),
    "total": re.compile(r"^Total:\s*\$(?P<total>[\d.]+)\s*$", re.MULTILINE),
}

def auth_headers():
    token = os.environ.get("TODOIST_API_TOKEN")
    if not token: sys.exit("TODOIST_API_TOKEN env var is not set")
    return {"Authorization": f"Bearer {token}"}

def get_sections(headers):
    r = requests.get(f"{REST_BASE}/sections", headers=headers, params={"project_id": PANTRY_PROJECT_ID}, timeout=30)
    r.raise_for_status()
    return {s["id"]: s["name"] for s in r.json()}

def get_open_tasks(headers):
    r = requests.get(f"{REST_BASE}/tasks", headers=headers, params={"project_id": PANTRY_PROJECT_ID}, timeout=30)
    r.raise_for_status()
    return r.json()

def get_completed_tasks(headers, since_days=365):
    since = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%Y-%m-%dT%H:%M:%S")
    items, offset = [], 0
    while True:
        r = requests.get(f"{SYNC_BASE}/completed/get_all", headers=headers,
                         params={"project_id": PANTRY_PROJECT_ID, "since": since, "limit": 200, "offset": offset}, timeout=30)
        r.raise_for_status()
        batch = r.json().get("items", [])
        if not batch: break
        items.extend(batch)
        if len(batch) < 200: break
        offset += 200
    return items

def parse_description(desc):
    out = {"purchased_date": None, "store": None, "qty": None, "unit": None, "unit_price": None, "total": None}
    if not desc: return out
    m = DESC_RE["purchased"].search(desc)
    if m: out["purchased_date"] = m.group("date"); out["store"] = m.group("store").strip()
    m = DESC_RE["qty"].search(desc)
    if m:
        out["qty"] = float(m.group("qty")); out["unit"] = m.group("unit")
        if m.group("price"): out["unit_price"] = float(m.group("price"))
    m = DESC_RE["total"].search(desc)
    if m: out["total"] = float(m.group("total"))
    return out

def classify_status(task, completed):
    if not completed: return "in_pantry"
    labels = set(task.get("labels") or [])
    if "wasted-spoiled" in labels: return "wasted-spoiled"
    if "wasted-rejected" in labels: return "wasted-rejected"
    return "consumed"

def days_between(start_iso, end_iso):
    if not start_iso: return None
    end = end_iso or datetime.now(timezone.utc).isoformat()
    try:
        s = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
        e = datetime.fromisoformat(end.replace("Z", "+00:00"))
        return max(0, (e.date() - s.date()).days)
    except ValueError: return None

def to_item(task, sections, completed):
    meta = parse_description(task.get("description", ""))
    added_at = task.get("added_at") or task.get("created_at")
    completed_at = task.get("completed_at") if completed else None
    return {
        "id": task["id"], "name": task.get("content", ""),
        "section": sections.get(task.get("section_id"), "Other"),
        "status": classify_status(task, completed),
        "purchased_date": meta["purchased_date"], "store": meta["store"],
        "qty": meta["qty"], "unit": meta["unit"],
        "unit_price": meta["unit_price"], "total": meta["total"],
        "added_at": added_at, "completed_at": completed_at,
        "days_held": days_between(added_at, completed_at),
        "labels": task.get("labels") or [],
    }

def main():
    headers = auth_headers()
    sections = get_sections(headers)
    open_tasks = get_open_tasks(headers)
    completed_tasks = get_completed_tasks(headers)
    items = [to_item(t, sections, False) for t in open_tasks] + [to_item(t, sections, True) for t in completed_tasks]
    payload = {"last_sync": datetime.now(timezone.utc).isoformat(timespec="seconds"), "items": items}
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"Wrote {len(items)} items to {OUT_PATH.relative_to(REPO_ROOT)}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
