#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int has_arg(int argc, char **argv, const char *expected) {
  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], expected) == 0) return 1;
  }
  return 0;
}

static void write_file(const char *name, const char *content) {
  FILE *file = fopen(name, "w");
  if (file == NULL) exit(74);
  fputs(content, file);
  if (fclose(file) != 0) exit(74);
}

static int task_tool_available(void) {
  pid_t child = fork();
  if (child < 0) return 0;
  if (child == 0) {
    int null_output = open("/dev/null", O_WRONLY);
    if (null_output >= 0) {
      dup2(null_output, STDOUT_FILENO);
      dup2(null_output, STDERR_FILENO);
      close(null_output);
    }
    execlp("cursor-user-tool", "cursor-user-tool", (char *)NULL);
    _exit(127);
  }
  int status = 0;
  return waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static void result(const char *status, const char *summary) {
  printf("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"{\\\"status\\\":\\\"%s\\\",\\\"summary\\\":\\\"%s\\\"}\"}\n", status, summary);
}

int main(int argc, char **argv) {
  if (has_arg(argc, argv, "--version")) {
    if (argc == 3 && strcmp(argv[1], "--use-system-ca") == 0) puts("v24.5.0");
    else puts("cursor-agent 2026.08.25-3e8eec8");
    return 0;
  }
  if (has_arg(argc, argv, "--help")) {
    puts("Usage: cursor-agent [options]\n--print\n--output-format <format>\n--workspace <path>\n--sandbox <mode>\n--resume <session>\n--force\n--mode <mode>\n--trust");
    return 0;
  }
  if (argc > 1 && strcmp(argv[argc - 1], "status") == 0) {
    puts("Authenticated");
    return 0;
  }

  const char *prompt = argc > 1 ? argv[argc - 1] : "";
  const char *marker = "\"taskId\": \"cursor-";
  const char *start = strstr(prompt, marker);
  char scenario[80] = "malformed";
  if (start != NULL) {
    start += strlen(marker);
    const char *end = strchr(start, '"');
    size_t length = end == NULL ? 0 : (size_t)(end - start);
    if (length > 0 && length < sizeof(scenario)) {
      memcpy(scenario, start, length);
      scenario[length] = '\0';
    }
  }

  if (strcmp(scenario, "process-failure") == 0) {
    fputs("cursor fixture process failed\n", stderr);
    return 7;
  }

  const int correction = strstr(prompt, "authorized correction") != NULL;
  const char *session = strcmp(scenario, "session-drift") == 0 && correction
    ? "different-cursor-session"
    : "fixture-cursor-session";
  if (strcmp(scenario, "model-unavailable") == 0) {
    printf("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"%s\"}\n", session);
  } else {
    const char *model = strcmp(scenario, "model-auto") == 0 ? "Auto" : "fixture-cursor-model";
    printf("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"%s\",\"model\":\"%s\"}\n", session, model);
  }

  if (strcmp(scenario, "hang") == 0) {
    for (;;) sleep(1);
  } else if (strcmp(scenario, "breach") == 0) {
    write_file("allowed.txt", "delegated cursor edit\n");
    write_file("private.txt", "out of scope\n");
    result("completed", "Cursor reported completion.");
  } else if (strcmp(scenario, "git-control") == 0) {
    write_file("allowed.txt", "delegated cursor edit\n");
    write_file(".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
    result("completed", "Cursor reported completion.");
  } else if (strcmp(scenario, "environment") == 0) {
    int isolated = getenv("HOST_SECRET") == NULL && getenv("HOME") != NULL;
    if (isolated) write_file("allowed.txt", "delegated cursor edit\n");
    result(isolated ? "completed" : "failed", isolated ? "Environment minimized." : "Ambient environment exposed.");
  } else if (strcmp(scenario, "path-tool") == 0) {
    int available = task_tool_available();
    if (available) write_file("allowed.txt", "delegated cursor edit\n");
    result(available ? "completed" : "failed", available ? "Task tool PATH preserved." : "Task tool PATH unavailable.");
  } else if (strcmp(scenario, "launch-profile") == 0) {
    const char *invoked_as = strrchr(argv[0], '/');
    invoked_as = invoked_as == NULL ? argv[0] : invoked_as + 1;
    int bounded = strcmp(invoked_as, "cursor-agent") == 0 &&
      getenv("CURSOR_INVOKED_AS") != NULL && strcmp(getenv("CURSOR_INVOKED_AS"), "cursor-agent") == 0 &&
      has_arg(argc, argv, "--use-system-ca");
    if (bounded) write_file("allowed.txt", "delegated cursor edit\n");
    result(bounded ? "completed" : "failed", bounded ? "Direct launch profile preserved." : "Direct launch profile drifted.");
  } else if (strcmp(scenario, "read-only") == 0) {
    int bounded = has_arg(argc, argv, "--mode") && has_arg(argc, argv, "plan") && !has_arg(argc, argv, "--force");
    result(bounded ? "completed" : "failed", bounded ? "Read-only mode preserved." : "Read-only mode was not preserved.");
  } else if (strcmp(scenario, "blocked") == 0) {
    result("blocked", "Host authority is required.");
  } else if (strcmp(scenario, "terminal-failure") == 0) {
    puts("{\"type\":\"result\",\"subtype\":\"error\",\"is_error\":true,\"result\":\"failed\"}");
  } else if (strcmp(scenario, "duplicate-terminal") == 0) {
    result("completed", "Duplicate.");
    result("completed", "Duplicate.");
  } else if (strcmp(scenario, "malformed") == 0) {
    puts("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"not structured\"}");
  } else if (strcmp(scenario, "formatted-result") == 0) {
    puts("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"Review complete.\\n```json\\n{\\n  \\\"status\\\": \\\"completed\\\",\\n  \\\"summary\\\": \\\"Formatted structured result.\\\"\\n}\\n```\"}");
  } else if (strcmp(scenario, "conflicting-formatted-result") == 0) {
    puts("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"{\\\"status\\\":\\\"completed\\\",\\\"summary\\\":\\\"First.\\\"}\\n{\\\"status\\\":\\\"failed\\\",\\\"summary\\\":\\\"Second.\\\"}\"}");
  } else if (strcmp(scenario, "resume") == 0) {
    int resumed = has_arg(argc, argv, "--resume=fixture-cursor-session");
    if (resumed) write_file("allowed.txt", "resumed cursor edit\n");
    result(resumed ? "completed" : "failed", resumed ? "Resumed." : "Resume missing.");
  } else if (strcmp(scenario, "lifecycle") == 0 || strcmp(scenario, "session-drift") == 0) {
    int resumed = correction && has_arg(argc, argv, "--resume=fixture-cursor-session");
    write_file("allowed.txt", resumed ? "corrected cursor lifecycle edit\n" : "initial cursor lifecycle edit\n");
    result("completed", resumed ? "Correction completed." : "Initial lifecycle execution completed.");
  } else {
    write_file("allowed.txt", "delegated cursor edit\n");
    result("completed", "Bounded Cursor edit completed.");
  }
  return 0;
}
