# OkHttp ships its own rules. Keep receiver/service/worker classes referenced from the manifest
# (AGP keeps these automatically) and WorkManager workers instantiated by reflection.
-keep class com.androidsimsms.gateway.WatchdogWorker { <init>(...); }
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
