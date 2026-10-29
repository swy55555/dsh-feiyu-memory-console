// Correlate queued dispatches at turn START, then use immutable session+turn identity.
// Auxiliary prompts occupy null slots, so silent/non-reply turns cannot shift later replies.
export function sendResult(message) {
  const block = message?.content?.[0];
  let body = null;
  try {
    body = JSON.parse(block?.text || "");
  } catch {}
  const failed =
    message?.isError === true ||
    block?.isError === true ||
    body?.ok === false ||
    Number(body?.failed) > 0;
  const count = Number.isFinite(body?.sent)
    ? Math.max(0, body.sent)
    : failed
      ? 0
      : 1;
  return {
    ok: !failed,
    sent: count,
    error: failed
      ? String(
          body?.error || block?.error || block?.text || "send failed",
        ).slice(0, 200)
      : undefined,
  };
}
export class TurnTraces {
  constructor(write, { now = Date.now, timeoutMs = 15 * 60 * 1000 } = {}) {
    this.write = write;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.turns = new Map();
    this.active = new Map();
    this.closed = new Map();
    this.blocked = new Set();
  }
  enqueue(sessionId, traceId, key) {
    this.sweep();
    const ticket = { sessionId, traceId, key, at: this.now(), turnId: null };
    if (this.blocked.has(sessionId)) {
      this.record(ticket, {
        status: "unknown",
        error: "session correlation lost; rotate session to resume",
      });
      return null;
    }
    const list = this.pending.get(sessionId) || [];
    if (list.length >= 100) {
      this.invalidate(sessionId, "dispatch queue overflow");
      this.record(ticket, { status: "unknown" });
      return null;
    }
    list.push(ticket);
    this.pending.set(sessionId, list);
    this.record(ticket, { status: "queued" });
    return ticket;
  }
  start(sessionId, turnId) {
    if (turnId == null) return null;
    this.sweep();
    const token = JSON.stringify([sessionId, String(turnId)]);
    if (this.closed.has(token)) return null;
    if (this.turns.has(token)) return this.turns.get(token);
    const list = this.pending.get(sessionId) || [],
      ticket = list.shift();
    if (list.length) this.pending.set(sessionId, list);
    else this.pending.delete(sessionId);
    if (!ticket) return null;
    ticket.turnId = String(turnId);
    this.turns.set(token, ticket);
    const set = this.active.get(sessionId) || new Set();
    set.add(token);
    this.active.set(sessionId, set);
    this.record(ticket, { status: "running" });
    return ticket;
  }
  record(ticket, info) {
    if (ticket?.traceId)
      this.write({
        at: this.now(),
        traceId: ticket.traceId,
        key: ticket.key,
        sessionId: ticket.sessionId,
        turnId: ticket.turnId,
        ...info,
      });
  }
  cancel(ticket, error = "dispatch failed", status = "failed") {
    if (!ticket) return;
    const list = (this.pending.get(ticket.sessionId) || []).filter(
      (x) => x !== ticket,
    );
    if (list.length) this.pending.set(ticket.sessionId, list);
    else this.pending.delete(ticket.sessionId);
    this.record(ticket, { status, ok: status === "command", error });
    this.remove(ticket);
  }
  invalidate(sessionId, error) {
    this.blocked.add(sessionId);
    for (const ticket of this.pending.get(sessionId) || [])
      this.record(ticket, { status: "unknown", error });
    this.pending.delete(sessionId);
    for (const ticket of [...this.turns.values()])
      if (ticket.sessionId === sessionId) {
        this.record(ticket, { status: "unknown", error });
        this.remove(ticket);
      }
  }
  resolve(sessionId, turnId) {
    if (turnId)
      return this.turns.get(JSON.stringify([sessionId, String(turnId)]));
    const keys = [...(this.active.get(sessionId) || [])];
    return keys.length === 1 ? this.turns.get(keys[0]) : null;
  }
  sent(sessionId, info, turnId) {
    const ticket = this.resolve(sessionId, turnId);
    if (!ticket) return false;
    ticket.sent = (ticket.sent || 0) + (Number(info.sent) || 0);
    ticket.sendFailed = ticket.sendFailed || info.ok === false;
    this.record(ticket, {
      ...info,
      sent: ticket.sent,
      status: info.ok === false ? "send-failed" : "sent",
    });
    return true;
  }
  finish(sessionId, turnId, info = {}) {
    const ticket = this.resolve(sessionId, turnId);
    if (!ticket) return false;
    const status =
      info.status ||
      (ticket.sendFailed
        ? ticket.sent
          ? "partial"
          : "failed"
        : ticket.sent || info.sent
          ? "sent"
          : "no-reply");
    this.record(ticket, {
      ...info,
      status,
      sent: ticket.sent || info.sent || 0,
    });
    this.remove(ticket);
    return true;
  }
  remove(ticket) {
    if (!ticket?.turnId) return;
    const token = JSON.stringify([ticket.sessionId, ticket.turnId]);
    this.turns.delete(token);
    const set = this.active.get(ticket.sessionId);
    set?.delete(token);
    if (!set?.size) this.active.delete(ticket.sessionId);
    this.closed.set(token, this.now());
    if (this.closed.size > 2048)
      this.closed.delete(this.closed.keys().next().value);
  }
  sweep() {
    const before = this.now() - this.timeoutMs;
    for (const [sessionId, list] of [...this.pending])
      if (list.some((ticket) => ticket.at < before))
        this.invalidate(sessionId, "dispatch timeout");
    for (const ticket of [...this.turns.values()])
      if (ticket.at < before) {
        this.record(ticket, { status: "unknown", error: "turn timeout" });
        this.remove(ticket);
      }
  }
}
