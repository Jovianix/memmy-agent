# Shared native task recording primitives

These Host-owned drivers provide owner-scoped task recordings, media, evidence and
resource cleanup to approved native plugins. They share the collector gate with
Computer History. Conversation event capture uses the existing History stream and
its own durable snapshots; it does not start a second video recorder.

The Windows task recorder is built from `computer-history/win/native` by
`scripts/internal/win/build-plugin-native-recorder.mjs` during Windows packaging.
Its runtime requires no system Node or compiler. Teaching orchestration, prompts,
application adapters and dedicated acceptance tools belong to the plugin repository.
