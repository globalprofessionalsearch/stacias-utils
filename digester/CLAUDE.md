# Claude Code Context

Before working on this project, read:

- **[PRODUCT_BRIEF.md](PRODUCT_BRIEF.md)** — what digester is, how it works, commands, configuration, and known gaps
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — core abstractions, the source protocol boundary, pipeline design, and LLM usage philosophy

The architecture document defines the rules that govern how sources, the pipeline, and state relate to each other. The protocol boundary section is especially important — domain-specific knowledge must not leak across it.
