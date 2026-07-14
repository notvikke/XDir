import time
from threading import Lock


_JOB_LOCK = Lock()
_JOBS: dict[str, dict] = {}


def _clone_job(job: dict | None) -> dict:
    if not job:
        return {
            "job_key": "",
            "status": "idle",
            "label": "",
            "detail": "",
            "current_title": "",
            "completed": 0,
            "total": 0,
            "percent": 0,
            "summary": None,
            "error": None,
            "started_at": None,
            "finished_at": None,
            "cancel_requested": False,
            "current_index": 0,
            "current_source": "",
            "current_query": "",
            "matched_count": 0,
            "manual_review_count": 0,
            "not_found_count": 0,
            "failed_count": 0,
            "processed": 0,
            "current_game_id": None,
            "updates_found": 0,
            "up_to_date_count": 0,
            "unknown_local_count": 0,
            "remote_unavailable_count": 0,
            "unsupported_count": 0,
            "version_differs_count": 0,
            "refreshed_count": 0,
            "skipped_count": 0,
            "result": None,
        }
    return dict(job)


def start_job(job_key: str, total: int, label: str) -> dict:
    with _JOB_LOCK:
        job = {
            "job_key": job_key,
            "status": "running",
            "label": label,
            "detail": "Preparing library job...",
            "current_title": "",
            "completed": 0,
            "total": max(0, int(total or 0)),
            "percent": 0,
            "summary": None,
            "error": None,
            "started_at": time.time(),
            "finished_at": None,
            "cancel_requested": False,
            "current_index": 0,
            "current_source": "",
            "current_query": "",
            "matched_count": 0,
            "manual_review_count": 0,
            "not_found_count": 0,
            "failed_count": 0,
            "processed": 0,
            "current_game_id": None,
            "updates_found": 0,
            "up_to_date_count": 0,
            "unknown_local_count": 0,
            "remote_unavailable_count": 0,
            "unsupported_count": 0,
            "version_differs_count": 0,
            "refreshed_count": 0,
            "skipped_count": 0,
            "result": None,
        }
        _JOBS[job_key] = job
        return _clone_job(job)


def update_job(job_key: str, completed: int, current_title: str, detail: str | None = None) -> dict:
    with _JOB_LOCK:
        job = _JOBS.get(job_key)
        if not job:
            return _clone_job(None)
        total = max(0, int(job.get("total") or 0))
        safe_completed = max(0, min(int(completed or 0), total if total else int(completed or 0)))
        percent = int((safe_completed / total) * 100) if total > 0 else 100
        job["completed"] = safe_completed
        job["percent"] = max(0, min(percent, 100))
        job["current_title"] = current_title or ""
        if detail is not None:
            job["detail"] = detail
        return _clone_job(job)


def finish_job(job_key: str, summary: str) -> dict:
    with _JOB_LOCK:
        job = _JOBS.get(job_key)
        if not job:
            return _clone_job(None)
        total = int(job.get("total") or 0)
        job["status"] = "completed"
        job["completed"] = total
        job["percent"] = 100 if total >= 0 else job.get("percent", 100)
        job["summary"] = summary
        job["detail"] = "Completed."
        job["finished_at"] = time.time()
        return _clone_job(job)


def fail_job(job_key: str, error: str) -> dict:
    with _JOB_LOCK:
        job = _JOBS.get(job_key)
        if not job:
            return _clone_job(None)
        job["status"] = "failed"
        job["error"] = error
        job["detail"] = "Job failed."
        job["finished_at"] = time.time()
        return _clone_job(job)


def set_job_context(job_key: str, **changes) -> dict:
    with _JOB_LOCK:
        job = _JOBS.get(job_key)
        if not job:
            return _clone_job(None)
        for key, value in changes.items():
            job[key] = value
        return _clone_job(job)


def remove_job_result_item(job_key: str, collection_key: str, game_id: int) -> dict:
    with _JOB_LOCK:
        job = _JOBS.get(job_key)
        if not job:
            return _clone_job(None)
        result = dict(job.get("result") or {})
        items = list(result.get(collection_key) or [])
        result[collection_key] = [item for item in items if item.get("game_id") != game_id]
        job["result"] = result
        return _clone_job(job)


def request_job_cancel(job_key: str) -> dict:
    with _JOB_LOCK:
        job = _JOBS.get(job_key)
        if not job:
            return _clone_job(None)
        job["cancel_requested"] = True
        if job.get("status") == "running":
            job["detail"] = "Cancellation requested. Waiting for the current request to finish..."
        return _clone_job(job)


def is_job_cancel_requested(job_key: str) -> bool:
    with _JOB_LOCK:
        job = _JOBS.get(job_key)
        return bool(job and job.get("cancel_requested"))


def cancel_job(job_key: str, summary: str) -> dict:
    with _JOB_LOCK:
        job = _JOBS.get(job_key)
        if not job:
            return _clone_job(None)
        total = int(job.get("total") or 0)
        completed = int(job.get("completed") or 0)
        job["status"] = "cancelled"
        job["percent"] = int((completed / total) * 100) if total > 0 else 0
        job["summary"] = summary
        job["detail"] = "Cancelled."
        job["finished_at"] = time.time()
        return _clone_job(job)


def get_job(job_key: str) -> dict:
    with _JOB_LOCK:
        return _clone_job(_JOBS.get(job_key))


def any_running_job() -> dict | None:
    with _JOB_LOCK:
        for job in _JOBS.values():
            if job.get("status") == "running":
                return _clone_job(job)
    return None
