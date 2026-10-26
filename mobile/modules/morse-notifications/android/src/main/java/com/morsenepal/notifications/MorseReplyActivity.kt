package com.morsenepal.notifications

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.max
import kotlin.math.min

/** A small, native reply window. No React runtime, WebView, notification IPC or disk work per key. */
class MorseReplyActivity : Activity() {
  private val handler = Handler(Looper.getMainLooper())
  private var messageId = ""
  private var accountEpoch = 0L
  private var subscription: AutoCloseable? = null
  private var current: NotificationReplySession.Snapshot? = null
  private var rendering = false
  private var modeApplied = false
  private var shownMode: String? = null
  private var lastWidth = 0
  private var lastHeight = 0
  private var keyboardVisible = false
  private var dark = true
  private var finishScheduled = false
  private var backspaceHeld = false
  private var suppressClick = false
  private var caretPosted = false
  private var pendingCaret: EditText? = null
  private var keyboardRequested = false

  private lateinit var panel: LinearLayout
  private lateinit var title: TextView
  private lateinit var incoming: TextView
  private lateinit var status: TextView
  private lateinit var count: TextView
  private lateinit var hint: TextView
  private lateinit var textEditor: EditText
  private lateinit var morseEditor: EditText
  private lateinit var textMode: Button
  private lateinit var morseMode: Button
  private lateinit var paddles: LinearLayout
  private lateinit var composer: LinearLayout
  private lateinit var footer: LinearLayout
  private lateinit var draftScroll: ScrollView
  private lateinit var dit: Button
  private lateinit var dah: Button
  private lateinit var space: Button
  private lateinit var backspace: Button
  private lateinit var send: Button

  private val foreground: Int get() = Color.parseColor(if (dark) "#d5f8df" else "#123226")
  private val muted: Int get() = Color.parseColor(if (dark) "#99bba4" else "#587163")
  private val accent: Int get() = Color.parseColor(if (dark) "#34f58c" else "#217044")
  private val surface: Int get() = Color.parseColor(if (dark) "#08130d" else "#ffffff")
  private val border: Int get() = Color.parseColor(if (dark) "#284b36" else "#d5dfd6")

  private val securityCheck = object : Runnable {
    override fun run() {
      if (isFinishing || isDestroyed) return
      if (NotificationStore.accountEpoch.get() != accountEpoch || !MorseNotifications.unlocked(this@MorseReplyActivity)) {
        // Do not leave another account's plaintext visible when the screen locks or sign-in changes.
        rendering = true
        try { textEditor.setText(""); morseEditor.setText("") } finally { rendering = false }
        finish()
        return
      }
      handler.postDelayed(this, 400L)
    }
  }

  private val repeatBackspace = object : Runnable {
    override fun run() {
      if (!backspaceHeld || current?.sending != false) return
      NotificationReplySession.backspace(messageId, SystemClock.elapsedRealtime())
      handler.postDelayed(this, 55L)
    }
  }

  private val visibleLayout = ViewTreeObserver.OnGlobalLayoutListener { resizeWindow() }

  /** At most one caret scroll per display frame, always using the newest draft position. */
  private val caretFrame = Runnable {
    caretPosted = false
    val editor = pendingCaret
    pendingCaret = null
    if (editor != null && !isFinishing && !isDestroyed && editor.visibility == View.VISIBLE) {
      val position = editor.selectionEnd.coerceIn(0, editor.length())
      editor.bringPointIntoView(position)
      editor.layout?.let { layout ->
        val line = layout.getLineForOffset(position)
        val top = layout.getLineTop(line) + editor.totalPaddingTop
        val bottom = layout.getLineBottom(line) + editor.totalPaddingTop
        editor.requestRectangleOnScreen(Rect(0, top, editor.width, bottom), true)
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    val preference = getSharedPreferences("morse_reply_preferences", Context.MODE_PRIVATE).getString("theme", null)
    dark = when (preference) {
      "dark" -> true
      "light" -> false
      else -> (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }
    setTheme(if (dark) R.style.MorseReplyDialog_Dark else R.style.MorseReplyDialog_Light)
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    val initialKeyboard = if (intent.getStringExtra("mode") == "morse")
      WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN else WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or initialKeyboard)
    window.setGravity(Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
    // ADJUST_RESIZE docks the window above the IME. Do not add the IME inset or a second bottom gap.
    window.attributes = window.attributes.apply { y = 0 }
    setFinishOnTouchOutside(true)
    setContentView(R.layout.morse_reply_activity)
    bindViews()
    applyPalette()
    messageId = savedInstanceState?.getString("replyMessageId") ?: intent.getStringExtra("messageId").orEmpty()
    modeApplied = savedInstanceState?.getBoolean("replyModeApplied", false) ?: false
    if (messageId.isBlank()) { finish(); return }
    wireInput()
    panel.viewTreeObserver.addOnGlobalLayoutListener(visibleLayout)
    ViewCompat.setOnApplyWindowInsetsListener(panel) { _, insets ->
      keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
      if (keyboardVisible) keyboardRequested = false
      resizeWindow(insets)
      insets
    }
    panel.post { resizeWindow(); ViewCompat.requestApplyInsets(panel) }
  }

  override fun onStart() {
    super.onStart()
    if (!isFinishing) openSession()
  }

  override fun onResume() {
    super.onResume()
    if (isFinishing) return
    if (!MorseNotifications.unlocked(this) || NotificationStore.accountEpoch.get() != accountEpoch) { finish(); return }
    NotificationReplySession.open(this, messageId)?.let(::render) ?: run { finish(); return }
    if (current?.mode == "text" && current?.sending == false && current?.sent == false) requestTextKeyboard()
    handler.removeCallbacks(securityCheck)
    handler.post(securityCheck)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    closeSession()
    setIntent(intent)
    messageId = intent.getStringExtra("messageId").orEmpty()
    modeApplied = false
    shownMode = null
    finishScheduled = false
    if (messageId.isBlank()) { finish(); return }
    openSession()
  }

  override fun onStop() {
    stopRepeating()
    cancelCaretScroll()
    handler.removeCallbacks(securityCheck)
    keyboardRequested = false
    hideKeyboard()
    closeSession()
    super.onStop()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus && keyboardRequested) showRequestedKeyboard()
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    cancelCaretScroll()
    if (::panel.isInitialized && panel.viewTreeObserver.isAlive) panel.viewTreeObserver.removeOnGlobalLayoutListener(visibleLayout)
    super.onDestroy()
  }

  override fun onSaveInstanceState(outState: Bundle) {
    // Editable drafts are encrypted by the session. Never put message contents in Activity saved state.
    outState.putString("replyMessageId", messageId)
    outState.putBoolean("replyModeApplied", modeApplied)
    super.onSaveInstanceState(outState)
  }

  private fun openSession() {
    if (!MorseNotifications.unlocked(this)) { finish(); return }
    val expectedUser = intent.getStringExtra("userId")
    if (expectedUser != null && NotificationStore.read(this, "credentials")?.optString("userId") != expectedUser) { finish(); return }
    NotificationReplySession.open(this, messageId) ?: run { finish(); return }
    accountEpoch = NotificationStore.accountEpoch.get()
    subscription?.close()
    if (!modeApplied) {
      modeApplied = true
      // Normal Reply always opens text, converting any retained Morse draft instead of discarding it.
      val mode = intent.getStringExtra("mode")?.takeIf { it == "text" || it == "morse" } ?: "text"
      NotificationReplySession.switchMode(messageId, mode)
    }
    subscription = NotificationReplySession.listen(messageId) { value ->
      if (value == null) finish() else if (!isFinishing) render(value)
    }
  }

  private fun closeSession() {
    subscription?.close()
    subscription = null
    if (messageId.isNotBlank()) NotificationReplySession.close(messageId)
  }

  private fun bindViews() {
    panel = findViewById(R.id.quick_reply_panel)
    title = findViewById(R.id.quick_reply_title)
    incoming = findViewById(R.id.quick_reply_incoming)
    status = findViewById(R.id.quick_reply_status)
    count = findViewById(R.id.quick_reply_count)
    hint = findViewById(R.id.quick_reply_hint)
    textEditor = findViewById(R.id.quick_reply_text)
    morseEditor = findViewById(R.id.quick_reply_morse)
    textMode = findViewById(R.id.quick_reply_mode_text)
    morseMode = findViewById(R.id.quick_reply_mode_morse)
    paddles = findViewById(R.id.quick_reply_paddles)
    composer = findViewById(R.id.quick_reply_composer)
    footer = findViewById(R.id.quick_reply_footer)
    draftScroll = findViewById(R.id.quick_reply_scroll)
    dit = findViewById(R.id.quick_reply_dit)
    dah = findViewById(R.id.quick_reply_dah)
    space = findViewById(R.id.quick_reply_space)
    backspace = findViewById(R.id.quick_reply_backspace)
    send = findViewById(R.id.quick_reply_send)
    morseEditor.keyListener = null
    morseEditor.showSoftInputOnFocus = false
    morseEditor.setSingleLine(false)
    morseEditor.setHorizontallyScrolling(false)
    morseEditor.setRawInputType(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE)
    morseEditor.isCursorVisible = true
    morseEditor.typeface = Typeface.MONOSPACE
    // Redundant with XML intentionally: Android must never save either private draft in view state.
    textEditor.isSaveEnabled = false
    morseEditor.isSaveEnabled = false
  }

  private fun wireInput() {
    findViewById<ImageButton>(R.id.quick_reply_close).setOnClickListener { finish() }
    textMode.setOnClickListener { stopRepeating(); NotificationReplySession.switchMode(messageId, "text") }
    morseMode.setOnClickListener { stopRepeating(); NotificationReplySession.switchMode(messageId, "morse") }
    textEditor.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) {
        if (!rendering && current?.mode == "text") {
          NotificationReplySession.editText(messageId, value?.toString().orEmpty())
          revealCaret(textEditor)
        }
      }
      override fun afterTextChanged(value: Editable?) = Unit
    })
    // Accept marks on touch-down. Input does not wait for sound, finger release, a service or notification redraw.
    immediateButton(dit) { timestamp -> NotificationReplySession.mark(messageId, '.', timestamp) }
    immediateButton(dah) { timestamp -> NotificationReplySession.mark(messageId, '-', timestamp) }
    immediateButton(space) { NotificationReplySession.space(messageId) }
    immediateButton(backspace, repeating = true) { timestamp -> NotificationReplySession.backspace(messageId, timestamp) }
    send.setOnClickListener {
      stopRepeating()
      hideKeyboard()
      NotificationReplySession.send(messageId)
    }
  }

  private fun immediateButton(button: Button, repeating: Boolean = false, action: (Long) -> Unit) {
    button.setOnClickListener {
      if (!suppressClick && button.isEnabled) action(SystemClock.elapsedRealtime())
    }
    button.setOnTouchListener { view, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          if (!view.isEnabled) return@setOnTouchListener false
          view.isPressed = true
          // MotionEvent uses uptime; translate to the elapsed clock used by the draft timing model.
          // This preserves the actual tap interval even if a long transcript occupied the prior frame.
          action(SystemClock.elapsedRealtime() - SystemClock.uptimeMillis() + event.eventTime)
          view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
          if (repeating) {
            stopRepeating()
            backspaceHeld = true
            handler.postDelayed(repeatBackspace, 350L)
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          if (repeating) stopRepeating()
          view.isPressed = false
          suppressClick = true
          try { view.performClick() } finally { suppressClick = false }
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          if (repeating) stopRepeating()
          view.isPressed = false
          true
        }
        MotionEvent.ACTION_MOVE -> true
        else -> false
      }
    }
  }

  private fun stopRepeating() {
    backspaceHeld = false
    handler.removeCallbacks(repeatBackspace)
    if (::backspace.isInitialized) backspace.isPressed = false
  }

  private fun render(snapshot: NotificationReplySession.Snapshot) {
    if (snapshot.messageId != messageId || isFinishing) return
    current = snapshot
    if (!snapshot.sent) finishScheduled = false
    if (!TextUtils.equals(title.text, snapshot.title)) title.text = snapshot.title
    val received = snapshot.incomingMorse.ifBlank { snapshot.incomingText }
    if (!TextUtils.equals(incoming.text, received)) incoming.text = received
    val morse = snapshot.mode == "morse"
    val changedMode = shownMode != snapshot.mode
    shownMode = snapshot.mode
    rendering = true
    try {
      if (!morse && !TextUtils.equals(textEditor.text, snapshot.draftText)) {
        val caret = if (textEditor.hasFocus() && !changedMode) textEditor.selectionStart.coerceAtLeast(0) else snapshot.draftText.length
        updateEditor(textEditor, snapshot.draftText, changedMode)
        textEditor.setSelection(min(caret, textEditor.length()))
      }
      if (morse && !TextUtils.equals(morseEditor.text, snapshot.draftMorse)) {
        updateEditor(morseEditor, snapshot.draftMorse, changedMode)
        morseEditor.setSelection(morseEditor.length())
        revealCaret(morseEditor)
      }
    } finally { rendering = false }
    textEditor.visibility = if (morse) View.GONE else View.VISIBLE
    morseEditor.visibility = if (morse) View.VISIBLE else View.GONE
    paddles.visibility = if (morse) View.VISIBLE else View.GONE
    footer.visibility = if (morse) View.VISIBLE else View.GONE
    backspace.visibility = if (morse) View.VISIBLE else View.GONE
    val instructions = if (morse) "Pause for letters. Space for words." else ""
    if (!TextUtils.equals(hint.text, instructions)) hint.text = instructions
    if (!TextUtils.equals(status.text, snapshot.status)) status.text = snapshot.status
    status.visibility = if (snapshot.status.isBlank()) View.GONE else View.VISIBLE
    val counter = if (morse) "${snapshot.draftMorse.length} / 6,000" else "${snapshot.draftText.length} / 1,000"
    if (!TextUtils.equals(count.text, counter)) count.text = counter
    val enabled = !snapshot.sending && !snapshot.sent
    if (!enabled) stopRepeating()
    for (button in listOf(textMode, morseMode, dit, dah, space, backspace)) {
      button.isEnabled = enabled
      button.alpha = if (enabled) 1f else .5f
    }
    textEditor.isEnabled = enabled
    send.isEnabled = enabled && (if (morse) snapshot.draftMorse.isNotBlank() else snapshot.draftText.isNotBlank())
    send.alpha = if (send.isEnabled) 1f else .55f
    val sendLabel = if (snapshot.sent) "Sent" else "Send"
    if (!TextUtils.equals(send.text, sendLabel)) send.text = sendLabel
    val sendDescription = if (snapshot.sending) "Sending reply" else sendLabel
    if (!TextUtils.equals(send.contentDescription, sendDescription)) send.contentDescription = sendDescription
    if (changedMode) {
      styleMode(textMode, !morse)
      styleMode(morseMode, morse)
      if (morse) {
        keyboardRequested = false
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        hideKeyboard()
        textEditor.clearFocus()
        morseEditor.requestFocus()
        revealCaret(morseEditor)
      } else {
        textEditor.setSelection(textEditor.length())
        requestTextKeyboard()
      }
      resizeWindow()
    }
    if (snapshot.sent && !finishScheduled) {
      finishScheduled = true
      handler.postDelayed({ if (!isFinishing && current?.sent == true) finish() }, 1_000L)
    }
  }

  private fun revealCaret(editor: EditText) {
    pendingCaret = editor
    if (caretPosted) return
    caretPosted = true
    panel.postOnAnimation(caretFrame)
  }

  private fun cancelCaretScroll() {
    if (::panel.isInitialized) panel.removeCallbacks(caretFrame)
    caretPosted = false
    pendingCaret = null
  }

  private fun updateEditor(editor: EditText, value: String, replaceAll: Boolean) {
    if (replaceAll) { editor.setText(value); return }
    val editable = editor.text
    val oldLength = editable.length
    val sharedLength = min(oldLength, value.length)
    var prefix = 0
    while (prefix < sharedLength && editable[prefix] == value[prefix]) prefix++
    when {
      // Keeping the Editable preserves Android's incremental layout instead of relaying out 6,000 symbols.
      prefix == oldLength -> editable.append(value, oldLength, value.length)
      prefix == value.length -> editable.delete(value.length, oldLength)
      else -> editor.setText(value) // Conversion, restore or an edit somewhere other than the end.
    }
  }

  private fun hideKeyboard() {
    if (::panel.isInitialized) (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(panel.windowToken, 0)
  }

  private fun requestTextKeyboard() {
    if (!::textEditor.isInitialized || current?.mode != "text" || current?.sending != false || current?.sent != false) return
    keyboardRequested = true
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
    textEditor.requestFocus()
    textEditor.post { showRequestedKeyboard() }
  }

  private fun showRequestedKeyboard() {
    if (!keyboardRequested || isFinishing || isDestroyed || !hasWindowFocus() || current?.mode != "text" || current?.sending != false || current?.sent != false) return
    textEditor.requestFocus()
    (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(textEditor, InputMethodManager.SHOW_IMPLICIT)
    ViewCompat.getWindowInsetsController(textEditor)?.show(WindowInsetsCompat.Type.ime())
    revealCaret(textEditor)
  }

  private fun resizeWindow(insets: WindowInsetsCompat? = null) {
    if (!::panel.isInitialized || isFinishing) return
    val metrics = resources.displayMetrics
    val rootInsets = insets ?: ViewCompat.getRootWindowInsets(panel)
    val bars = rootInsets?.getInsets(WindowInsetsCompat.Type.systemBars())
    val ime = rootInsets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
    val frame = Rect()
    panel.getWindowVisibleDisplayFrame(frame)
    val obscured = (metrics.heightPixels - frame.bottom).coerceAtLeast(0)
    val inferredIme = if (obscured > metrics.heightPixels / 5) obscured else 0
    val keyboard = max(ime, inferredIme)
    keyboardVisible = rootInsets?.isVisible(WindowInsetsCompat.Type.ime()) == true || keyboard > 0
    val available = (metrics.heightPixels - (bars?.top ?: dp(24)) - max(keyboard, bars?.bottom ?: 0) - dp(8)).coerceAtLeast(1)
    val width = min(dp(560), metrics.widthPixels - dp(24))
    incoming.visibility = if (keyboardVisible || available < dp(390)) View.GONE else View.VISIBLE
    // Measure the actual chrome and draft, rather than reserving a 530dp text window. The scroll
    // child keeps its full editable layout, while only its viewport is capped for long messages.
    val widthSpec = View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY)
    panel.measure(widthSpec, View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    val chrome = (panel.measuredHeight - composer.measuredHeight).coerceAtLeast(0)
    val editor = if (current?.mode == "morse") morseEditor else textEditor
    val viewport = min(editor.measuredHeight, (available - chrome).coerceAtLeast(1)).coerceAtLeast(1)
    if (draftScroll.layoutParams.height != viewport) {
      draftScroll.layoutParams = draftScroll.layoutParams.apply { height = viewport }
      panel.measure(widthSpec, View.MeasureSpec.makeMeasureSpec(available, View.MeasureSpec.AT_MOST))
    }
    val height = min(panel.measuredHeight, available)
    if (width != lastWidth || height != lastHeight) {
      lastWidth = width
      lastHeight = height
      window.setLayout(width, height)
      if (current?.mode == "text") revealCaret(textEditor)
    }
  }

  private fun applyPalette() {
    panel.background = shape(Color.parseColor(if (dark) "#000000" else "#f7f6f2"), 20f, border)
    for (view in listOf(title, textEditor, morseEditor)) view.setTextColor(foreground)
    for (view in listOf(findViewById<TextView>(R.id.quick_reply_heading), incoming, status, count, hint)) view.setTextColor(muted)
    findViewById<ImageButton>(R.id.quick_reply_close).imageTintList = ColorStateList.valueOf(foreground)
    incoming.background = shape(surface, 10f)
    findViewById<View>(R.id.quick_reply_modes).background = shape(surface, 12f, border)
    for (editor in listOf(textEditor, morseEditor)) {
      editor.setHintTextColor(muted)
      editor.backgroundTintList = null
      editor.background = shape(surface, 12f, border)
    }
    for (button in listOf(dit, dah, space, backspace)) {
      button.backgroundTintList = null
      button.background = ripple(surface, if (button == dit || button == dah) 38f else 12f, border)
      button.setTextColor(foreground)
      button.stateListAnimator = null
    }
    // These three glyphs are icons; keep them inside their touch targets as body text scales up.
    dit.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 36f)
    dah.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 32f)
    backspace.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 24f)
    send.backgroundTintList = null
    send.background = ripple(accent, 24f)
    send.setTextColor(Color.parseColor(if (dark) "#002b13" else "#ffffff"))
    send.stateListAnimator = null
  }

  private fun styleMode(button: Button, selected: Boolean) {
    button.backgroundTintList = null
    button.background = ripple(if (selected) accent else Color.TRANSPARENT, 9f)
    button.setTextColor(if (selected) Color.parseColor(if (dark) "#002b13" else "#ffffff") else muted)
    button.isSelected = selected
    button.stateListAnimator = null
  }

  private fun shape(color: Int, radius: Float, stroke: Int? = null): GradientDrawable = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radius).toFloat()
    if (stroke != null) setStroke(dp(1), stroke)
  }

  private fun ripple(color: Int, radius: Float, stroke: Int? = null): RippleDrawable = RippleDrawable(
    ColorStateList.valueOf(if (dark) 0x2234f58c else 0x22217044), shape(color, radius, stroke), shape(Color.WHITE, radius)
  )

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density + .5f).toInt()
  private fun dp(value: Float): Int = (value * resources.displayMetrics.density + .5f).toInt()
}
