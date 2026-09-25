# Add per-unit Seedance Draft promotion

## Why

Film Studio currently treats the 480p sample resolution as the film's target resolution. A film targeting 1080p must still be able to review low-cost Drafts and choose which approved video production units to finalize.

## What changes

- Keep the film's output resolution independent of the sample generation resolution. Seedance 2.5 Draft submissions always request 480p.
- Add `production_promote`, which reads the exact completed Draft history and item, checks the live model configuration, and submits a GenerateFromDraft operation at the requested final resolution. It never uses the prompt as a new standard generation.
- Store a separate recoverable promotion operation for the selected production unit. Import its result as new reviewable Takes, retaining the approved sample Takes until the user selects the final result.

## Validation

Offline request tests, Film Studio workflow tests, type checks, UI build, and strict OpenSpec validation. No live generation is performed by tests.
