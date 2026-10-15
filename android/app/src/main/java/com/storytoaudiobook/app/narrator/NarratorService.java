package com.storytoaudiobook.app.narrator;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import androidx.annotation.Nullable;
import androidx.core.app.ServiceCompat;
import com.storytoaudiobook.app.MainActivity;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Plays a queue of utterances with Android TextToSpeech inside a foreground media service, so
 * playback continues while the screen is locked and does not depend on the WebView running.
 * Utterances are spoken one at a time; the next one starts from the TTS completion callback.
 * A MediaSession exposes the controls on the lock screen, in the media notification and to
 * headset and Bluetooth buttons.
 */
public class NarratorService extends Service {

    public interface Listener {
        void onUtteranceStart(String batch, String id, int index);
        void onUtteranceDone(String batch, String id, int index);
        void onStateChange(String batch, String state); // "playing" | "paused" | "stopped" | "finished"
        void onError(String message);
    }

    static final String ACTION_PLAY = "narrator.PLAY";
    static final String ACTION_TOGGLE = "narrator.TOGGLE";
    static final String ACTION_NEXT = "narrator.NEXT";
    static final String ACTION_PREVIOUS = "narrator.PREVIOUS";
    static final String ACTION_STOP = "narrator.STOP";

    /** Where the last utterance that started is remembered, to resume after the app is killed. */
    static final String PREFS = "narrator";
    static final String PREF_LAST_ID = "lastId";
    static final String PREF_LAST_AT = "lastAt";

    private static final String CHANNEL_ID = "narrator_playback";
    private static final int NOTIFICATION_ID = 1;
    private static final String DEFAULT_TITLE = "Story to Audiobook";

    // Handed over by the plugin before starting the service; avoids Intent extra size limits.
    private static List<Utterance> pendingQueue = new ArrayList<>();
    private static int pendingStartIndex = 0;
    private static String pendingBatch = "";
    @Nullable private static Listener listener;
    @Nullable private static NarratorService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private List<Utterance> queue = new ArrayList<>();
    private String batch = "";
    private int index = 0;
    private boolean playing = false;
    private PowerManager.WakeLock wakeLock;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private MediaSession session;
    private SharedPreferences prefs;

    static synchronized void setQueue(List<Utterance> q, int startIndex, String batchId) {
        pendingQueue = q;
        pendingStartIndex = startIndex;
        pendingBatch = batchId;
    }

    static void setListener(@Nullable Listener l) {
        listener = l;
    }

    @Nullable
    static NarratorService getInstance() {
        return instance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "storytoaudiobook:narrator");
        wakeLock.setReferenceCounted(false);
        session = new MediaSession(this, "Narrator");
        session.setCallback(sessionCallback);
        session.setSessionActivity(openAppIntent());
        tts = new TextToSpeech(this, status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (!ttsReady) {
                emitError("TextToSpeech failed to initialise (status " + status + ")");
                return;
            }
            tts.setAudioAttributes(audioAttributes());
            tts.setOnUtteranceProgressListener(progressListener);
            if (playing) speakCurrent();
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Must call startForeground promptly after startForegroundService.
        startInForeground();
        String action = intent != null ? intent.getAction() : null;
        if (action == null) return START_NOT_STICKY;
        switch (action) {
            case ACTION_PLAY:
                synchronized (NarratorService.class) {
                    queue = pendingQueue;
                    batch = pendingBatch;
                    index = Math.max(0, Math.min(pendingStartIndex, queue.size()));
                }
                play();
                break;
            case ACTION_TOGGLE:
                if (playing) pause(); else resume();
                break;
            case ACTION_NEXT:
                skip(1);
                break;
            case ACTION_PREVIOUS:
                skip(-1);
                break;
            case ACTION_STOP:
                stopPlayback();
                break;
            default:
                break;
        }
        return START_NOT_STICKY;
    }

    void play() {
        if (queue.isEmpty() || index >= queue.size()) {
            finish();
            return;
        }
        if (!requestFocus()) {
            emitError("Audio focus denied");
            return;
        }
        playing = true;
        wakeLock.acquire(6 * 60 * 60 * 1000L); // safety timeout: 6 h
        session.setActive(true);
        emitState("playing");
        updateSession();
        if (ttsReady) speakCurrent();
    }

    void pause() {
        if (!playing) return;
        playing = false;
        // TextToSpeech has no pause: stop now and restart the current utterance on resume.
        tts.stop();
        releaseWakeLock();
        emitState("paused");
        updateSession();
    }

    void resume() {
        if (playing) return;
        play();
    }

    void skip(int delta) {
        if (queue.isEmpty()) return;
        index = Math.max(0, Math.min(index + delta, queue.size() - 1));
        if (playing) {
            tts.stop();
            speakCurrent();
        }
        updateSession();
    }

    void stopPlayback() {
        playing = false;
        if (tts != null) tts.stop();
        releaseWakeLock();
        abandonFocus();
        emitState("stopped");
        end();
    }

    private void finish() {
        playing = false;
        releaseWakeLock();
        abandonFocus();
        emitState("finished");
        end();
    }

    private void end() {
        session.setActive(false);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void speakCurrent() {
        if (!playing || index >= queue.size()) return;
        Utterance u = queue.get(index);
        applyVoice(u);
        tts.setPitch(u.pitch);
        tts.setSpeechRate(u.rate);
        // The utterance id carries the queue index so stale callbacks after a skip can be ignored.
        tts.speak(u.text, TextToSpeech.QUEUE_FLUSH, null, index + ":" + u.id);
    }

    private void applyVoice(Utterance u) {
        Set<Voice> voices = tts.getVoices();
        if (u.voiceName != null && voices != null) {
            for (Voice v : voices) {
                if (v.getName().equals(u.voiceName)) {
                    tts.setVoice(v);
                    return;
                }
            }
        }
        if (u.lang != null) tts.setLanguage(Locale.forLanguageTag(u.lang));
    }

    private final UtteranceProgressListener progressListener = new UtteranceProgressListener() {
        @Override
        public void onStart(String utteranceId) {
            main.post(() -> {
                int i = indexOf(utteranceId);
                if (i != index || i >= queue.size()) return;
                Utterance u = queue.get(i);
                // Saved natively so a killed app can resume here even if the WebView never ran.
                prefs.edit()
                    .putString(PREF_LAST_ID, u.id)
                    .putLong(PREF_LAST_AT, System.currentTimeMillis())
                    .apply();
                if (listener != null) listener.onUtteranceStart(batch, u.id, i);
                updateSession();
            });
        }

        @Override
        public void onDone(String utteranceId) {
            main.post(() -> {
                int i = indexOf(utteranceId);
                if (i != index || !playing) return; // stale (skipped or paused)
                if (listener != null) listener.onUtteranceDone(batch, queue.get(i).id, i);
                index++;
                if (index >= queue.size()) finish(); else speakCurrent();
            });
        }

        @Override
        public void onStop(String utteranceId, boolean interrupted) {
            // Caused by our own tts.stop() on pause/skip; nothing to do.
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onError(String utteranceId) {
            main.post(() -> {
                emitError("TTS error on utterance " + utteranceId);
                int i = indexOf(utteranceId);
                if (i == index && playing) {
                    index++;
                    if (index >= queue.size()) finish(); else speakCurrent();
                }
            });
        }
    };

    private static int indexOf(String utteranceId) {
        int sep = utteranceId.indexOf(':');
        try {
            return Integer.parseInt(utteranceId.substring(0, sep));
        } catch (RuntimeException e) {
            return -1;
        }
    }

    // --- Voices -------------------------------------------------------------------------------

    @Nullable
    Set<Voice> getVoices() {
        return ttsReady ? tts.getVoices() : null;
    }

    // --- Media session ------------------------------------------------------------------------

    private final MediaSession.Callback sessionCallback = new MediaSession.Callback() {
        @Override
        public void onPlay() {
            resume();
        }

        @Override
        public void onPause() {
            pause();
        }

        @Override
        public void onSkipToNext() {
            skip(1);
        }

        @Override
        public void onSkipToPrevious() {
            skip(-1);
        }

        @Override
        public void onStop() {
            stopPlayback();
        }
    };

    /** Publishes state and metadata to the media session, then redraws the notification. */
    private void updateSession() {
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_STOP;
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(actions)
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
            .build());
        Utterance u = current();
        session.setMetadata(new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, subtitle(u))
            .putString(MediaMetadata.METADATA_KEY_ARTIST, title(u))
            .build());
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification());
    }

    @Nullable
    private Utterance current() {
        return queue.isEmpty() ? null : queue.get(Math.min(index, queue.size() - 1));
    }

    private static String title(@Nullable Utterance u) {
        return u != null && u.title != null ? u.title : DEFAULT_TITLE;
    }

    private static String subtitle(@Nullable Utterance u) {
        return u != null && u.subtitle != null ? u.subtitle : "";
    }

    // --- Audio focus ----------------------------------------------------------------------------

    private AudioAttributes audioAttributes() {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
    }

    private boolean requestFocus() {
        if (focusRequest == null) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(audioAttributes())
                .setOnAudioFocusChangeListener(change -> {
                    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                        pause();
                    }
                })
                .build();
        }
        return audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonFocus() {
        if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    // --- Notification -------------------------------------------------------------------------

    private void createChannel() {
        NotificationChannel channel =
            new NotificationChannel(CHANNEL_ID, "Playback", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void startInForeground() {
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
    }

    private Notification buildNotification() {
        Utterance u = current();
        String line = queue.isEmpty()
            ? ""
            : "Line " + Math.min(index + 1, queue.size()) + " of " + queue.size();
        String text = subtitle(u).isEmpty() ? line : subtitle(u);
        return new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title(u))
            .setContentText(text)
            .setSubText(line)
            .setContentIntent(openAppIntent())
            .setDeleteIntent(action(ACTION_STOP, 4))
            .setOngoing(playing)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(notificationAction(android.R.drawable.ic_media_previous, "Previous", ACTION_PREVIOUS, 1))
            .addAction(notificationAction(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Pause" : "Play",
                ACTION_TOGGLE,
                2))
            .addAction(notificationAction(android.R.drawable.ic_media_next, "Next", ACTION_NEXT, 3))
            .setStyle(new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2))
            .build();
    }

    private Notification.Action notificationAction(int icon, String label, String action, int requestCode) {
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), label, action(action, requestCode))
            .build();
    }

    private PendingIntent openAppIntent() {
        return PendingIntent.getActivity(
            this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent action(String action, int requestCode) {
        Intent intent = new Intent(this, NarratorService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE);
    }

    // --- Events ---------------------------------------------------------------------------------

    private void emitState(String state) {
        if (listener != null) listener.onStateChange(batch, state);
    }

    private void emitError(String message) {
        if (listener != null) listener.onError(message);
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        abandonFocus();
        if (tts != null) tts.shutdown();
        if (session != null) session.release();
        instance = null;
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
