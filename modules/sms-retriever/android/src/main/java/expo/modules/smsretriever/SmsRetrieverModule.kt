package expo.modules.smsretriever

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Registers for the same SMS Retriever broadcast (com.google.android.gms.auth.api.phone.SmsRetriever)
// that WhatsApp's one-tap/zero-tap authentication template autofill uses to deliver the OTP —
// WhatsApp itself triggers this broadcast on-device, it is not a real carrier SMS.
class SmsRetrieverModule : Module() {
  private var receiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("SmsRetriever")

    Events("onSmsReceived", "onSmsTimeout", "onSmsError")

    AsyncFunction("start") { promise: expo.modules.kotlin.Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_NO_CONTEXT", "No React context available", null)
        return@AsyncFunction
      }

      unregisterReceiver(context)

      val task = SmsRetriever.getClient(context).startSmsRetriever()
      task.addOnSuccessListener {
        registerReceiver(context)
        promise.resolve(null)
      }
      task.addOnFailureListener { e ->
        promise.reject("ERR_START_FAILED", e.message ?: "Failed to start SMS retriever", e)
      }
    }

    AsyncFunction("stop") {
      appContext.reactContext?.let { unregisterReceiver(it) }
    }

    OnDestroy {
      appContext.reactContext?.let { unregisterReceiver(it) }
    }
  }

  private fun registerReceiver(context: Context) {
    val filter = IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION)
    val newReceiver = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        if (intent?.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
        val extras = intent.extras ?: return
        val status = extras.get(SmsRetriever.EXTRA_STATUS) as? Status ?: return

        when (status.statusCode) {
          CommonStatusCodes.SUCCESS -> {
            val message = extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE)
            if (message != null) {
              this@SmsRetrieverModule.sendEvent("onSmsReceived", mapOf("message" to message))
            }
          }
          CommonStatusCodes.TIMEOUT -> {
            this@SmsRetrieverModule.sendEvent("onSmsTimeout", mapOf<String, Any>())
          }
          else -> {
            this@SmsRetrieverModule.sendEvent("onSmsError", mapOf("code" to status.statusCode))
          }
        }
        unregisterReceiver(context)
      }
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(newReceiver, filter, Context.RECEIVER_EXPORTED)
    } else {
      context.registerReceiver(newReceiver, filter)
    }
    receiver = newReceiver
  }

  private fun unregisterReceiver(context: Context) {
    val current = receiver ?: return
    try {
      context.unregisterReceiver(current)
    } catch (e: IllegalArgumentException) {
      // already unregistered
    }
    receiver = null
  }
}
