# Pantry Ops

Static-site grocery tracker. Source of truth: Todoist Pantry project.
Site is regenerated every 6 hours by a GitHub Actions workflow and served from GitHub Pages.

## Tabs
- **Inventory** — what's in your kitchen now, grouped by section, with age indicators
- **Log** — every purchase + outcome (filterable, sortable)
- **Analytics** — spend, waste rate, shelf-life KPIs, charts, leaderboards

## Data flow

```
Todoist (Pantry project)
        │
        │  scripts/sync.py — runs every 6h via Actions
        ▼
data/pantry.json (committed)
        │
        ▼
index.html on GitHub Pages
```

## Adding new purchases
Add tasks to the Todoist Pantry project. Each task description in this format:

```
Purchased: YYYY-MM-DD at <store>
Qty: N <unit> @ $X.XX/<unit>
Total: $X.XX
```

`sync.py` parses this on every run.

## Marking consumption / waste
- Check off in Todoist = consumed (default)
- Add label `wasted-spoiled` before checking off = went bad
- Add label `wasted-rejected` before checking off = didn't like it

## Schedule
`.github/workflows/sync.yml` runs on `0 */6 * * *` (every 6h). Change as needed.
