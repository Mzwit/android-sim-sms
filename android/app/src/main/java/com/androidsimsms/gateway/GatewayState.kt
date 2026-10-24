package com.androidsimsms.gateway

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.util.concurrent.TimeUnit

/** Live status shown in the UI and the notification. Written by the service. */
object GatewayState {
    data class Snapshot(
        val running: Boolean = false,
        val phase: String = "Stopped",
        val connected: Boolean = false,
        val lastContactAt: Long = 0,
        val serverPaused: Boolean = false,
        val pauseReason: String? = null,
        val killSwitch: Boolean = false,
        val emergency: Boolean = false,
        val sentThisSession: Int = 0,
        val failedThisSession: Int = 0,
        val pendingLocal: Int = 0,
        val outbox: Int = 0,
        val sendIntervalMs: Long = 0,
        val lastError: String? = null,
        val diagnostic: String? = null,
    )

    private val _state = MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = _state.asStateFlow()

    fun update(f: (Snapshot) -> Snapshot) = _state.update(f)

    fun diagnosticResult(code: Int) = _state.update {
        it.copy(diagnostic = if (code == -1) "Test SMS handed to the network (RESULT_OK)" else "Test SMS failed: ${SmsResultReceiver.errorName(code)}")
    }
}

object Notifications {
    const val CHANNEL_SERVICE = "gateway_service"
    const val CHANNEL_ALERTS = "gateway_alerts"
    const val ID_SERVICE = 1
    const val ID_ALERT = 2

    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, "Gateway running", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while the phone is acting as an SMS gateway"
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ALERTS, "Gateway problems", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Permission lost, SIM removed, Android SMS limit reached, restart needed"
        })
    }

    private fun openApp(ctx: Context) = PendingIntent.getActivity(
        ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE,
    )

    fun service(ctx: Context, text: String) = NotificationCompat.Builder(ctx, CHANNEL_SERVICE)
        .setSmallIcon(R.drawable.ic_stat_gateway)
        .setContentTitle(ctx.getString(R.string.app_name))
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(openApp(ctx))
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .build()

    fun alert(ctx: Context, title: String, text: String) {
        if (!Phone.has(ctx, android.Manifest.permission.POST_NOTIFICATIONS) && android.os.Build.VERSION.SDK_INT >= 33) return
        ctx.getSystemService(NotificationManager::class.java).notify(
            ID_ALERT,
            NotificationCompat.Builder(ctx, CHANNEL_ALERTS).setSmallIcon(R.drawable.ic_stat_gateway).setContentTitle(title)
                .setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text)).setAutoCancel(true)
                .setContentIntent(openApp(ctx)).build(),
        )
    }

    fun restartNeeded(ctx: Context, why: String) =
        alert(ctx, "Gateway stopped", "Android did not allow the gateway to restart in the background ($why). Tap to open the app and press Start.")
}

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "watchdog",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<WatchdogWorker>(15, TimeUnit.MINUTES).build(),
        )
    }
}

/** Every 15 minutes: if the gateway should be running but Android killed it, restart it. */
class WatchdogWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        if (prefs.isPaired && prefs.wantRunning && !GatewayService.isRunning) {
            try {
                ContextCompat.startForegroundService(applicationContext, Intent(applicationContext, GatewayService::class.java))
            } catch (e: Exception) {
                // Android 12+ may forbid starting a foreground service from the background unless
                // the app is exempt from battery optimisation. Ask the user instead.
                Notifications.restartNeeded(applicationContext, e.javaClass.simpleName)
            }
        }
        return Result.success()
    }
}
