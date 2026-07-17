package com.fpvarbcon.transport

import java.util.concurrent.ConcurrentHashMap

/**
 * sessionId -> UsbSerialSession. A session is inserted only once fully
 * opened and configured - never partially. Enforces "one active session per
 * physical device" via an atomic reservation step that must be claimed
 * before starting an open attempt and is always released on any failure.
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
 */
internal class UsbSerialSessionRegistry {

  private val sessions = ConcurrentHashMap<String, UsbSerialSession>()
  private val reservedDeviceIds = mutableSetOf<Int>()

  /**
   * Atomically claims [deviceId] for a new open attempt. Returns false if a
   * session is already active for this device, or another open attempt for
   * it is already in flight (permission pending, port opening, etc).
   */
  @Synchronized
  fun reserveDevice(deviceId: Int): Boolean {
    if (reservedDeviceIds.contains(deviceId) || sessions.values.any { it.deviceId == deviceId }) {
      return false
    }
    reservedDeviceIds.add(deviceId)
    return true
  }

  /** Releases a reservation without creating a session - used on any open failure. */
  @Synchronized
  fun releaseReservation(deviceId: Int) {
    reservedDeviceIds.remove(deviceId)
  }

  /** Registers a fully-opened session and releases its device's reservation. */
  @Synchronized
  fun insert(session: UsbSerialSession) {
    reservedDeviceIds.remove(session.deviceId)
    sessions[session.sessionId] = session
  }

  @Synchronized
  fun remove(sessionId: String): UsbSerialSession? = sessions.remove(sessionId)

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
   * Atomically drains every active session and clears every pending
   * reservation - used only for module/host teardown. Returns the removed
   * sessions so the caller can close them (real I/O) outside this lock;
   * this method itself never touches a port or connection. After it
   * returns, the registry reports no active session and no reserved device.
   */
  @Synchronized
  fun removeAll(): List<UsbSerialSession> {
    val active = sessions.values.toList()
    sessions.clear()
    reservedDeviceIds.clear()
    return active
  }
}
