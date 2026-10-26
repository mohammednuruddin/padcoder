#!/bin/bash
# Claude Code PermissionRequest hook: shows the request on PadCoder's HUD and waits for
# ✕ (allow), ○ (deny) or △ (leave it to the normal dialog). Prints nothing — so Claude's
# own dialog decides — when PadCoder isn't running, no pad is connected, or time runs out.

DIR="$HOME/Library/Application Support/PadCoder"
input=$(cat)

if [ ! -f "$DIR/active" ] || ! pgrep -xq PadCoder; then
  notifyutil -p com.padcoder.attention
  exit 0
fi

# Whole seconds, rounding a fractional setting up; anything unreadable falls back to 20.
timeout=$(jq -r '(.approvalTimeout // 20) | if type == "number" then ceil else 20 end' "$DIR/config.json" 2>/dev/null)
[[ "$timeout" =~ ^[0-9]+$ ]] && [ "$timeout" -gt 0 ] || timeout=20
id="$(date +%s)-$$"
req="$DIR/requests/$id"
mkdir -p "$DIR/requests"
# If Claude cancels this hook (say the dialog was answered first), take the request off the HUD.
trap 'rm -f "$req.tmp" "$req.json" "$req.decision"' EXIT
trap 'exit 0' TERM INT HUP
printf '%s' "$input" | jq -c --argjson created "$(date +%s)" --argjson timeout "$timeout" --argjson pid "$$" \
  '{tool: .tool_name, input: .tool_input, created: $created, timeout: $timeout, pid: $pid}' > "$req.tmp" || exit 0
mv "$req.tmp" "$req.json"
notifyutil -p com.padcoder.request

decision=""
end=$(( $(date +%s) + timeout ))
while [ "$(date +%s)" -lt "$end" ]; do
  if [ -f "$req.decision" ]; then decision=$(cat "$req.decision"); break; fi
  sleep 0.15
done

case "$decision" in
  allow) echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' ;;
  deny)  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from the controller."}}}' ;;
esac
exit 0
