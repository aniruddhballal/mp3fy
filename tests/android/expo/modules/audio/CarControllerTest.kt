package expo.modules.audio

import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.session.MediaController
import androidx.media3.session.MediaSession
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import expo.modules.audio.service.AudioMediaSessionCallback
import expo.modules.audio.service.MetadataInjectingPlayer
import java.time.Duration
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class CarControllerTest {
  // Deterministic audio engine underneath the real Media3 session/controller.
  // Durations and the advancing clock exercise the state a car receives without
  // accessing songs, speakers, Bluetooth hardware, or the user's playback state.
  private class Playlist : SimpleBasePlayer(Looper.getMainLooper()) {
    private var snapshot = State.Builder()
      .setAvailableCommands(Player.Commands.Builder().addAllCommands().build())
      .setPlaybackState(Player.STATE_READY)
      .setPlayWhenReady(true, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      .setPlaylist(listOf(track("a", 374000), track("b", 180000)))
      .setCurrentMediaItemIndex(0)
      .setContentPositionMs(12000)
      .build()

    override fun getState(): State = snapshot

    override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()

    override fun handleSeek(index: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
      val position = if (positionMs == C.TIME_UNSET) 0L else positionMs
      snapshot = snapshot.buildUpon().setCurrentMediaItemIndex(index)
        .setContentPositionMs(position)
        .setPositionDiscontinuity(Player.DISCONTINUITY_REASON_SEEK, position).build()
      return Futures.immediateVoidFuture()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
      // Model the engine acknowledging a controller command on a later clock
      // tick. Equal virtual timestamps prevent MediaController extrapolation
      // until its next periodic position update, unlike an asynchronous engine.
      ShadowSystemClock.advanceBy(Duration.ofMillis(1))
      snapshot = snapshot.buildUpon().setContentPositionMs(currentPosition)
        .setPlayWhenReady(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST).build()
      return Futures.immediateVoidFuture()
    }

    override fun handleReplaceMediaItems(fromIndex: Int, toIndex: Int, mediaItems: List<MediaItem>): ListenableFuture<*> {
      val tracks = snapshot.playlist.toMutableList()
      mediaItems.forEachIndexed { offset, item ->
        tracks[fromIndex + offset] = tracks[fromIndex + offset].buildUpon()
          .setMediaItem(item).setMediaMetadata(item.mediaMetadata).build()
      }
      snapshot = snapshot.buildUpon().setPlaylist(tracks).build()
      return Futures.immediateVoidFuture()
    }

    companion object {
      fun track(id: String, durationMs: Long): MediaItemData {
        val metadata = MediaMetadata.Builder().setTitle("Song $id").build()
        return MediaItemData.Builder(id)
          .setMediaItem(MediaItem.Builder().setMediaId(id).setUri("file:///$id.mp3").setMediaMetadata(metadata).build())
          .setMediaMetadata(metadata).setDurationUs(durationMs * 1000).setIsSeekable(true).build()
      }
    }
  }

  @Test
  fun remoteNextPreviousDurationAndLiveProgressFollowTheCurrentTrack() {
    val native = Playlist()
    val wrapped = MetadataInjectingPlayer(native)
    val session = MediaSession.Builder(RuntimeEnvironment.getApplication(), wrapped)
      .setCallback(AudioMediaSessionCallback()).build()
    val future = MediaController.Builder(RuntimeEnvironment.getApplication(), session.token).buildAsync()
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue("controller should connect", future.isDone)
    val controller = future.get()
    try {
      assertEquals(374000L, controller.duration)
      assertEquals("a", controller.currentMediaItem!!.mediaId)
      assertTrue(controller.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM))
      controller.seekToNextMediaItem()
      shadowOf(Looper.getMainLooper()).idle()
      assertEquals("b", controller.currentMediaItem!!.mediaId)
      assertEquals("Song b", controller.mediaMetadata.title)
      assertEquals("the previous song's 6:14 duration must not survive", 180000L, controller.duration)
      assertEquals(0L, controller.currentPosition)

      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
      assertTrue("remote progress should advance while playing", controller.currentPosition >= 2000L)
      controller.pause()
      shadowOf(Looper.getMainLooper()).idle()
      val pausedPosition = controller.currentPosition
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
      assertEquals("remote progress must stop while paused", pausedPosition, controller.currentPosition)

      wrapped.updateMetadata(Metadata("Song b with artwork", "Artist B", null, null, "b"))
      shadowOf(Looper.getMainLooper()).idle()
      assertEquals(180000L, controller.duration)
      assertEquals(pausedPosition, controller.currentPosition)
      assertEquals("Song b with artwork", controller.currentMediaItem!!.mediaMetadata.title)

      controller.seekToPreviousMediaItem()
      shadowOf(Looper.getMainLooper()).idle()
      assertEquals("a", controller.currentMediaItem!!.mediaId)
      assertEquals(374000L, controller.duration)
      assertEquals(0L, controller.currentPosition)
      controller.play()
      shadowOf(Looper.getMainLooper()).idle()
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
      assertTrue(controller.isPlaying)
      assertTrue("resumed remote progress=${controller.currentPosition}, engine=${native.currentPosition}", controller.currentPosition >= 2000L)
    } finally {
      controller.release()
      session.release()
      native.release()
    }
  }

}
