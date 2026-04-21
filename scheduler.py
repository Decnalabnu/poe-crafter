"""
scheduler.py — Runs all data pipelines on a recurring schedule.

Cadences:
  12h  economy (poe.ninja prices, div cards, trade prices)
  24h  builds (GGG ladder + items), map cards

Usage:
    python scheduler.py              # run forever, scraping on schedule
    python scheduler.py --once       # run all tasks once then exit
    python scheduler.py --dry-run    # show schedule, don't run anything

Logs go to data/scheduler.log and stdout.
"""

import argparse
import logging
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent
LOG_FILE = PROJECT_ROOT / "data" / "scheduler.log"

# Each task: (name, script_path, args, interval_hours)
TASKS = [
    # 12-hour cadence — price-sensitive data that moves with the market
    ("economy",      "src/utils/update_data.py",        [],           12),
    ("div_cards",    "src/utils/fetch_div_economy.py",  [],           12),
    ("trade_prices", "src/utils/fetch_trade_prices.py", ["--by-skill"], 12),
    # 24-hour cadence — structural data that shifts slowly
    ("builds",       "src/utils/scrape_builds.py",      [],           24),
    ("map_cards",    "scrape_map_cards.py",              [],           24),
]

# Stagger starts so we don't slam all APIs at once (seconds between tasks)
STAGGER_SECONDS = 30

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

logger = logging.getLogger("scheduler")
logger.setLevel(logging.INFO)
fmt = logging.Formatter("%(asctime)s  %(message)s", datefmt="%Y-%m-%d %H:%M:%S")

fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
fh.setFormatter(fmt)
logger.addHandler(fh)

sh = logging.StreamHandler(sys.stdout)
sh.setFormatter(fmt)
logger.addHandler(sh)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
class TaskState:
    def __init__(self, name: str, script: str, args: list, interval_hrs: int):
        self.name = name
        self.script = str(PROJECT_ROOT / script)
        self.args = args
        self.interval_sec = interval_hrs * 3600
        self.last_run: float = 0.0  # epoch — 0 means "never"
        self.last_ok: bool = True

    @property
    def due(self) -> bool:
        return (time.time() - self.last_run) >= self.interval_sec

    @property
    def next_in(self) -> float:
        return max(0.0, self.interval_sec - (time.time() - self.last_run))

    def run(self) -> bool:
        logger.info(f"[{self.name}] starting")
        start = time.time()
        try:
            result = subprocess.run(
                [sys.executable, self.script, *self.args],
                cwd=str(PROJECT_ROOT),
                capture_output=True,
                text=True,
                timeout=1800,  # 30 min max per task
            )
            elapsed = time.time() - start
            self.last_run = time.time()

            if result.returncode == 0:
                self.last_ok = True
                logger.info(f"[{self.name}] done ({elapsed:.0f}s)")
            else:
                self.last_ok = False
                logger.warning(
                    f"[{self.name}] exited {result.returncode} ({elapsed:.0f}s)\n"
                    f"  stderr: {result.stderr[-500:]}"
                )

            if result.stdout:
                for line in result.stdout.strip().splitlines()[-5:]:
                    logger.info(f"  {line}")

            return self.last_ok

        except subprocess.TimeoutExpired:
            self.last_run = time.time()
            self.last_ok = False
            logger.error(f"[{self.name}] timed out after 30m")
            return False
        except Exception as e:
            self.last_run = time.time()
            self.last_ok = False
            logger.error(f"[{self.name}] error: {e}")
            return False


def run_all(tasks: list[TaskState], stagger: int = STAGGER_SECONDS):
    """Run every due task with a stagger delay between them."""
    ran = 0
    for task in tasks:
        if not task.due:
            continue
        task.run()
        ran += 1
        time.sleep(stagger)
    return ran


def print_schedule(tasks: list[TaskState]):
    logger.info("Schedule:")
    for t in tasks:
        hrs = t.interval_sec / 3600
        logger.info(f"  {t.name:<15} every {hrs:.0f}h  ({t.script})")


def main():
    parser = argparse.ArgumentParser(description="PoE Crafter data scheduler")
    parser.add_argument("--once", action="store_true", help="Run all tasks once then exit")
    parser.add_argument("--dry-run", action="store_true", help="Print schedule without running")
    args = parser.parse_args()

    tasks = [TaskState(name, script, task_args, interval) for name, script, task_args, interval in TASKS]

    logger.info("=== PoE Crafter Scheduler ===")
    print_schedule(tasks)

    if args.dry_run:
        return

    if args.once:
        for task in tasks:
            task.last_run = 0.0  # force all due
        run_all(tasks)
        logger.info("--once complete")
        return

    # First run: execute everything immediately
    logger.info("Initial run — executing all tasks")
    for task in tasks:
        task.last_run = 0.0
    run_all(tasks)

    # Loop: check every 5 minutes for due tasks
    POLL_INTERVAL = 300
    logger.info("Entering scheduling loop (Ctrl+C to stop)")
    try:
        while True:
            time.sleep(POLL_INTERVAL)
            due_names = [t.name for t in tasks if t.due]
            if due_names:
                logger.info(f"Due: {', '.join(due_names)}")
                run_all(tasks)
            else:
                soonest = min(t.next_in for t in tasks)
                mins = soonest / 60
                logger.info(f"No tasks due. Next in {mins:.0f}m")
    except KeyboardInterrupt:
        logger.info("Scheduler stopped by user")


if __name__ == "__main__":
    main()
