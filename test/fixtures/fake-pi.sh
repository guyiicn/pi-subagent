#!/usr/bin/env bash
# 假 pi：根据 FAKE_PI_MODE 吐不同 NDJSON
# 模式: success (默认) | no_session | hang | error_exit
set -e
MODE="${FAKE_PI_MODE:-success}"
UUID="${FAKE_PI_UUID:-019f0000-0000-0000-0000-000000000001}"

emit() { printf '%s\n' "$1"; }

if [[ "$MODE" == "no_session" ]]; then
  # 不吐 session 事件，直接退出非零
  echo "pi bootstrap failed" >&2
  exit 3
fi

if [[ "$MODE" == "hang" ]]; then
  emit "{\"type\":\"session\",\"version\":3,\"id\":\"$UUID\",\"cwd\":\"$(pwd)\"}"
  sleep 600  # 卡住，等被 kill
  exit 0
fi

if [[ "$MODE" == "stall" ]]; then
  # 吐 session + 一个 progress，然后长时间不再吐（模拟软卡死）
  emit "{\"type\":\"session\",\"version\":3,\"id\":\"$UUID\",\"cwd\":\"$(pwd)\"}"
  emit "{\"type\":\"tool_execution_end\",\"toolCallId\":\"t1\",\"toolName\":\"bash\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"one_progress\"}]}}"
  sleep 600  # 不再吐任何事件
  exit 0
fi

# success / error_exit / stage_success / stage_success_secondtry 都先吐 session
emit "{\"type\":\"session\",\"version\":3,\"id\":\"$UUID\",\"cwd\":\"$(pwd)\"}"
emit "{\"type\":\"turn_start\",\"timestamp\":1}"
emit "{\"type\":\"tool_execution_end\",\"toolCallId\":\"t1\",\"toolName\":\"bash\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"FAKE_OUTPUT_$UUID\"}]}}"
emit "{\"type\":\"agent_end\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"q\"}]},{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"FAKE_RESULT_$MODE\"}],\"usage\":{\"input\":10,\"output\":5,\"totalTokens\":15,\"cost\":{\"total\":0.001}}}]}"

# stage_success: 写出 outputFile（env FAKE_OUTPUT_FILE 给路径）
if [[ "$MODE" == "stage_success" ]]; then
  OUT="${FAKE_OUTPUT_FILE:-}"
  if [[ -n "$OUT" ]]; then
    printf '<h1>%s</h1>\nchapter content here\n' "$UUID" > "$OUT"
  fi
  exit 0
fi

# stage_success_secondtry: 第一次不写文件（no_output），第二次才写
# 靠 marker 文件判断第几次（第一次跑后写 marker，第二次看到 marker 就写真输出）
if [[ "$MODE" == "stage_success_secondtry" ]]; then
  OUT="${FAKE_OUTPUT_FILE:-}"
  MARKER="${FAKE_OUTPUT_FILE}.marker"
  if [[ -f "$MARKER" ]]; then
    # 第二次：写真输出，清 marker
    if [[ -n "$OUT" ]]; then
      printf '<h1>%s on retry</h1>\n' "$UUID" > "$OUT"
    fi
    rm -f "$MARKER"
  else
    # 第一次：只写 marker，不写输出文件（模拟 no_output 失败）
    touch "$MARKER"
  fi
  exit 0
fi

if [[ "$MODE" == "error_exit" ]]; then
  echo "boom" >&2
  exit 4
fi
exit 0
