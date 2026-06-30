/**
 * Per-conversation turn lock.
 *
 * Guarantees at most one in-flight turn per logical key (we key on
 * `${responderIdentity}:${conversationId}`) and remembers whether a message
 * arrived while a turn was already running, so the owning turn can re-dispatch
 * exactly once when it finishes.
 *
 * Core of the mid-turn duplicate-turn fix: previously the dispatch guard was
 * keyed per *message id*, so two different messages in one conversation each
 * passed the guard and ran two concurrent turns that both appended replies.
 * Keying per *conversation* makes a mid-turn message wait, then get picked up.
 */
export class TurnLock {
  private readonly active = new Set<string>();
  private readonly pending = new Set<string>();

  /** Begin a turn for `key`. Returns true if caller owns it (must call end). */
  begin(key: string): boolean {
    if (this.active.has(key)) {
      this.pending.add(key);
      return false;
    }
    this.active.add(key);
    return true;
  }

  /** Release `key`. Returns true if a message was deferred and needs re-dispatch. */
  end(key: string): boolean {
    this.active.delete(key);
    return this.pending.delete(key);
  }

  isActive(key: string): boolean {
    return this.active.has(key);
  }

  isPending(key: string): boolean {
    return this.pending.has(key);
  }
}
