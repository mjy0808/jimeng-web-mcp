## Context

Film Studio stores the movie's intended output resolution in the creative brief. Seedance 2.5 Draft generation always produces 480p, and the provider's final render uses the original Draft history and result item.

## Decisions

- Keep the brief resolution as the final target. Store each request's actual resolution separately in prompt and operation settings.
- Promote only an approved production unit whose selected Takes all came from the same original Draft operation. A changed unit must be reviewed and generated again.
- Create and persist a new operation and submission ID before calling the paid finalization endpoint. After an uncertain submission, query that ID; do not submit again.
- Use the provider's Draft finalization process with the original history and item IDs. Reject unsupported live model configuration before submission instead of falling back to standard text generation.
- Import the final result as new Takes. For a shared video, confirm split points again. Selecting a final Take invalidates dependent cuts while preserving the original sample.

## Risks

- JiMeng Web's private request schema may change. The adapter checks the live model configuration and original Draft metadata, and fails before paid submission when either is incompatible. A live logged-in finalization still needs validation against the provider.
