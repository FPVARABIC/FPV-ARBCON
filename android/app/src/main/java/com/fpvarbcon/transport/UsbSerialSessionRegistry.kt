package com.fpvarbcon.transport

import java.util.concurrent.ConcurrentHashMap

/**
 * A unique handle identifying exactly one open attempt's reservation. Two
 * tokens are never equal unless they came from the exact same
 * [UsbSerialSessionRegistry.reserveDevice] call - even for the same
 * deviceId reserved at two different times. This is what lets a stale,
 * delayed callback from an older attempt be told apart from a newer
 * attempt's reservation for the same deviceId (see the Pass 5.1 corrective
 * report, "reservation ownership race").
 */
internal data class ReservationToken(internal val generation: Long)

/**
 * sessionId -> UsbSerialSession. A session is inserted only once fully
 * opened and configured - never partially. Enforces "one active session per
 * physical device" via an atomic, *token-owned* reservation step that must
 * be claimed before starting an open attempt.
 *
 * Approved single-device policy (locked, see Pass 4 correction): FPV-ARBCON's
 * initial workflow is one app instance, one connected flight controller.
 * Reservation begins before the permission request specifically to prevent
 * duplicate open attempts while that dialog is pending - this is correct for
 * a single-device workflow and is not a race-safety compromise to "fix"
 * later. "One active session per physical device" remains enforced
 * regardless. Future multi-device/multi-port support must extend this
 * registry's internal bookkeeping only - it must not change the public
 * sessionId-based TurboModule contract.
 *
 * Pass 5.1 correction (PASS5.1-AUDIT-1): reservations used to be tracked as
 * a bare `Set<Int>` of deviceIds, so any caller holding a deviceId could
 * release or consume any *current* reservation for it - including one it
 * never created. Because Android can reuse a deviceId across a
 * detach/reconnect, a stale, delayed permission callback from an old,
 * already-detached attempt could silently release or overwrite a brand-new
 * attempt's reservation for the same deviceId. Reservations are now tracked
 * as deviceId -> [ReservationToken], and [releaseReservation]/[insert] only
 * ever act on a reservation when the caller presents the exact token that
 * created it - a stale caller's token simply no longer matches and its call
 * becomes a harmless no-op. [invalidateReservationForDevice] remains
 * deliberately token-free: it exists only for a genuine physical detach,
 * which targets whichever single attempt currently occupies that deviceId's
 * slot - see its own note.
 */
internal class UsbSerialSessionRegistry {

  private val sessions = ConcurrentHashMap<String, UsbSerialSession>()
  private val reservations = mutableMapOf<Int, ReservationToken>()
  private var nextGeneration = 0L

  /**
   * Atomically claims [deviceId] for a new open attempt and returns a
   * unique [ReservationToken] that only this attempt owns. Returns null if
   * a session is already active for this device, or another open attempt
   * for it is already in flight (permission pending, port opening, etc).
   */
  @Synchronized
  fun reserveDevice(deviceId: Int): ReservationToken? {
    if (reservations.containsKey(deviceId) || sessions.values.any { it.deviceId == deviceId }) {
      return null
    }
    val token = ReservationToken(nextGeneration++)
    reservations[deviceId] = token
    return token
  }

  /**
   * Releases [deviceId]'s reservation only if [token] is still the one
   * currently holding it - used on any open-attempt failure. Returns true
   * if this call actually released it. A stale token (superseded by a
   * newer attempt's reservation, or already cleared by detach/teardown)
   * returns false and touches nothing - it can never remove a newer
   * reservation.
   */
  @Synchronized
  fun releaseReservation(deviceId: Int, token: ReservationToken): Boolean {
    return if (reservations[deviceId] == token) {
      reservations.remove(deviceId)
      true
    } else {
      false
    }
  }

  /**
   * Unconditionally invalidates whatever reservation currently exists for
   * [deviceId], regardless of which token holds it - used only for a real
   * physical detach event. A detach is a single, ordered hardware event
   * (Android cannot deliver a reconnect's ATTACHED broadcast for a reused
   * deviceId before this same deviceId's DETACHED broadcast), so it always
   * targets whichever one attempt currently occupies this deviceId's slot -
   * there is no ownership ambiguity to protect against here the way there
   * is for a possibly-stale delayed callback (see [releaseReservation]).
   * A harmless no-op if nothing was reserved.
   */
  @Synchronized
  fun invalidateReservationForDevice(deviceId: Int) {
    reservations.remove(deviceId)
  }

  /**
   * Registers a fully-opened session only if [token] is still the current
   * reservation for the session's deviceId, atomically consuming that
   * reservation as part of the same insertion. Returns false - touching
   * neither [sessions] nor [reservations] - if [token] has been superseded
   * (a newer attempt now owns this deviceId's reservation, or it was
   * already cleared by detach/teardown); the caller must then close the
   * session it already opened without publishing it.
   */
  @Synchronized
  fun insert(token: ReservationToken, session: UsbSerialSession): Boolean {
    if (reservations[session.deviceId] != token) {
      return false
    }
    reservations.remove(session.deviceId)
    sessions[session.sessionId] = session
    return true
  }

  @Synchronized
  fun remove(sessionId: String): UsbSerialSession? = sessions.remove(sessionId)

  /**
   * Read-only lookup by sessionId - added for Pass 5.2's startReading(),
   * which must confirm a session exists before allocating a receive token
   * for it, without removing or otherwise disturbing the session. Touches
   * neither [reservations] nor any other state.
   */
  @Synchronized
  fun get(sessionId: String): UsbSerialSession? = sessions[sessionId]

  /** Prevents a raw flasher from racing an active MSP/raw-serial owner. */
  @Synchronized
  fun hasActiveSessionOrReservation(): Boolean = sessions.isNotEmpty() || reservations.isNotEmpty()

  /**
   * Atomically removes and returns the active session for [deviceId], if
   * any - used when the device has physically detached and its session
   * must be invalidated immediately. Deliberately bypasses the normal
   * closeSession() Promise round trip: there is no live cable left to
   * report a close failure against, and no Promise is waiting on this
   * cleanup either way.
   */
  @Synchronized
  fun removeByDeviceId(deviceId: Int): UsbSerialSession? {
    val match = sessions.values.find { it.deviceId == deviceId } ?: return null
    sessions.remove(match.sessionId)
    return match
  }

  /**
   * Atomically drains every active session and invalidates every pending
   * reservation - used only for module/host teardown. Returns the removed
   * sessions so the caller can close them (real I/O) outside this lock;
   * this method itself never touches a port or connection. After it
   * returns, the registry reports no active session and no reserved device.
   */
  @Synchronized
  fun removeAll(): List<UsbSerialSession> {
    val active = sessions.values.toList()
    sessions.clear()
    reservations.clear()
    return active
  }
}
