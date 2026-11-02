/*
 * The phone build's activity, and the only Kotlin this project keeps.
 *
 * `tauri android init` writes `src-tauri/gen/android/` from Tauri's own template, and the
 * template's `MainActivity.kt` is four lines that call `enableEdgeToEdge()` and nothing else.
 * That is the whole of the reported overlap: Android 15 and later draw every app that targets
 * SDK 35 or higher under the status bar and the navigation bar, and the one opt-out theme flag
 * (`windowOptOutEdgeToEdgeEnforcement`) is read only at 35 and ignored at 36, which is what the
 * template compiles. There is therefore no "not immersive" switch to turn on: the bars reserve
 * no space of their own, so the page's first row sits behind the clock until the app insets
 * itself.
 *
 * Two things are deliberately not done here.
 *
 * `enableEdgeToEdge()` stays. It is what makes the behaviour above explicit on older devices
 * too, and removing it changes nothing about a phone that enforces the same thing at compile
 * target, so the file keeps the template's call and answers it rather than fighting it.
 *
 * The insets are applied as padding to the activity's content view rather than by measuring the
 * bars once. A rotation, a cutout, a display-size change or a navigation mode change all move
 * them, and the listener is handed the new values each time; a one-shot measurement would be
 * right until the first rotation.
 *
 * The three intents this activity can be started for are a `lithic://` hand-off from a board's
 * sign-in window, a share from another app, and a document another app was asked to open, and
 * none of them is acted on here. Each is kept for the page's own question, because the webview
 * may not exist yet when the intent arrives and the page is the only thing that knows what a
 * share becomes or where a document goes (`LithicBridge.takeDeepLink`, `takeSharedText` and
 * `takeOpenDocument` read them, once each).
 *
 * The third one is what a file manager's "Open with Lithic" sends: `ACTION_VIEW` carrying a
 * `content://` reference, which is the shape this app's own picker answers with too, so the page
 * opens it by the route it already has for a picked document. What the manifest claims is an
 * intent filter and lives in `scripts/patch-android.mjs`, generated from the same table the
 * desktop registrations read (`src-tauri/src/platform/associations.json`).
 *
 * `displayCutout` is asked for beside `systemBars` because a camera cutout is not a bar: on a
 * phone whose notch is taller than the status bar, the bars alone leave the top of the page
 * under the cutout.
 *
 * The keyboard is deliberately absent. `Type.ime()` would pad the content out of the keyboard's
 * way, which moves the whole page every time a field is focused and fights the wiki's own
 * scrolling; what a text field needs is the platform's panning, which it already does.
 */
package com.lithic.app

import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Before `super`, because the webview is built inside it and a page that starts asking at once
    // should find the address already waiting rather than arrive one turn late. Both intents are
    // kept here for the same reason: a share is the other thing this activity can be started for.
    rememberHandoff(intent)
    rememberShare(intent)
    rememberDocument(intent)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val content = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
  }

  /**
   * A board hand-off or a share arriving at a copy of this app that is already running.
   *
   * A tap in the board's sign-in window, and a share from another app, both usually bring the app
   * forward rather than starting it, and each arrives here instead of in `onCreate`. Nothing is
   * opened from this method: the page asks for it when it is next shown, which is a page in a
   * webview that may not exist yet.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    rememberHandoff(intent)
    rememberShare(intent)
    rememberDocument(intent)
  }

  /** Keep a `lithic://` address for the page, and ignore every other intent this app receives. */
  private fun rememberHandoff(intent: Intent?) {
    val link = intent?.data ?: return
    if (link.scheme != "lithic") return
    pendingHandoff = link.toString()
  }

  /**
   * Keep what another app shared with this one, for the page's own question.
   *
   * The share sheet is the platform's own mechanism: an app that shares a link, a paragraph or a
   * file's text sends `ACTION_SEND` with the content in `EXTRA_TEXT`, and this activity matches it
   * because the manifest claims `text/plain` (`SHARE_FILTER` in `scripts/patch-android.mjs`). A URL
   * arrives as text here, and deliberately: that is what the
   * sending app puts in the extra, and the launcher decides what a link is worth.
   *
   * The title the sender offered is kept beside it, because a phone that names the content has
   * already done the hard part of naming the note: Chrome sends the page's own title. `EXTRA_TITLE`
   * is the modern spelling and `EXTRA_SUBJECT` the one every older app still uses, so both are
   * read and either is a title. An empty extra is not a title, which is what makes the blank
   * answers indistinguishable from a sender that offered none.
   *
   * The content is not parsed, trimmed or rewritten here: this file's only job is to hold the
   * intent's own bytes for the page, and everything about what a share becomes lives in one place
   * on the launcher's side (`sharedPayload` in `pending-imports.ts`).
   */
  private fun rememberShare(intent: Intent?) {
    if (intent == null || intent.action != Intent.ACTION_SEND) return
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: ""
    val offered = intent.getCharSequenceExtra(Intent.EXTRA_TITLE)?.toString()
      ?: intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
      ?: ""
    if (text.isBlank() && offered.isBlank()) return
    pendingShare = Share(text, offered)
  }

  /**
   * Keep the document another app asked this one to open, for the page's own question.
   *
   * `ACTION_VIEW` with a `content://` (or, from an older file manager, a `file://`) reference is
   * what a file manager's "Open with" sends. It is kept rather than opened for the reason the
   * other two are: the webview may not exist yet, and a document is the launcher's to mount.
   *
   * A `lithic://` address also arrives as `ACTION_VIEW`, and is deliberately not this: the
   * scheme is a board hand-off, which `rememberHandoff` above keeps and the page reads
   * separately. Restricting this to the two document schemes is what keeps the two apart without
   * either of them having to know about the other.
   *
   * The sender's grant is usually readable and writable for this activity's task only, so the
   * app asks the platform to keep it. A provider that refuses a persistent grant still hands
   * over a usable reference for this session, which is why the attempt is best effort and the
   * same one the picker makes (`LithicBridge.keep`). Without the attempt, a document opened this
   * way could be read and then never saved, which is the shape the picker exists to avoid.
   */
  private fun rememberDocument(intent: Intent?) {
    if (intent == null || intent.action != Intent.ACTION_VIEW) return
    val reference = intent.data ?: return
    val scheme = reference.scheme ?: return
    if (scheme != "content" && scheme != "file") return
    pendingDocument = reference.toString()
    val granted = intent.flags and
      (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    if (granted == 0 || scheme != "content") return
    try {
      contentResolver.takePersistableUriPermission(reference, granted)
    } catch (ex: SecurityException) {
      // The sender offered no persistent grant. The document still opens, and a save will ask
      // for somewhere to put it.
    }
  }

  /** What another app shared: the content, and the title it offered when it offered one. */
  data class Share(val text: String, val title: String)

  companion object {
    /**
     * The address this app was asked to open, waiting for the page's own question.
     *
     * Held here rather than in the bridge because the intent arrives before any plugin exists, and
     * read once by `LithicBridge.takeDeepLink`, which is what makes it a hand-off rather than a
     * setting: the page may only be sent to a board once.
     */
    @Volatile
    var pendingHandoff: String? = null

    /**
     * The share this app was handed, waiting for the page's own question.
     *
     * The same arrangement as `pendingHandoff` and the same reason: the intent arrives before any
     * plugin exists, and `LithicBridge.takeSharedText` reads it once. Reading it consumes it, so a
     * reload of the launcher is not handed the same share a second time and does not queue the
     * same note twice.
     */
    @Volatile
    var pendingShare: Share? = null

    /**
     * The document this app was asked to open, waiting for the page's own question.
     *
     * The same arrangement and the same reason as the two above: the intent arrives before any
     * plugin exists, and `LithicBridge.takeOpenDocument` reads it once, so a reload of the
     * launcher is not handed the same document a second time.
     */
    @Volatile
    var pendingDocument: String? = null
  }
}
