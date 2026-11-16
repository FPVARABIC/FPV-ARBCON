# Android permission recovery

Base: `claude/osd-professional-rework`, commit
`4b1373d3c380580823f7a675d4e476e933d916d8`.

## User-visible defect

When a USB permission dialog did not answer before the connection deadline,
`awaitPermissionResult` returned a timeout but never called
`UsbPermissionRequester.abandonRequest`. The coordinator entry, receiver and
callback remained registered. Retrying could accumulate unanswered requests
until a broadcast or module invalidation eventually removed them.

The connection watchdog and reservation checks already guarded against a
stale connection becoming the accepted session. This change repairs resource
cleanup; it does not establish that the old implementation opened a stale port.

## Change

- Return the per-request id from `requestPermission`; immediate outcomes return
  `null` and keep their existing callback behavior.
- Move the callback/latch bridge to `awaitUsbPermissionResult`, which can be
  executed directly on the JVM.
- Retire only that request in `finally` on timeout or interruption, using the
  requester's existing settle-once and receiver cleanup path.
- Preserve synchronous grants, asynchronous grants, denials and failure messages.
  A grant racing cleanup cannot convert an expired wait into a successful one.
- Classify the new production file as `JVM_EXECUTED` in the native coverage
  inventory, so CI requires executed coverage for it.

## Focused verification

Kotlin 2.1.20, JVM target 17, JUnit 4.13.2: **19 tests passed** across
`UsbPermissionRequestCoordinatorTest` and `UsbPermissionWaitTest`.
These directly compile and execute the production coordinator and wait helper.
They do not exercise Android framework broadcast delivery.

The eight new tests cover immediate/asynchronous outcomes, denial/failure
messages, request isolation, late grants, interruption, a grant racing expiry,
invalid budgets, and 250 unanswered attempts without retained requests.

Mutation control: removing the call to `abandonRequest` caused **four of the
eight new tests to fail**. The mutation was made only in a temporary copy.

For the normal Android toolchain:

```sh
cd android
./gradlew :app:testDebugUnitTest \
  --tests 'com.fpvarbcon.transport.UsbPermissionRequestCoordinatorTest' \
  --tests 'com.fpvarbcon.transport.UsbPermissionWaitTest'
```

## Shared-source verification

| Check | Result |
| --- | --- |
| TypeScript | Passed, including the final test-harness change |
| ESLint | 0 errors; 463 existing warnings in the full run |
| Native Codegen | Passed for Android |
| Production bundle / engine boundary scan | Passed |
| Native thread census | Passed |
| Jest shard completeness | All 482 files assigned exactly once |
| Full Jest, two workers | 480 suites / 8936 tests passed; two workers were killed in the remaining census suites |
| Control-type census, targeted rerun | Passed before the following interaction suite was killed |
| Interaction census after mock-history cleanup, 2 GiB heap | All 68 tests passed; process exited 0 |
| Full Gradle Kotlin / native test tasks | Not completed: local Java installation has no `JAVA_COMPILER` capability |

The interaction census now clears Jest call histories after each screen case.
Its own cross-screen evidence consists of strings/numbers and is retained;
mock implementations and every existing assertion are retained too. Before
this change the same isolated 2 GiB command exhausted its heap. After it, the
complete 68-test file finished in 88 seconds. The full two-worker suite has
not been repeated with this change, so this is not a claim of one green
monolithic run. Jest printed its one-second open-handle notice on the passing
isolated run, then exited normally without `--forceExit`.

Gradle 9.3.1 and Android SDK 36/build tools/NDK were provisioned locally.
The final bounded Gradle attempt reached configuration but stopped at Skia's
`compileDebugJavaWithJavac` task because the host provides a Java 21 runtime
without `javac`. Downloading a complete JDK 17 from Adoptium returned HTTP 403.
The focused Kotlin/JUnit results above use the standalone Kotlin compiler;
they are not a successful full Android build, native coverage run or APK.

## GitHub Actions blocker

The latest run did not execute the static checks or Jest:
[run 36243008916](https://github.com/FPVARABIC/FPV-ARBCON/actions/runs/36243008916),
check `108406947982`, reports:

> The job was not started because an Actions budget is preventing further use.

The `main` run
[35263424852](https://github.com/FPVARABIC/FPV-ARBCON/actions/runs/35263424852),
check `105344545158`, also reports an account payment/spending-limit blocker.
These annotations were read from GitHub's check-run API. A failed workflow
conclusion here is not evidence of a compiler or test assertion failure.
No account spending settings were changed.

## Delivery boundary

This is a source change for review, with no physical USB validation or new APK
release claimed. Resolve the account's Actions restriction before relying on a
new hosted Android validation run.
