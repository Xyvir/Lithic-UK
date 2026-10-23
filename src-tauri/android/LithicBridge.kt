package com.lithic.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import app.tauri.Logger
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * The two document dialogs this project needs and Tauri's own plugin cannot give it.
 *
 * `tauri-plugin-dialog` picks with `ACTION_GET_CONTENT`, which hands over a one-shot read the
 * app never gets back: a Lith opened that way can be read once and never saved, and the launcher
 * is a thing that saves. `ACTION_OPEN_DOCUMENT` is the contract that keeps the grant, and asking
 * the platform to persist it (`takePersistableUriPermission`) is what makes the reference the
 * launcher stores in a recents row still writable after the app is restarted.
 *
 * The document's bytes are not read here. A `content://` reference is read and written through
 * Tauri's filesystem plugin, which turns it into a file descriptor with the ContentResolver, so
 * this class only produces the reference; see `src-tauri/src/platform/android.rs` for the rest.
 *
 * Registered by `platform::android::plugin()` as `com.lithic.app.LithicBridge`, and installed
 * into the generated project by `scripts/patch-android.mjs`.
 */
@InvokeArg
class PickDocumentsArgs {
  var multiple: Boolean? = null
}

@InvokeArg
class CreateDocumentArgs {
  lateinit var suggestedName: String
}

@TauriPlugin
class LithicBridge(private val activity: Activity) : Plugin(activity) {

  /** Open the platform's chooser, and answer with the references the user granted. */
  @Command
  fun pickDocuments(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PickDocumentsArgs::class.java)
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
      // Both flags, because a Lith is read and then written back: a read-only grant would let
      // the wiki open and fail on the first save.
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      intent.addCategory(Intent.CATEGORY_OPENABLE)
      // No MIME filter, and deliberately: a phone has no registered type for a `.lith`, so any
      // filter that named one would grey out every file the app exists to open.
      intent.type = "*/*"
      intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.multiple ?: false)
      startActivityForResult(invoke, intent, "pickDocumentsResult")
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Failed to open the document picker")
    }
  }

  @ActivityCallback
  fun pickDocumentsResult(invoke: Invoke, result: ActivityResult) {
    val answer = JSObject()
    val references = JSArray()
    try {
      // A dismissal is an empty list rather than an error: the launcher treats the two the same
      // for the desktop dialog, and its caller reads the empty list as "nothing was picked".
      if (result.resultCode == Activity.RESULT_OK) {
        for (uri in pickedUris(result.data)) {
          keep(uri)
          references.put(uri.toString())
        }
      }
      answer.put("references", references)
      invoke.resolve(answer)
    } catch (ex: Exception) {
      Logger.error(ex.message ?: "Failed to read the picker's answer")
      invoke.reject(ex.message ?: "Failed to read the picker's answer")
    }
  }

  /**
   * The board this app was asked to open, once.
   *
   * A sign-in window's hand-off reaches the app as a `lithic://` address on its launch intent (see
   * `MainActivity`), and this is the page asking for it. Reading it consumes it, so a reload of the
   * app's own launcher is not sent to the board again after the person has come back from it.
   */
  @Command
  fun takeDeepLink(invoke: Invoke) {
    val answer = JSObject()
    try {
      val link = MainActivity.pendingHandoff
      MainActivity.pendingHandoff = null
      if (link != null) answer.put("link", link)
      invoke.resolve(answer)
    } catch (ex: Exception) {
      Logger.error(ex.message ?: "Failed to read the hand-off")
      invoke.reject(ex.message ?: "Failed to read the hand-off")
    }
  }

  /** Ask the platform for a new document, and answer with the reference it made. */
  @Command
  fun createDocument(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(CreateDocumentArgs::class.java)
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      intent.addCategory(Intent.CATEGORY_OPENABLE)
      intent.type = "*/*"
      // The extension travels in the title, which is the only place it can: the platform's own
      // new-document dialog appends an extension from the MIME type it was given, and this file
      // type is not one the platform knows.
      intent.putExtra(Intent.EXTRA_TITLE, args.suggestedName)
      startActivityForResult(invoke, intent, "createDocumentResult")
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Failed to open the save picker")
    }
  }

  @ActivityCallback
  fun createDocumentResult(invoke: Invoke, result: ActivityResult) {
    val answer = JSObject()
    try {
      val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
      if (uri != null) {
        keep(uri)
        answer.put("reference", uri.toString())
      }
      invoke.resolve(answer)
    } catch (ex: Exception) {
      Logger.error(ex.message ?: "Failed to read the save picker's answer")
      invoke.reject(ex.message ?: "Failed to read the save picker's answer")
    }
  }

  /** Every URI the answer carries: the clip data for a multi-select, the one uri otherwise. */
  private fun pickedUris(data: Intent?): List<Uri> {
    if (data == null) return emptyList()
    val clip = data.clipData
    if (clip == null) {
      val one = data.data ?: return emptyList()
      return listOf(one)
    }
    val uris = ArrayList<Uri>(clip.itemCount)
    for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri)
    return uris
  }

  /**
   * Ask the platform to keep this grant for as long as the app has it.
   *
   * Best effort, and the failure is survivable: a provider that refuses a persistent grant still
   * hands over a usable reference for this session, and a save after a restart then fails with
   * the provider's own message rather than something invented here. Swallowing a refusal keeps
   * opening a document that can never be saved working, which is better than refusing to open it.
   */
  private fun keep(uri: Uri) {
    try {
      activity.contentResolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      )
    } catch (ex: SecurityException) {
      Logger.warn("this document's grant could not be kept: ${ex.message}")
    }
  }
}
