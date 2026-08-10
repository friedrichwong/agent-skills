# Agent Skills

This repository contains the Agent Skills I use and maintain.

## Skills

### `teach`

This skill is based on Matt Pocock's [`teach`](https://github.com/mattpocock/skills/tree/main/skills/productivity/teach), which is released under the MIT License.

It extends the original multi-session teaching workspace with stricter requirements:

- Create and continuously update a dynamic learning map.
- Dynamically select the next learning unit based on goals, prerequisites, and mastery evidence.
- Track progress through explicit state transitions.
- Mark a unit as mastered only after independent completion, transfer, or delayed-recall evidence.
- Explicitly record resource coverage, skipped topics, gaps, and uncertainties.

The original author's MIT License is preserved in [`teach/LICENSE`](teach/LICENSE).

### `guide-learning`

This is a guided-learning skill built for my own use. Unlike `teach`, which provides a complete multi-session teaching workspace, `guide-learning` is simpler and more direct. It selects the smallest effective explanation, exercise, feedback, and verification step based on the learner's goal and current bottleneck, without requiring a full course workspace.

### `nlm-skill`

An expert guide for the NotebookLM CLI (`nlm`). It covers notebook and source management, research, Studio content generation, batch workflows, prompting patterns, and troubleshooting.

## License

Except for separately identified third-party derivative work, this repository is available under the [MIT License](LICENSE).
