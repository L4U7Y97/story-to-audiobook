package com.storytoaudiobook.app.narrator;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
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
 */
public class NarratorService extends Service {

    public interface Listener {
        void onUtteranceStart(String id, int index);
        void onUtteranceDone(String id, int index);
        void onStateChange(String state); // "playing" | "paused" | "stopped" | "finished"
        void onError(String message);
    }

    static final String ACTION_PLAY = "narrator.PLAY";
    static final String ACTION_TOGGLE = "narrator.TOGGLE";
    static final String ACTION_NEXT = "narrator.NEXT";
    static final String ACTION_PREVIOUS = "narrator.PREVIOUS";
    static final String ACTION_STOP = "narrator.STOP";

    private static final String CHANNEL_ID = "narrator_playback";
    private static final int NOTIFICATION_ID = 1;

    // Handed over by the plugin before starting the service; avoids Intent extra size limits.
    private static List<Utterance> pendingQueue = new ArrayList<>();
    private static int pendingStartIndex = 0;
    @Nullable private static Listener listener;
    @Nullable private static NarratorService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private List<Utterance> queue = new ArrayList<>();
    private int index = 0;
    private boolean playing = false;
    private PowerManager.WakeLock wakeLock;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;

    static synchronized void setQueue(List<Utterance> q, int startIndex) {
        pendingQueue = q;
        pendingStartIndex = startIndex;
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
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "storytoaudiobook:narrator");
        wakeLock.setReferenceCounted(false);
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
        emitState("playing");
        updateNotification();
        if (ttsReady) speakCurrent();
    }

    void pause() {
        if (!playing) return;
        playing = false;
        // TextToSpeech has no pause: stop now and restart the current utterance on resume.
        tts.stop();
        releaseWakeLock();
        emitState("paused");
        updateNotification();
    }

    void resume() {
        if (playing) return;
        play();
    }

    void skip(int delta) {
        int target = Math.max(0, Math.min(index + delta, queue.size() - 1));
        index = target;
        if (playing) {
            tts.stop();
            speakCurrent();
        }
        updateNotification();
    }

    void stopPlayback() {
        playing = false;
        if (tts != null) tts.stop();
        releaseWakeLock();
        abandonFocus();
        emitState("stopped");
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void finish() {
        playing = false;
        releaseWakeLock();
        abandonFocus();
        emitState("finished");
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
                if (listener != null) listener.onUtteranceStart(queue.get(i).id, i);
            });
        }

        @Override
        public void onDone(String utteranceId) {
            main.post(() -> {
                int i = indexOf(utteranceId);
                if (i != index || !playing) return; // stale (skipped or paused)
                if (listener != null) listener.onUtteranceDone(queue.get(i).id, i);
                index++;
                if (index >= queue.size()) finish(); else speakCurrent();
                updateNotification();
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
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
    }

    private void updateNotification() {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification());
    }

    private Notification buildNotification() {
        String text = queue.isEmpty()
            ? ""
            : "Segment " + Math.min(index + 1, queue.size()) + " of " + queue.size();
        PendingIntent open = PendingIntent.getActivity(
            this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Story to Audiobook")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(playing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "Previous", action(ACTION_PREVIOUS, 1))
            .addAction(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "Pause" : "Play",
                action(ACTION_TOGGLE, 2))
            .addAction(android.R.drawable.ic_media_next, "Next", action(ACTION_NEXT, 3))
            .build();
    }

    private PendingIntent action(String action, int requestCode) {
        Intent intent = new Intent(this, NarratorService.class).setAction(action);
        return PendingIntent.getService(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE);
    }

    // --- Events ---------------------------------------------------------------------------------

    private void emitState(String state) {
        if (listener != null) listener.onStateChange(state);
    }

    private void emitError(String message) {
        if (listener != null) listener.onError(message);
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        abandonFocus();
        if (tts != null) tts.shutdown();
        instance = null;
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
