package com.fpvarbcon.transport

/**
 * A unique handle identifying exactly one startReading() attempt for one
 * sessionId. Two tokens are never equal unless they came from the exact
 * same [UsbSerialReadRegistry.start] call - even for the same sessionId
 * started at two different times. Mirrors [ReservationToken]'s own
 * generation-based design (see UsbSerialSessionRegistry.kt) but is a
 * distinct type: a receive attempt and an open-attempt reservation are
 * different domains and must never be compared to each other.
 */
internal data class ReceiveToken(internal val generation: Long)

/**
 * sessionId -> the [ReceiveToken] currently allowed to emit received data
 * for that session. Enforces "at most one active receive loop per session"
 * and gives every startReading() attempt a token that only it owns, so a
 * worker started by an older attempt can never be mistaken for - or
 * interfere with - a newer one.
 *
 * Deliberately independent of [UsbSerialSessionRegistry]: this class knows
 * nothing about UsbSerialSession, UsbDeviceConnection, or UsbSerialPort - it
 * only ever stores a sessionId (String) and a token. Session existence is
 * checked by the caller (UsbSerialTransportModule) against
 * UsbSerialSessionRegistry before calling [start]; this registry has no way
 * to reject "unknown session" itself, by design, so the two registries'
 * responsibilities stay cleanly separated.
 *
 * Unlike [UsbSerialSessionRegistry.releaseReservation], there is no
 * token-gated "stop" method here: a receive worker never mutates this
 * registry itself - it only ever calls [isCurrent] to decide whether it is
 * still allowed to keep running or emit its next chunk. Every removal
 * ([removeSession], [removeAll]) is driven externally, by
 * UsbSerialTransportModule's stopReading()/closeSession()/detach/invalidate
 * paths. Because [start] refuses to mint a new token while an old one is
 * still registered, a new attempt for the same sessionId can only ever
 * begin once the old entry has already been cleared - so an old worker can
 * never remove or otherwise affect a newer one, since it never removes
 * anything at all.
 */
internal class UsbSerialReadRegistry {

  private val activeTokens = mutableMapOf<String, ReceiveToken>()
  private var nextGeneration = 0L

  /**
   * Atomically claims [sessionId] for a new receive attempt and returns a
   * unique [ReceiveToken] that only this attempt owns. Returns null if a
   * receive loop is already active for this session - starting twice is
   * rejected, not merged or restarted, so a caller always knows exactly
   * which attempt is running.
   */
  @Synchronized
  fun start(sessionId: String): ReceiveToken? {
    if (activeTokens.containsKey(sessionId)) {
      return null
    }
    val token = ReceiveToken(nextGeneration++)
    activeTokens[sessionId] = token
    return token
  }

  /**
   * Unconditionally clears whatever receive token is currently registered
   * for [sessionId], regardless of which token it is - used by
   * stopReading() (externally requested, sessionId-only, idempotent by
   * design: removing an absent entry is a harmless no-op), and by
   * closeSession()/detach handling (the session itself is going away, so
   * any receive attempt for it must end too). Returns the removed token, if
   * any, purely for test observability - callers do not need it, since a
   * worker discovers it has been stopped via [isCurrent], not via this
   * return value.
   */
  @Synchronized
  fun removeSession(sessionId: String): ReceiveToken? = activeTokens.remove(sessionId)

  /**
   * True only if [token] is still the exact token stored for [sessionId] -
   * false if it was never started, has since been stopped, or has been
   * superseded by a newer attempt. A receive loop calls this before its
   * first read, after every read returns (successfully or not), and
   * immediately before emitting a chunk - never emitting or continuing once
   * this returns false.
   */
  @Synchronized
  fun isCurrent(sessionId: String, token: ReceiveToken): Boolean = activeTokens[sessionId] == token

  /**
   * Atomically invalidates every outstanding receive token - used only for
   * module teardown. Returns the sessionIds that were active, for test
   * observability; every worker for them will notice via [isCurrent] on its
   * own, without this method touching any thread directly.
   */
  @Synchronized
  fun removeAll(): List<String> {
    val sessionIds = activeTokens.keys.toList()
    activeTokens.clear()
    return sessionIds
  }
}
