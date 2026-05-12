#!/usr/bin/env python3
"""
Sync Todoist Pantry project state to data/pantry.json.

Uses the Todoist unified API v1 (https://api.todoist.com/api/v1/).
The old REST v2 endpoints (api.todoist.com/rest/v2/*) return 410 Gone.

Reads:
  - Open tasks
  - Sections
  - Completed tasks (looped 6-week windows back WEEKS_BACK weeks)

Parses task descriptions in the format:
    Purchased: YYYY-MM-DD at <store>
    Qty: N <unit> @ $X.XX/<unit>
    Total: $X.XX

Writes data/pantry.json (overwrites).

Env:
  TODOIST_API_TOKEN - required
  WEEKS_BACK        - optional, default 12 (how far back to look for completions)
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

PANTRY_PROJECT_ID = "6gcmCjvW6GHh9FGQ"

BASE = "https://api.todoist.com/api/v1"

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = REPO_ROOT / "data" / "pantry.json"

DESC_RE = {
    "purchased": re.compile(
        r"^Purchased:\s*(?P<date>\d{4}-\d{2}-\d{2})\s+at\s+(?P<store>.+?)\s*$",
        re.MULTILINE,
    ),
    "qty": re.compile(
        r"^Qty:\s*(?P<qty>[\d.]+)\s+(?P<unit>\S+)\s*(?:@\s*\$(?P<price>[\d.]+)(?:/\S+)?)?\s*$",
        re.MULTILINE,
    ),
    "total": re.compile(
        r"^Total:\s*\$(?P<total>[\d.]+)\s*$",
        re.MULTILINE,
    ),
}


def auth_headers() -> dict[str, str]:
    token = os.environ.get("TODOIST_API_TOKEN")
    if not token:
        sys.exit("TODOIST_API_TOKEN env var is not set")
    return {"Authorization": f"Bearer {token}"}


def paginate(url: str, headers: dict, params: dict) -> list[dict]:
    """GET a v1 endpoint and walk cursor pagination, returning all results.

    v1 paginated responses use the envelope:
        { "results": [...], "next_cursor": "..." | null }
    Some endpoints (completed-by-date) use "items" instead of "results".
    """
    out: list[dict] = []
    p = dict(params)
    while True:
        r = requests.get(url, headers=headers, params=p, timeout=30)
        r.raise_for_status()
        data = r.json()
        batch = data.get("results") or data.get("items") or []
        out.extend(batch)
        cursor = data.get("next_cursor")
        if not cursor:
            break
        p["cursor"] = cursor
    return out


def get_sections(headers: dict) -> dict[str, str]:
    items = paginate(
        f"{BASE}/sections",
        headers,
        {"project_id": PANTRY_PROJECT_ID, "limit": 200},
    )
    return {s["id"]: s["name"] for s in items}


def get_open_tasks(headers: dict) -> list[dict]:
    return paginate(
        f"{BASE}/tasks",
        headers,
        {"project_id": PANTRY_PROJECT_ID, "limit": 200},
    )


def get_completed_tasks(headers: dict, weeks_back: int = 12) -> list[dict]:
    """Fetch completed tasks via /tasks/completed/by_completion_date.

    The endpoint requires both since and until and limits each window to
    ~6 weeks. We loop windows backwards from now to weeks_back.
    """
    now = datetime.now(timezone.utc)
    start = now - timedelta(weeks=weeks_back)
    items: list[dict] = []
    window_end = now
    while window_end > start:
        window_start = max(start, window_end - timedelta(days=42))
        page = paginate(
            f"{BASE}/tasks/completed/by_completion_date",
            headers,
            {
                "project_id": PANTRY_PROJECT_ID,
                "since": window_start.strftime("%Y-%m-%dT%H:%M:%S"),
                "until": window_end.strftime("%Y-%m-%dT%H:%M:%S"),
                "limit": 200,
            },
        )
        items.extend(page)
        window_end = window_start
    return items


def parse_description(desc: str) -> dict:
    out = {
        "purchased_date": None,
        "store": None,
        "qty": None,
        "unit": None,
        "unit_price": None,
        "total": None,
    }
    if not desc:
        return out
    m = DESC_RE["purchased"].search(desc)
    if m:
        out["purchased_date"] = m.group("date")
        out["store"] = m.group("store").strip()
    m = DESC_RE["qty"].search(desc)
    if m:
        out["qty"] = float(m.group("qty"))
        out["unit"] = m.group("unit")
        if m.group("price"):
            out["unit_price"] = float(m.group("price"))
    m = DESC_RE["total"].search(desc)
    if m:
        out["total"] = float(m.group("total"))
    return out


def classify_status(task: dict, completed: bool) -> str:
    if not completed:
        return "in_pantry"
    labels = set(task.get("labels") or [])
    if "wasted-spoiled" in labels:
        return "wasted-spoiled"
    if "wasted-rejected" in labels:
        return "wasted-rejected"
    return "consumed"


def days_between(start_iso: str | None, end_iso: str | None) -> int | None:
    if not start_iso:
        return None
    end = end_iso or datetime.now(timezone.utc).isoformat()
    try:
        s = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
        e = datetime.fromisoformat(end.replace("Z", "+00:00"))
        return max(0, (e.date() - s.date()).days)
    except ValueError:
        return None


def to_item(task: dict, sections: dict, completed: bool) -> dict:
    meta = parse_description(task.get("description", "") or "")
    added_at = task.get("added_at") or task.get("created_at")
    completed_at = task.get("completed_at") if completed else None
    return {
        "id": task["id"],
        "name": task.get("content", ""),
        "section": sections.get(task.get("section_id"), "Other"),
        "status": classify_status(task, completed),
        "purchased_date": meta["purchased_date"],
        "store": meta["store"],
        "qty": meta["qty"],
        "unit": meta["unit"],
        "unit_price": meta["unit_price"],
        "total": meta["total"],
        "added_at": added_at,
        "completed_at": completed_at,
        "days_held": days_between(added_at, completed_at),
        "labels": task.get("labels") or [],
    }


def main() -> int:
    weeks_back = int(os.environ.get("WEEKS_BACK", "12"))
    headers = auth_headers()
    sections = get_sections(headers)
    open_tasks = get_open_tasks(headers)
    completed_tasks = get_completed_tasks(headers, weeks_back=weeks_back)

    items: list[dict] = []
    items.extend(to_item(t, sections, completed=False) for t in open_tasks)
    items.extend(to_item(t, sections, completed=True) for t in completed_tasks)

    payload = {
        "last_sync": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "items": items,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(
        f"Wrote {len(items)} items "
        f"({len(open_tasks)} open, {len(completed_tasks)} completed) "
        f"to {OUT_PATH.relative_to(REPO_ROOT)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
