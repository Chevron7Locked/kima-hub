#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Optional, Tuple

import psycopg2



def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            'Remove rows from "Track" where "filePath" does not point to a valid file under /music.'
        )
    )
    parser.add_argument("--music-root", default="/music", help="Music root directory (default: /music).")
    parser.add_argument("--host", default="localhost", help="Postgres host (default: localhost).")
    parser.add_argument("--port", default=5432, type=int, help="Postgres port (default: 5432).")
    parser.add_argument("--dbname", default="kima", help="Database name (default: kima).")
    parser.add_argument("--user", default="kima", help="Database user (default: kima).")
    parser.add_argument( "--client-encoding", default="UTF8", help='Postgres client_encoding used to decode text (default: UTF8).')
    parser.add_argument("--password", default="kima", help='Database password.')
    parser.add_argument("--batch-size", default=1000, type=int, help="Delete batch size (default: 1000).")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be deleted without deleting.")
    parser.add_argument("--verbose", action="store_true", help="Print per-row reasons.")
    return parser.parse_args()


def _is_under_root(root_resolved: Path, candidate: Path) -> bool:
    try:
        return candidate.is_relative_to(root_resolved)
    except AttributeError:
        # Python < 3.9 fallback.
        try:
            candidate.relative_to(root_resolved)
            return True
        except ValueError:
            return False


def _is_valid_track_file(music_root: Path, file_path: Optional[str]) -> Tuple[bool, str]:
    if file_path is None:
        return False, "Null filePath"
    if not isinstance(file_path, str):
        return False, "Non-string filePath"

    rel = file_path.strip()
    if not rel:
        return False, "Empty filePath"

    rel_path = Path(rel)
    if rel_path.is_absolute() or rel.startswith("/"):
        return False, "Absolute filePath"

    root_resolved = music_root.resolve()
    candidate = music_root / rel

    try:
        candidate_resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        return False, "Invalid path"

    if not _is_under_root(root_resolved, candidate_resolved):
        return False, "Path escapes music root"

    if candidate.is_file():
        return True, "Ok"

    if candidate.exists():
        return False, "Not a file"

    return False, "Missing file"


def main() -> int:
    args = _parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    music_root = Path(args.music_root)
    if not music_root.exists():
        print(f'Error: Music root does not exist: {music_root}', file=sys.stderr)
        return 2
    if not music_root.is_dir():
        print(f'Error: Music root is not a directory: {music_root}', file=sys.stderr)
        return 2

    if args.password == "REPLACE_ME":
        print('Error: Database password is not set (use --password or env KIMA_DB_PASSWORD).', file=sys.stderr)
        return 2

    print(f'Connecting to Postgres db="{args.dbname}" user="{args.user}" host="{args.host}" port={args.port}...')
    conn = psycopg2.connect(
        host=args.host,
        port=args.port,
        dbname=args.dbname,
        user=args.user,
        password=args.password,
    )
    conn.autocommit = False
    conn.set_client_encoding(args.client_encoding)

    total_rows = 0
    invalid_rows = 0
    deleted_rows = 0

    invalid_ids: list[int] = []

    try:
        with conn.cursor(name="track_scan") as scan_cur:
            scan_cur.itersize = 2000
            scan_cur.execute('SELECT "id", "filePath" FROM "Track"')

            for track_id, file_path in scan_cur:
                total_rows += 1
                valid, reason = _is_valid_track_file(music_root, file_path)
                if valid:
                    continue

                invalid_rows += 1
                invalid_ids.append(track_id)

                if args.verbose:
                    print(f'Deleting id={track_id} filePath="{file_path}": {reason}')

                if len(invalid_ids) >= args.batch_size:
                    if args.dry_run:
                        print(f"Dry-run: Would delete {len(invalid_ids)} rows...")
                    else:
                        with conn.cursor() as delete_cur:
                            delete_cur.execute('DELETE FROM "Track" WHERE "id" = ANY(%s)', (invalid_ids,))
                        conn.commit()
                        deleted_rows += len(invalid_ids)
                        print(f"Deleted {len(invalid_ids)} rows.")
                    invalid_ids = []

        if invalid_ids:
            if args.dry_run:
                print(f"Dry-run: Would delete {len(invalid_ids)} rows...")
            else:
                with conn.cursor() as delete_cur:
                    delete_cur.execute('DELETE FROM "Track" WHERE "id" = ANY(%s)', (invalid_ids,))
                conn.commit()
                deleted_rows += len(invalid_ids)
                print(f"Deleted {len(invalid_ids)} rows.")

    except KeyboardInterrupt:
        print("Interrupted. Rolling back...")
        conn.rollback()
        return 130
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        conn.rollback()
        return 1
    finally:
        conn.close()

    if args.dry_run:
        print(f"Done. Scanned {total_rows} rows; Would delete {invalid_rows} rows.")
    else:
        print(f"Done. Scanned {total_rows} rows; Deleted {deleted_rows} rows.")
        if deleted_rows != invalid_rows:
            print(f"Warning: Invalid rows seen={invalid_rows} deleted={deleted_rows} (Check errors/logs).")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
