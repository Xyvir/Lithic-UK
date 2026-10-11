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
 * `displayCutout` is asked for beside `systemBars` because a camera cutout is not a bar: on a
 * phone whose notch is taller than the status bar, the bars alone leave the top of the page
 * under the cutout.
 *
 * The keyboard is deliberately absent. `Type.ime()` would pad the content out of the keyboard's
 * way, which moves the whole page every time a field is focused and fights the wiki's own
 * scrolling; what a text field needs is the platform's panning, which it already does.
 */
package com.lithic.app

import android.os.Bundle
import android.view.ViewGroup
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
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
}
