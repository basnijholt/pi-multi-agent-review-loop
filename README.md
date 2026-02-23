# pi-deep-ralph-review

Deep PR review extension for pi with parallel reviewers and adversarial debate.

Spawns two independent AI reviewers (configurable models), has them review the PR diff in parallel, then runs adversarial debate rounds to reach consensus. The "winning" reviewer (whose points were most agreed upon) writes the final report and optionally fixes issues.

## What it provides

- Command: `/pr-review` — single review+debate cycle (background, non-blocking)
- Command: `/pr-review-loop` — iterative review/fix/review loop until clean
- Live TUI widget showing review progress, debate rounds, and agent status

## Install

### From git

```bash
pi install git:github.com/basnijholt/pi-deep-ralph-review
```

This also installs [pi-subagents](https://github.com/basnijholt/pi-subagents) as a dependency.

### From local path

```bash
pi install ~/repos/pi-deep-ralph-review
```

## Usage

```bash
# Single review cycle
/pr-review

# Iterative review/fix loop
/pr-review-loop
```

Both commands run in the background. The consensus report is sent back to the main session when complete.

## Configuration

| Env var | Description | Default |
|---------|-------------|---------|
| `PR_REVIEW_MODEL_A` | Reviewer A model | `litellm/claude-opus-4-6` |
| `PR_REVIEW_MODEL_B` | Reviewer B model | `openai-codex/gpt-5.3-codex` |
| `PR_REVIEW_THINKING_A` | Thinking level for A | `high` |
| `PR_REVIEW_THINKING_B` | Thinking level for B | `xhigh` |
| `PR_REVIEW_MAX_ROUNDS` | Max debate rounds per cycle | `3` |
| `PR_REVIEW_MAX_CYCLES` | Max review/fix cycles | `5` |

## How it works

1. **Independent reviews**: Two reviewers analyze the PR diff in parallel (no bias)
2. **Adversarial debate**: Reviewers exchange findings and respond point-by-point (Agreed/Partially agreed/Disagreed)
3. **Winner selection**: The reviewer whose points were most agreed upon by the opponent wins
4. **Consensus report**: The winner writes the authoritative consensus with Critical/Warning/Suggestion categories
5. **Fix cycle** (loop mode only): The winner fixes Critical and Warning issues, commits, and a new review cycle starts with fresh reviewers
