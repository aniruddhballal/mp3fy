package expo.modules.audio

import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import android.media.AudioFocusRequest
import android.media.AudioManager
import com.facebook.react.bridge.ReactApplicationContext
import expo.modules.audio.service.AudioControlsService
import expo.modules.audio.service.MetadataInjectingPlayer
import expo.modules.kotlin.AppContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.ArgumentMatchers.any
import org.mockito.ArgumentMatchers.anyInt
import org.mockito.ArgumentCaptor
import org.mockito.AdditionalAnswers
import org.mockito.Mockito.*
import org.robolectric.RobolectricTestRunner
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class CarPlaybackTest {
  @Test
  fun trackChangeBufferingKeepsAudioFocusUntilPlaybackReallyStops() {
    val native = mock(ExoPlayer::class.java)
    val playlist = mock(AudioPlaylist::class.java)
    `when`(playlist.ref).thenReturn(native)
    `when`(playlist.player).thenReturn(native)
    val module = AudioModule()
    val field = AudioModule::class.java.getDeclaredField("playlists").apply { isAccessible = true }
    @Suppress("UNCHECKED_CAST")
    (field.get(module) as MutableMap<String, AudioPlaylist>)["test"] = playlist
    val shouldRelease = AudioModule::class.java.getDeclaredMethod("shouldReleaseFocus").apply { isAccessible = true }

    `when`(native.playWhenReady).thenReturn(true)
    `when`(native.playbackState).thenReturn(Player.STATE_BUFFERING)
    `when`(playlist.isPlaying).thenReturn(false)
    assertEquals("seeking/buffering must not hand focus back to Spotify", false, shouldRelease.invoke(module))

    `when`(native.playbackState).thenReturn(Player.STATE_READY)
    `when`(playlist.isPlaying).thenReturn(true)
    assertEquals(false, shouldRelease.invoke(module))

    `when`(native.playWhenReady).thenReturn(false)
    `when`(playlist.isPlaying).thenReturn(false)
    assertEquals("an explicit pause should release focus", true, shouldRelease.invoke(module))

    `when`(native.playWhenReady).thenReturn(true)
    `when`(native.playbackState).thenReturn(Player.STATE_ENDED)
    assertEquals("a completed queue should release focus", true, shouldRelease.invoke(module))

    `when`(native.playbackState).thenReturn(Player.STATE_BUFFERING)
    `when`(native.playWhenReady).thenReturn(false)
    assertEquals("pausing during buffering still releases focus", true, shouldRelease.invoke(module))
  }

  @Test
  fun metadataBelongsToThePlaylistItemWithoutRestartingPlayback() {
    val native = mock(ExoPlayer::class.java)
    var item = MediaItem.Builder().setMediaId("song-a").setUri("file:///song-a.mp3").build()
    `when`(native.applicationLooper).thenReturn(android.os.Looper.getMainLooper())
    `when`(native.currentMediaItemIndex).thenReturn(0)
    `when`(native.currentMediaItem).thenAnswer { item }
    `when`(native.mediaMetadata).thenAnswer { item.mediaMetadata }
    `when`(native.getMediaItemAt(0)).thenAnswer { item }
    `when`(native.duration).thenReturn(374000L)
    `when`(native.currentPosition).thenReturn(12000L)
    doAnswer { invocation -> item = invocation.getArgument(1); null }
      .`when`(native).replaceMediaItem(anyInt(), any(MediaItem::class.java))

    val sessionPlayer = MetadataInjectingPlayer(native)
    sessionPlayer.updateMetadata(Metadata("Song A", "Artist A", "Album A", null))
    assertEquals("Song A", native.currentMediaItem!!.mediaMetadata.title)
    assertEquals("song-a", native.currentMediaItem!!.mediaId)
    assertEquals(12000L, sessionPlayer.currentPosition)
    assertEquals(374000L, sessionPlayer.duration)

    item = MediaItem.Builder().setMediaId("song-b").setUri("file:///song-b.mp3")
      .setMediaMetadata(MediaMetadata.Builder().setTitle("Song B").build()).build()
    `when`(native.duration).thenReturn(180000L)
    `when`(native.currentPosition).thenReturn(0L)
    assertEquals("the previous title must not mask a native track transition", "Song B", sessionPlayer.mediaMetadata.title)
    assertEquals(180000L, sessionPlayer.duration)
    sessionPlayer.updateMetadata(Metadata("Late A", "Artist A", null, null, "file:///song-a.mp3"))
    assertEquals("late artwork/metadata for A must not relabel B", "Song B", sessionPlayer.mediaMetadata.title)
    sessionPlayer.updateMetadata(Metadata("Song B updated", "Artist B", null, null, "file:///song-b.mp3"))
    assertEquals("Song B updated", native.currentMediaItem!!.mediaMetadata.title)
    verify(native, never()).play()
    verify(native, never()).pause()
    verify(native, never()).prepare()
    verify(native, never()).seekTo(anyLong())
  }

  @Test
  fun controllerPlaybackAcquiresPermanentMusicFocusAndKeepsItAcrossBuffering() {
    val native = mock(ExoPlayer::class.java)
    val playlist = mock(AudioPlaylist::class.java)
    `when`(playlist.player).thenReturn(native)
    `when`(native.playWhenReady).thenReturn(true)
    `when`(native.playbackState).thenReturn(Player.STATE_BUFFERING)
    val module = AudioModule()
    val playersField = AudioModule::class.java.getDeclaredField("playlists").apply { isAccessible = true }
    @Suppress("UNCHECKED_CAST")
    (playersField.get(module) as MutableMap<String, AudioPlaylist>)["test"] = playlist
    val manager = mock(AudioManager::class.java)
    `when`(manager.requestAudioFocus(any(AudioFocusRequest::class.java))).thenReturn(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    AudioModule::class.java.getDeclaredField("audioManager").apply { isAccessible = true }.set(module, manager)
    AudioModule::class.java.getDeclaredField("interruptionMode").apply { isAccessible = true }.set(module, InterruptionMode.DO_NOT_MIX)
    val synchronize = AudioModule::class.java.getDeclaredMethod("synchronizeAudioFocus").apply { isAccessible = true }

    synchronize.invoke(module)
    val request = ArgumentCaptor.forClass(AudioFocusRequest::class.java)
    verify(manager).requestAudioFocus(request.capture())
    assertEquals(AudioManager.AUDIOFOCUS_GAIN, request.value.focusGain)
    assertEquals(android.media.AudioAttributes.USAGE_MEDIA, request.value.audioAttributes.usage)
    synchronize.invoke(module)
    `when`(native.playbackState).thenReturn(Player.STATE_READY)
    synchronize.invoke(module)
    verify(manager, times(1)).requestAudioFocus(any(AudioFocusRequest::class.java))
    verify(manager, never()).abandonAudioFocusRequest(any(AudioFocusRequest::class.java))

    `when`(native.playWhenReady).thenReturn(false)
    synchronize.invoke(module)
    verify(manager).abandonAudioFocusRequest(request.value)
  }

  @Test
  fun deniedFocusPausesControllerPlaybackRatherThanAdvancingSilently() {
    val native = mock(ExoPlayer::class.java)
    val playlist = mock(AudioPlaylist::class.java)
    `when`(playlist.player).thenReturn(native)
    `when`(native.playWhenReady).thenReturn(true)
    `when`(native.playbackState).thenReturn(Player.STATE_READY)
    val module = AudioModule()
    val playersField = AudioModule::class.java.getDeclaredField("playlists").apply { isAccessible = true }
    @Suppress("UNCHECKED_CAST")
    (playersField.get(module) as MutableMap<String, AudioPlaylist>)["test"] = playlist
    val manager = mock(AudioManager::class.java)
    `when`(manager.requestAudioFocus(any(AudioFocusRequest::class.java))).thenReturn(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    AudioModule::class.java.getDeclaredField("audioManager").apply { isAccessible = true }.set(module, manager)
    AudioModule::class.java.getDeclaredMethod("synchronizeAudioFocus").apply { isAccessible = true }.invoke(module)
    verify(playlist).pause()
  }

  @Test
  fun selectingAnotherSongKeepsTheServiceSessionAndRejectsLateMetadata() {
    val serviceController = Robolectric.buildService(AudioControlsService::class.java).create()
    val service = serviceController.get()
    val reactContext = mock(ReactApplicationContext::class.java, AdditionalAnswers.delegatesTo<ReactApplicationContext>(RuntimeEnvironment.getApplication()))
    val appContext = mock(AppContext::class.java)
    `when`(appContext.reactContext).thenReturn(reactContext)
    `when`(appContext.mainQueue).thenReturn(CoroutineScope(Dispatchers.Unconfined))
    service.appContext = appContext
    val native = ExoPlayer.Builder(reactContext).build()
    native.setMediaItems(listOf(
      MediaItem.Builder().setMediaId("song-a").setUri("file:///song-a.mp3").build(),
      MediaItem.Builder().setMediaId("song-b").setUri("file:///song-b.mp3").build()
    ))
    val playlist = mock(AudioPlaylist::class.java)
    `when`(playlist.ref).thenReturn(native)
    var assignedSession = buildBasicMediaSession(reactContext, native)
    `when`(playlist.mediaSession).thenAnswer { assignedSession }
    doAnswer { assignedSession = it.getArgument(0); null }.`when`(playlist).mediaSession = any(MediaSession::class.java) ?: assignedSession
    try {
      service.setPlayerOptions(playlist, Metadata("A", "Artist A", null, null, "song-a"), AudioLockScreenOptions(false, false))
      val firstSession = assignedSession
      native.seekToNextMediaItem()
      service.setPlayerOptions(playlist, Metadata("B", "Artist B", null, null, "song-b"), AudioLockScreenOptions(false, false))
      assertSame("car controllers must retain their connected session", firstSession, assignedSession)
      assertEquals(1, service.sessions.size)
      assertEquals("B", firstSession.player.mediaMetadata.title)
      assertEquals("B", firstSession.player.currentMediaItem!!.mediaMetadata.title)
      service.setPlayerMetadata(playlist, Metadata("Late A", "Artist A", null, null, "song-a"))
      assertEquals("B", firstSession.player.mediaMetadata.title)
      service.unregisterPlayer(restoreBasicSession = false)
      assertTrue(service.sessions.isEmpty())
    } finally {
      assignedSession.release()
      native.release()
      serviceController.destroy()
    }
  }
}
