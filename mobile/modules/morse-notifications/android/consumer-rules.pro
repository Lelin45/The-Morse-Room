# Expo registers this entry point by name. Manifest components are kept by AGP.
-keep,allowoptimization class com.morsenepal.notifications.MorseNotificationsModule { *; }
# WorkManager recreates workers using their class name and this constructor.
-keepnames class com.morsenepal.notifications.NotificationWorker
-keepclassmembers class com.morsenepal.notifications.NotificationWorker {
  public <init>(android.content.Context, androidx.work.WorkerParameters);
}
