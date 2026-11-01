package com.anonymous.mp3fy

import android.net.Uri
import android.provider.DocumentsContract
import com.facebook.react.bridge.*
import com.facebook.react.ReactPackage
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

/** Provider access runs off the React and UI threads. */
class LibraryScannerModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  override fun getName() = "Mp3fyLibraryScanner"
  override fun invalidate() { executor.shutdownNow(); super.invalidate() }

  @ReactMethod
  fun scanFolder(folderUri: String, folderName: String, promise: Promise) {
    executor.execute {
      try {
        val tracks = Arguments.createArray()
        val pending = ArrayDeque<Uri>()
        val root = Uri.parse(folderUri)
        pending.add(root)
        var imageUri: String? = null
        var imageName: String? = null
        fun imagePriority(name: String): Int {
          val lower = name.lowercase(Locale.ROOT)
          return when {
            lower.startsWith("folder.") -> 0
            lower.startsWith("cover.") -> 1
            lower.startsWith("artwork.") -> 2
            lower.startsWith("albumart.") || lower.startsWith("album-art.") -> 3
            lower.startsWith("thumbnail.") -> 4
            lower.startsWith("image.") -> 5
            else -> 10
          }
        }
        fun accept(uri: Uri, name: String, isDirectory: Boolean, isRoot: Boolean) {
          if (isDirectory) { pending.add(uri); return }
          val lower = name.lowercase(Locale.ROOT)
          if (isRoot && listOf(".jpg", ".jpeg", ".png", ".webp").any { lower.endsWith(it) }) {
            val previous = imageName
            if (previous == null || imagePriority(name) < imagePriority(previous) ||
              (imagePriority(name) == imagePriority(previous) && name.compareTo(previous) < 0)) {
              imageName = name
              imageUri = uri.toString()
            }
          }
          if (lower.endsWith(".mp3")) {
            tracks.pushMap(Arguments.createMap().apply {
              putString("folderName", folderName); putString("folderUri", folderUri)
              putString("name", name); putString("uri", uri.toString())
            })
          }
        }
        while (pending.isNotEmpty()) {
          if (Thread.currentThread().isInterrupted) throw InterruptedException()
          val current = pending.removeLast()
          if (current.scheme == "file") {
            val children = File(requireNotNull(current.path)).listFiles() ?: throw Exception("Cannot list $current")
            for (child in children) accept(Uri.fromFile(child), child.name, child.isDirectory, current == root)
          } else {
            val id = if (DocumentsContract.isDocumentUri(context, current)) DocumentsContract.getDocumentId(current) else DocumentsContract.getTreeDocumentId(current)
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(root, id)
            val projection = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE)
            val cursor = context.contentResolver.query(childrenUri, projection, null, null, null) ?: throw Exception("Cannot list $current")
            cursor.use {
              while (it.moveToNext()) {
                val childId = it.getString(0) ?: continue
                val name = it.getString(1) ?: continue
                val uri = DocumentsContract.buildDocumentUriUsingTree(root, childId)
                accept(uri, name, it.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR, current == root)
              }
            }
          }
        }
        promise.resolve(Arguments.createMap().apply { putString("imageUri", imageUri); putArray("tracks", tracks) })
      } catch (error: Exception) { promise.reject("SCAN_FAILED", error) }
    }
  }
}

class LibraryScannerPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(LibraryScannerModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
