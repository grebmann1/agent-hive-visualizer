#!/bin/bash
# AgentQuest hook relay.
#
# Claude Code hooks invoke this script with the event's JSON payload on
# stdin. We forward that payload to the local AgentQuest HTTP server so
# the app can show the event in real-time. If AgentQuest isn't running,
# the post silently fails (because curl's short --max-time expires and
# claude never notices).
#
# The script also tags the payload with AGENTQUEST_TERMINAL_ID (if set)
# so AgentQuest can correlate events back to specific embedded terminals.
#
# Port is baked in at install time via sed-substitution on __PORT__.

set -u

INPUT=$(cat)
TERMINAL_ID="${AGENTQUEST_TERMINAL_ID:-}"

# Splice the terminal id into the JSON as a top-level key. Avoids jq
# dependency; the substitution on the opening brace preserves the rest of
# the payload byte-for-byte.
if [ -n "$TERMINAL_ID" ]; then
  INPUT=$(printf '%s' "$INPUT" | sed "s#^{#{\"agentquest_terminal_id\":\"$TERMINAL_ID\",#")
fi

# Fire-and-forget POST. Background so claude doesn't wait on us.
(
  curl -sf --max-time 0.4 -X POST "http://127.0.0.1:__PORT__/hook" \
    -H "Content-Type: application/json" \
    --data-binary "$INPUT" \
    >/dev/null 2>&1
) &

exit 0
