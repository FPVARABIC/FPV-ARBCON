package com.fpvarbcon.transport

/**
 * Carries a stable, project-owned error code (and optional offending field
 * name) through the native open/close flow so the module's single catch
 * site can turn it into a structured Promise rejection without inventing
 * codes ad hoc at each call site.
 */
internal class UsbTransportException(
  val code: String,
  message: String,
  val field: String? = null,
) : Exception(message)
