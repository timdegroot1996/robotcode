import threading
from typing import Any, Callable, Dict, List, Optional

BATCH_INTERVAL = 0.1
BATCH_MAX_EVENTS = 200


class ExecutionEventsBatcher:
    """Collects robotframework-events events and sends them in batches.

    A batch is sent every ``interval`` seconds, as soon as it holds ``max_events``
    events, and right away for ``run.ended``, so the last events arrive before
    ``robotExited``. ``send`` must not block (the debugger's unsynced events don't).

    Batch body: ``{"run": <run id>, "from": <first seq>, "to": <last seq>, "events": [...]}``.
    """

    def __init__(
        self,
        send: Callable[[Dict[str, Any]], None],
        interval: float = BATCH_INTERVAL,
        max_events: int = BATCH_MAX_EVENTS,
    ) -> None:
        self._send = send
        self._interval = interval
        self._max_events = max_events
        self._lock = threading.Lock()
        self._events: List[Dict[str, Any]] = []
        self._run: Optional[str] = None
        self._stopped = threading.Event()
        self._thread = threading.Thread(target=self._run_timer, name="robotcode-execution-events", daemon=True)
        self._thread.start()

    def __call__(self, event: Dict[str, Any]) -> None:
        with self._lock:
            if event.get("type") == "run.started":
                self._run = event.get("run")
            self._events.append(event)
            full = len(self._events) >= self._max_events
        if event.get("type") == "run.ended":
            self.close()
        elif full:
            self.flush()

    def flush(self) -> None:
        # the lock is held while sending, so batches go out in order
        with self._lock:
            if not self._events:
                return
            events, self._events = self._events, []
            self._send({"run": self._run, "from": events[0].get("seq"), "to": events[-1].get("seq"), "events": events})

    def close(self) -> None:
        self._stopped.set()
        self.flush()

    def _run_timer(self) -> None:
        while not self._stopped.wait(self._interval):
            self.flush()
